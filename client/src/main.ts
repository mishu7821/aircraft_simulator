import "./style.css";

import * as THREE from "three";
import { io, type Socket } from "socket.io-client";

import {
  AIRCRAFT_PROFILES,
  FIRE_INTERVAL_MS,
  MISSILE_INTERVAL_MS,
  type AircraftClass,
  type BotDifficulty,
  type Team,
  clamp,
  copyVec3,
  createAircraftState,
  dotVec3,
  forwardFromRotation,
  lerp,
  scaleVec3,
  simulateAircraft
} from "../../shared/game";
import type { AircraftState, ControlState, SnapshotPlayer, Vec3 } from "../../shared/game";
import type {
  ClientToServerEvents,
  DamageEvent,
  DeathEvent,
  FireEvent,
  MissileEvent,
  RoomStatePayload,
  ServerToClientEvents
} from "../../shared/protocol";

type AircraftVisual = {
  id: string;
  name: string;
  group: THREE.Group;
  contrail: THREE.Line;
  history: THREE.Vector3[];
  current: AircraftState;
  target: AircraftState;
};

type Tracer = {
  line: THREE.Line;
  life: number;
};

type FeedItem = {
  text: string;
  life: number;
};

type DestroyedEffectSprite = {
  sprite: THREE.Sprite;
  velocity: THREE.Vector3;
  life: number;
  age: number;
  baseScale: number;
  spin: number;
  drift: number;
};

type DestroyedAircraftEffect = {
  ownerId: string;
  group: THREE.Group;
  flash: THREE.Mesh;
  shockwave: THREE.Mesh;
  smokeSprites: DestroyedEffectSprite[];
  fireSprites: DestroyedEffectSprite[];
  emberSprites: DestroyedEffectSprite[];
  age: number;
  duration: number;
};

type CombatantMeta = {
  team: Team;
  isBot: boolean;
  aircraftClass: AircraftClass;
};

type TargetAssistInfo = {
  id: string;
  name: string;
  isBot: boolean;
  distance: number;
  aimDot: number;
  missileLocked: boolean;
  screenX: number;
  screenY: number;
  onScreen: boolean;
};

type CloudLayer = {
  group: THREE.Group;
  material: THREE.MeshStandardMaterial;
  drift: number;
  sway: number;
  baseY: number;
};

type SkyAmbientKind = "parachute" | "balloon" | "bird" | "plane" | "heli";

type SkyAmbientObject = {
  group: THREE.Group;
  kind: SkyAmbientKind;
  orbitRadius: number;
  orbitSpeed: number;
  angle: number;
  baseY: number;
  bobAmp: number;
  bobSpeed: number;
  contrailTimer?: number;
  contrailInterval?: number;
};

type WorldObjects = {
  skyDome: THREE.Mesh;
  skyMaterial: THREE.MeshBasicMaterial;
  ambient: THREE.AmbientLight;
  hemisphere: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  sunGlow: THREE.Mesh;
  ground: THREE.Mesh;
  grid: THREE.GridHelper;
  runway: THREE.Mesh;
  water: THREE.Mesh;
  mountainMeshes: THREE.Mesh[];
  treeMeshes: THREE.Mesh[];
  cloudLayers: CloudLayer[];
  skyAmbientObjects: SkyAmbientObject[];
};

type WeatherPreset = {
  label: string;
  background: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  skyTop: string;
  skyHorizon: string;
  skyBottom: string;
  ambientIntensity: number;
  ambientColor: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sunColor: number;
  sunIntensity: number;
  sunPosition: [number, number, number];
  sunGlowColor: number;
  groundColor: number;
  waterColor: number;
  mountainColor: number;
  treeColor: number;
  gridCenter: number;
  gridEdge: number;
  runwayColor: number;
  cloudColor: number;
  cloudOpacity: number;
  cloudCount: number;
};

type WeatherPresetName = "clear" | "cloudy" | "sunset" | "stormy" | "foggy";
type InputMode = "keyboard" | "gamepad" | "touch";
type EngineAudio = {
  baseOscillator: OscillatorNode;
  harmonicOscillator: OscillatorNode;
  lfoOscillator: OscillatorNode;
  noiseSource: AudioBufferSourceNode;
  toneFilter: BiquadFilterNode;
  noiseFilter: BiquadFilterNode;
  toneGain: GainNode;
  noiseGain: GainNode;
  lfoGain: GainNode;
  masterGain: GainNode;
};

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? deriveServerUrl();
const SEND_CONTROLS_MS = 50;
const REMOTE_LERP = 7;
const MAX_DEATHS_BEFORE_RESET = 5;
const WEATHER_ORDER: WeatherPresetName[] = ["clear", "cloudy", "sunset", "stormy", "foggy"];
const CLIENT_MISSILE_LOCK_DOT = 0.05;
const CLIENT_MISSILE_BACKSIDE_DOT = 0.65;
const TARGET_INDICATOR_MARGIN_PX = 36;
const MIN_THROTTLE = 0.15;
const DESTROYED_EFFECT_DURATION = 5.4;
const DESTROYED_EFFECT_FIRE_DURATION = 3.7;
const DESTROYED_EFFECT_SMOKE_DURATION = 4.8;

const WEATHER_PRESETS: Record<WeatherPresetName, WeatherPreset> = {
  clear: {
    label: "Clear Blue",
    background: 0x8fd3ff,
    fogColor: 0xaedcff,
    fogNear: 550,
    fogFar: 2600,
    skyTop: "#67b8ff",
    skyHorizon: "#d9f0ff",
    skyBottom: "#f8fbff",
    ambientIntensity: 0.85,
    ambientColor: 0xf9fdff,
    hemiSky: 0xa6d8ff,
    hemiGround: 0x7aa06c,
    hemiIntensity: 0.95,
    sunColor: 0xfff2c9,
    sunIntensity: 1.8,
    sunPosition: [260, 360, -140],
    sunGlowColor: 0xfff7c2,
    groundColor: 0x78b46a,
    waterColor: 0x62b7de,
    mountainColor: 0x74899d,
    treeColor: 0x3f6e35,
    gridCenter: 0x7fb6e6,
    gridEdge: 0x97d0f5,
    runwayColor: 0x4d5d6d,
    cloudColor: 0xffffff,
    cloudOpacity: 0.62,
    cloudCount: 14
  },
  cloudy: {
    label: "Cloudy",
    background: 0xa6c9e8,
    fogColor: 0xc6d8e8,
    fogNear: 420,
    fogFar: 2050,
    skyTop: "#82accd",
    skyHorizon: "#d8e6f1",
    skyBottom: "#f5f8fb",
    ambientIntensity: 0.78,
    ambientColor: 0xf1f5f9,
    hemiSky: 0xb9cfdf,
    hemiGround: 0x70866d,
    hemiIntensity: 0.82,
    sunColor: 0xfff1d1,
    sunIntensity: 1.2,
    sunPosition: [180, 290, -210],
    sunGlowColor: 0xfdf0c0,
    groundColor: 0x6d9d62,
    waterColor: 0x73a8c6,
    mountainColor: 0x6f7c89,
    treeColor: 0x4a6942,
    gridCenter: 0x8eb3d0,
    gridEdge: 0xb9d4e6,
    runwayColor: 0x5f6973,
    cloudColor: 0xf8fbfd,
    cloudOpacity: 0.78,
    cloudCount: 20
  },
  sunset: {
    label: "Sunset",
    background: 0xffb58d,
    fogColor: 0xffd2b0,
    fogNear: 500,
    fogFar: 2350,
    skyTop: "#3c62b5",
    skyHorizon: "#ffba82",
    skyBottom: "#ffe0cb",
    ambientIntensity: 0.72,
    ambientColor: 0xfff1e0,
    hemiSky: 0xf6b98b,
    hemiGround: 0x8e6a52,
    hemiIntensity: 0.78,
    sunColor: 0xffd39c,
    sunIntensity: 1.55,
    sunPosition: [320, 150, -250],
    sunGlowColor: 0xffd78d,
    groundColor: 0x9e8d5c,
    waterColor: 0x7281bb,
    mountainColor: 0x856f72,
    treeColor: 0x76553d,
    gridCenter: 0xf0c49c,
    gridEdge: 0xffd9ac,
    runwayColor: 0x645a5f,
    cloudColor: 0xffe5cf,
    cloudOpacity: 0.56,
    cloudCount: 16
  },
  stormy: {
    label: "Storm Front",
    background: 0x59708b,
    fogColor: 0x7f95aa,
    fogNear: 340,
    fogFar: 1650,
    skyTop: "#334459",
    skyHorizon: "#7f93a5",
    skyBottom: "#c1ccd8",
    ambientIntensity: 0.62,
    ambientColor: 0xe2ebf3,
    hemiSky: 0x78899a,
    hemiGround: 0x506355,
    hemiIntensity: 0.68,
    sunColor: 0xeef5ff,
    sunIntensity: 0.88,
    sunPosition: [100, 240, -160],
    sunGlowColor: 0xcfe2f4,
    groundColor: 0x62735d,
    waterColor: 0x4b7397,
    mountainColor: 0x596471,
    treeColor: 0x3c4c3a,
    gridCenter: 0x8aa0b2,
    gridEdge: 0xaac0cf,
    runwayColor: 0x4b525c,
    cloudColor: 0xe5edf4,
    cloudOpacity: 0.88,
    cloudCount: 24
  },
  foggy: {
    label: "High Fog",
    background: 0xd0dfec,
    fogColor: 0xd7e5f1,
    fogNear: 210,
    fogFar: 960,
    skyTop: "#b8cade",
    skyHorizon: "#edf4f8",
    skyBottom: "#ffffff",
    ambientIntensity: 0.66,
    ambientColor: 0xf7fbff,
    hemiSky: 0xd8e5ef,
    hemiGround: 0x8ea18c,
    hemiIntensity: 0.72,
    sunColor: 0xffffff,
    sunIntensity: 0.72,
    sunPosition: [180, 220, -120],
    sunGlowColor: 0xffffff,
    groundColor: 0x8daa82,
    waterColor: 0xa7c8d8,
    mountainColor: 0x93a0aa,
    treeColor: 0x5d7058,
    gridCenter: 0xd0dce6,
    gridEdge: 0xe9f0f5,
    runwayColor: 0x767c80,
    cloudColor: 0xffffff,
    cloudOpacity: 0.92,
    cloudCount: 24
  }
};

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing app root.");
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 5000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const smokeSpriteTexture = createRadialSpriteTexture([
  [0, "rgba(226, 232, 240, 0.92)"],
  [0.28, "rgba(148, 163, 184, 0.62)"],
  [0.68, "rgba(51, 65, 85, 0.3)"],
  [1, "rgba(15, 23, 42, 0)"]
]);
const fireSpriteTexture = createRadialSpriteTexture([
  [0, "rgba(255, 255, 220, 0.98)"],
  [0.18, "rgba(255, 232, 128, 0.95)"],
  [0.45, "rgba(251, 146, 60, 0.72)"],
  [0.8, "rgba(220, 38, 38, 0.18)"],
  [1, "rgba(127, 29, 29, 0)"]
]);
const emberSpriteTexture = createRadialSpriteTexture([
  [0, "rgba(255, 251, 235, 1)"],
  [0.24, "rgba(254, 240, 138, 0.96)"],
  [0.58, "rgba(249, 115, 22, 0.62)"],
  [1, "rgba(120, 53, 15, 0)"]
]);

const overlay = document.createElement("div");
overlay.className = "overlay";
overlay.innerHTML = `
  <div class="menu">
    <div class="menu-card">
      <h1>Preflight</h1>
      <label>
        Name
        <input id="pilot-name" maxlength="18" value="AcePilot" />
      </label>
      <div class="menu-grid">
        <label>
          Class
          <select id="aircraft-class">
            <option value="fighter">Fighter</option>
            <option value="interceptor">Interceptor</option>
            <option value="heavy">Heavy</option>
          </select>
        </label>
        <label>
          Bots
          <select id="bot-difficulty">
            <option value="easy">Easy</option>
            <option value="medium" selected>Medium</option>
            <option value="hard">Hard</option>
          </select>
        </label>
        <label class="menu-grid-full">
          Weather
          <select id="weather-select">
            <option value="clear">Clear Blue</option>
            <option value="cloudy">Cloudy</option>
            <option value="sunset">Sunset</option>
            <option value="stormy">Storm Front</option>
            <option value="foggy">High Fog</option>
          </select>
        </label>
      </div>
      <button id="start-button">Join Match</button>
      <small id="menu-status" class="warning"></small>
    </div>
  </div>
  <div class="hud">
    <div class="panel stats" id="stats-panel"></div>
    <div class="panel scoreboard" id="scoreboard-panel"></div>
    <div class="panel feed" id="feed-panel"></div>
    <div class="panel center-message" id="center-panel"></div>
    <button class="mobile-fullscreen-button" id="mobile-fullscreen-button" type="button">FULL</button>
    <button class="mobile-menu-button" id="mobile-menu-button" type="button">MENU</button>
    <div class="crosshair"></div>
    <div class="target-indicator" id="target-indicator"></div>
    <div class="orientation-hint" id="orientation-hint">Rotate your device to landscape for best control.</div>
    <div class="mobile-controls" id="mobile-controls">
      <div class="mobile-control-stack left">
        <div class="touch-shell">
          <span class="touch-label">FLIGHT</span>
          <div class="touch-pad" id="touch-pad">
            <div class="touch-knob" id="touch-knob"></div>
          </div>
        </div>
      </div>
      <div class="mobile-control-stack right">
        <div class="touch-throttle" id="touch-throttle">
          <span class="touch-throttle-label">THR</span>
          <div class="touch-throttle-track"></div>
          <div class="touch-throttle-fill" id="touch-throttle-fill"></div>
          <div class="touch-throttle-thumb" id="touch-throttle-thumb"></div>
        </div>
        <div class="touch-actions">
          <button class="touch-button missile" id="touch-missile" type="button">MISSILE</button>
          <button class="touch-button boost" id="touch-boost" type="button">BOOST</button>
          <button class="touch-button fire" id="touch-fire" type="button">FIRE</button>
        </div>
      </div>
    </div>
  </div>
`;
app.appendChild(overlay);

const menu = overlay.querySelector<HTMLDivElement>(".menu")!;
const startButton = overlay.querySelector<HTMLButtonElement>("#start-button")!;
const pilotInput = overlay.querySelector<HTMLInputElement>("#pilot-name")!;
const weatherSelect = overlay.querySelector<HTMLSelectElement>("#weather-select")!;
const aircraftClassSelect = overlay.querySelector<HTMLSelectElement>("#aircraft-class")!;
const botDifficultySelect = overlay.querySelector<HTMLSelectElement>("#bot-difficulty")!;
const menuStatus = overlay.querySelector<HTMLElement>("#menu-status")!;
const statsPanel = overlay.querySelector<HTMLElement>("#stats-panel")!;
const scoreboardPanel = overlay.querySelector<HTMLElement>("#scoreboard-panel")!;
const feedPanel = overlay.querySelector<HTMLElement>("#feed-panel")!;
const centerPanel = overlay.querySelector<HTMLElement>("#center-panel")!;
const mobileFullscreenButton = overlay.querySelector<HTMLButtonElement>("#mobile-fullscreen-button")!;
const mobileMenuButton = overlay.querySelector<HTMLButtonElement>("#mobile-menu-button")!;
const targetIndicator = overlay.querySelector<HTMLElement>("#target-indicator")!;
const orientationHint = overlay.querySelector<HTMLElement>("#orientation-hint")!;
const mobileControls = overlay.querySelector<HTMLElement>("#mobile-controls")!;
const touchPad = overlay.querySelector<HTMLElement>("#touch-pad")!;
const touchKnob = overlay.querySelector<HTMLElement>("#touch-knob")!;
const touchThrottle = overlay.querySelector<HTMLElement>("#touch-throttle")!;
const touchThrottleFill = overlay.querySelector<HTMLElement>("#touch-throttle-fill")!;
const touchThrottleThumb = overlay.querySelector<HTMLElement>("#touch-throttle-thumb")!;
const touchFireButton = overlay.querySelector<HTMLButtonElement>("#touch-fire")!;
const touchBoostButton = overlay.querySelector<HTMLButtonElement>("#touch-boost")!;
const touchMissileButton = overlay.querySelector<HTMLButtonElement>("#touch-missile")!;

const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL, {
  autoConnect: false
});

const clock = new THREE.Clock();
const keys = new Set<string>();
const remoteVisuals = new Map<string, AircraftVisual>();
const feed: FeedItem[] = [];
const tracers: Tracer[] = [];
const destroyedEffects: DestroyedAircraftEffect[] = [];
const roster = new Map<string, string>();
const combatantMeta = new Map<string, CombatantMeta>();

let audioContext: AudioContext | null = null;
let engineAudio: EngineAudio | null = null;
let playerId = "";
let localState = createAircraftState();
let authoritativeLocalState = createAircraftState();
let localControls: ControlState = {
  pitch: 0,
  yaw: 0,
  roll: 0,
  throttle: 0.65,
  boost: false,
  firing: false
};
let latestSnapshot: SnapshotPlayer[] = [];
let nextControlsAt = 0;
let nextShotAt = 0;
let nextMissileAt = 0;
let joinReady = false;
let activeInputMode: InputMode = "keyboard";
let currentWeather: WeatherPresetName = "clear";
let elapsedTime = 0;
let localAircraftClass: AircraftClass = "fighter";
let isReturningToSelection = false;
let missileTriggerHeld = false;
const isTouchDevice = window.matchMedia("(pointer: coarse)").matches || ("ontouchstart" in window);
let touchYaw = 0;
let touchPitch = 0;
let touchFiring = false;
let touchBoost = false;
let touchMissileQueued = false;
let touchPadPointerId: number | null = null;
let touchThrottlePointerId: number | null = null;

const localAircraft = createAircraftMesh(0x3a86ff, true);
scene.add(localAircraft.group);
localAircraft.group.visible = false;
localAircraft.contrail.visible = false;

const world = createWorld();
setupSocket();
setupInput();
animate();

function deriveServerUrl(): string {
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const hostname = window.location.hostname || "localhost";
  return `${protocol}//${hostname}:3001`;
}

type FullscreenCapableElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FullscreenCapableDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

function createWorld(): WorldObjects {
  camera.position.set(0, 55, -110);

  const skyMaterial = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
  const skyDome = new THREE.Mesh(new THREE.SphereGeometry(3200, 48, 48), skyMaterial);
  scene.add(skyDome);

  const ambient = new THREE.AmbientLight(0xffffff, 0.85);
  scene.add(ambient);

  const hemisphere = new THREE.HemisphereLight(0xffffff, 0x7aa06c, 0.9);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 50;
  sun.shadow.camera.far = 900;
  sun.shadow.camera.left = -220;
  sun.shadow.camera.right = 220;
  sun.shadow.camera.top = 220;
  sun.shadow.camera.bottom = -220;
  scene.add(sun);

  const sunGlow = new THREE.Mesh(
    new THREE.SphereGeometry(42, 18, 18),
    new THREE.MeshBasicMaterial({ color: 0xfff7c2, transparent: true, opacity: 0.42 })
  );
  scene.add(sunGlow);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(5200, 5200, 24, 24),
    new THREE.MeshStandardMaterial({ color: 0x78b46a, roughness: 0.94 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 14;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(3200, 48, 0x7fb6e6, 0x97d0f5);
  grid.position.y = 14.1;
  scene.add(grid);

  const water = new THREE.Mesh(
    new THREE.CircleGeometry(780, 42),
    new THREE.MeshStandardMaterial({ color: 0x62b7de, transparent: true, opacity: 0.82, roughness: 0.24 })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(-520, 14.05, 660);
  scene.add(water);

  const runwayGroup = new THREE.Group();
  const runway = new THREE.Mesh(
    new THREE.BoxGeometry(190, 1.5, 760),
    new THREE.MeshStandardMaterial({ color: 0x4d5d6d, roughness: 0.82 })
  );
  runway.position.set(0, 15, 0);
  runway.receiveShadow = true;
  runwayGroup.add(runway);

  for (let index = 0; index < 12; index += 1) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(11, 0.35, 28),
      new THREE.MeshBasicMaterial({ color: 0xf8fafc, transparent: true, opacity: 0.68 })
    );
    stripe.position.set(0, 16, -300 + (index * 56));
    runwayGroup.add(stripe);
  }

  for (let side = -1; side <= 1; side += 2) {
    for (let index = 0; index < 22; index += 1) {
      const light = new THREE.Mesh(
        new THREE.CylinderGeometry(1.2, 1.2, 8),
        new THREE.MeshStandardMaterial({ color: 0x31414f, roughness: 0.9 })
      );
      light.position.set(side * 96, 19, -340 + (index * 32));
      runwayGroup.add(light);

      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(1.8, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0xffe28a, transparent: true, opacity: 0.72 })
      );
      cap.position.set(side * 96, 23, -340 + (index * 32));
      runwayGroup.add(cap);
    }
  }

  scene.add(runwayGroup);

  const mountainMeshes: THREE.Mesh[] = [];
  for (let index = 0; index < 28; index += 1) {
    const radius = 880 + Math.random() * 950;
    const angle = (index / 28) * Math.PI * 2;
    const height = 120 + Math.random() * 240;
    const mountain = new THREE.Mesh(
      new THREE.ConeGeometry(80 + Math.random() * 95, height, 6),
      new THREE.MeshStandardMaterial({ color: 0x74899d, flatShading: true, roughness: 1 })
    );
    mountain.position.set(Math.cos(angle) * radius, (height * 0.5) + 10, Math.sin(angle) * radius);
    mountain.rotation.y = Math.random() * Math.PI;
    mountain.castShadow = true;
    mountain.receiveShadow = true;
    scene.add(mountain);
    mountainMeshes.push(mountain);
  }

  const treeMeshes: THREE.Mesh[] = [];
  for (let index = 0; index < 80; index += 1) {
    const tree = new THREE.Mesh(
      new THREE.ConeGeometry(10 + Math.random() * 8, 30 + Math.random() * 30, 5),
      new THREE.MeshStandardMaterial({ color: 0x3f6e35, flatShading: true })
    );
    const side = Math.random() > 0.5 ? 1 : -1;
    tree.position.set(
      side * (150 + Math.random() * 460),
      28,
      -850 + Math.random() * 1700
    );
    tree.castShadow = true;
    scene.add(tree);
    treeMeshes.push(tree);
  }

  const cloudLayers: CloudLayer[] = [];
  for (let index = 0; index < 24; index += 1) {
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.62,
      roughness: 0.55
    });
    const cloud = createCloudLayer(material, index);
    scene.add(cloud.group);
    cloudLayers.push(cloud);
  }

  const skyAmbientObjects: SkyAmbientObject[] = [];
  for (let index = 0; index < 10; index += 1) {
    const parachute = createSkyParachute(index);
    scene.add(parachute.group);
    skyAmbientObjects.push(parachute);
  }
  for (let index = 0; index < 6; index += 1) {
    const balloon = createSkyBalloon(index);
    scene.add(balloon.group);
    skyAmbientObjects.push(balloon);
  }
  for (let index = 0; index < 14; index += 1) {
    const bird = createSkyBird(index);
    scene.add(bird.group);
    skyAmbientObjects.push(bird);
  }
  for (let index = 0; index < 8; index += 1) {
    const plane = createSkyPassengerPlane(index);
    scene.add(plane.group);
    skyAmbientObjects.push(plane);
  }
  for (let index = 0; index < 6; index += 1) {
    const heli = createSkyHelicopter(index);
    scene.add(heli.group);
    skyAmbientObjects.push(heli);
  }

  applyWeatherPreset(currentWeather, {
    skyDome,
    skyMaterial,
    ambient,
    hemisphere,
    sun,
    sunGlow,
    ground,
    grid,
    runway,
    water,
    mountainMeshes,
    treeMeshes,
    cloudLayers,
    skyAmbientObjects
  });

  return {
    skyDome,
    skyMaterial,
    ambient,
    hemisphere,
    sun,
    sunGlow,
    ground,
    grid,
    runway,
    water,
    mountainMeshes,
    treeMeshes,
    cloudLayers,
    skyAmbientObjects
  };
}

function createCloudLayer(material: THREE.MeshStandardMaterial, index: number): CloudLayer {
  const group = new THREE.Group();
  const puffCount = 5 + (index % 4);

  for (let puff = 0; puff < puffCount; puff += 1) {
    const cloudPart = new THREE.Mesh(
      new THREE.SphereGeometry(18 + Math.random() * 18, 12, 12),
      material
    );
    cloudPart.scale.set(1.3 + Math.random() * 1.6, 0.55 + Math.random() * 0.25, 1.2 + Math.random() * 1.4);
    cloudPart.position.set(
      (puff - (puffCount / 2)) * (18 + Math.random() * 10),
      Math.random() * 10,
      -10 + Math.random() * 20
    );
    group.add(cloudPart);
  }

  const baseY = 150 + Math.random() * 260;
  group.position.set(
    -1200 + Math.random() * 2400,
    baseY,
    -1200 + Math.random() * 2400
  );

  return {
    group,
    material,
    drift: 6 + Math.random() * 12,
    sway: Math.random() * Math.PI * 2,
    baseY
  };
}

function createSkyParachute(index: number): SkyAmbientObject {
  const group = new THREE.Group();
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(7.5, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    new THREE.MeshStandardMaterial({ color: 0xff8fab, roughness: 0.72 })
  );
  canopy.castShadow = true;
  group.add(canopy);

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.85, 2.5, 4, 10),
    new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.62 })
  );
  body.position.y = -4.2;
  body.castShadow = true;
  group.add(body);

  for (let indexCord = 0; indexCord < 4; indexCord += 1) {
    const angle = (indexCord / 4) * Math.PI * 2;
    const rope = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 4.6, 6),
      new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 1 })
    );
    rope.position.set(Math.cos(angle) * 2.3, -2.2, Math.sin(angle) * 2.3);
    rope.rotation.z = Math.cos(angle) * 0.2;
    rope.rotation.x = Math.sin(angle) * 0.2;
    group.add(rope);
  }

  return {
    group,
    kind: "parachute",
    orbitRadius: 620 + (index * 75) + (Math.random() * 110),
    orbitSpeed: 0.055 + (Math.random() * 0.02),
    angle: ((index / 10) * Math.PI * 2) + (Math.random() * 0.4),
    baseY: 210 + (Math.random() * 170),
    bobAmp: 4 + (Math.random() * 4),
    bobSpeed: 0.45 + (Math.random() * 0.25)
  };
}

function createSkyBalloon(index: number): SkyAmbientObject {
  const group = new THREE.Group();
  const envelope = new THREE.Mesh(
    new THREE.SphereGeometry(12, 16, 14),
    new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.6, metalness: 0.05 })
  );
  envelope.scale.set(1, 1.2, 1);
  envelope.castShadow = true;
  group.add(envelope);

  const basket = new THREE.Mesh(
    new THREE.BoxGeometry(3.2, 2.4, 2.6),
    new THREE.MeshStandardMaterial({ color: 0x92400e, roughness: 0.92 })
  );
  basket.position.y = -16.5;
  basket.castShadow = true;
  group.add(basket);

  for (let ropeIndex = 0; ropeIndex < 4; ropeIndex += 1) {
    const sideX = ropeIndex < 2 ? -1 : 1;
    const sideZ = ropeIndex % 2 === 0 ? -1 : 1;
    const rope = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 8.5, 6),
      new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 1 })
    );
    rope.position.set(sideX * 1.7, -11.2, sideZ * 1.4);
    rope.rotation.x = sideZ * 0.08;
    rope.rotation.z = sideX * -0.08;
    group.add(rope);
  }

  return {
    group,
    kind: "balloon",
    orbitRadius: 760 + (index * 120) + (Math.random() * 140),
    orbitSpeed: 0.028 + (Math.random() * 0.014),
    angle: ((index / 6) * Math.PI * 2) + (Math.random() * 0.45),
    baseY: 260 + (Math.random() * 170),
    bobAmp: 7 + (Math.random() * 6),
    bobSpeed: 0.2 + (Math.random() * 0.18)
  };
}

function createSkyBird(index: number): SkyAmbientObject {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.42, 1.5, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.82 })
  );
  body.rotation.z = Math.PI * 0.5;
  group.add(body);

  const leftWing = new THREE.Mesh(
    new THREE.BoxGeometry(2.5, 0.12, 0.85),
    new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.8 })
  );
  leftWing.name = "wing-left";
  leftWing.position.set(-1.2, 0, 0);
  group.add(leftWing);

  const rightWing = new THREE.Mesh(
    new THREE.BoxGeometry(2.5, 0.12, 0.85),
    new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.8 })
  );
  rightWing.name = "wing-right";
  rightWing.position.set(1.2, 0, 0);
  group.add(rightWing);

  const tail = new THREE.Mesh(
    new THREE.ConeGeometry(0.28, 1, 5),
    new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.86 })
  );
  tail.rotation.z = -Math.PI * 0.5;
  tail.position.x = -1.2;
  group.add(tail);

  return {
    group,
    kind: "bird",
    orbitRadius: 540 + (index * 56) + (Math.random() * 120),
    orbitSpeed: 0.13 + (Math.random() * 0.08),
    angle: ((index / 14) * Math.PI * 2) + (Math.random() * 0.65),
    baseY: 150 + (Math.random() * 180),
    bobAmp: 3 + (Math.random() * 3),
    bobSpeed: 0.85 + (Math.random() * 0.45)
  };
}

function createSkyPassengerPlane(index: number): SkyAmbientObject {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.4, metalness: 0.28 });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.48, metalness: 0.18 });

  const fuselage = new THREE.Mesh(new THREE.CapsuleGeometry(1.8, 15, 6, 16), bodyMaterial);
  fuselage.rotation.z = Math.PI * 0.5;
  fuselage.castShadow = true;
  group.add(fuselage);

  const wings = new THREE.Mesh(new THREE.BoxGeometry(18, 0.4, 3.2), accentMaterial);
  wings.castShadow = true;
  group.add(wings);

  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.3, 1.4), accentMaterial);
  tailWing.position.set(-7.8, 1.1, 0);
  tailWing.castShadow = true;
  group.add(tailWing);

  const tailFin = new THREE.Mesh(new THREE.BoxGeometry(0.45, 2.8, 1.8), accentMaterial);
  tailFin.position.set(-8.5, 2.2, 0);
  tailFin.castShadow = true;
  group.add(tailFin);

  const engineLeft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.8, 0.8, 2.4, 10),
    new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.62 })
  );
  engineLeft.rotation.z = Math.PI * 0.5;
  engineLeft.position.set(3.2, -0.65, -3);
  group.add(engineLeft);

  const engineRight = engineLeft.clone();
  engineRight.position.z = 3;
  group.add(engineRight);

  return {
    group,
    kind: "plane",
    orbitRadius: 930 + (index * 130) + (Math.random() * 140),
    orbitSpeed: 0.05 + (Math.random() * 0.02),
    angle: ((index / 8) * Math.PI * 2) + (Math.random() * 0.5),
    baseY: 290 + (Math.random() * 180),
    bobAmp: 2 + (Math.random() * 2),
    bobSpeed: 0.33 + (Math.random() * 0.2),
    contrailTimer: 0.7 + (Math.random() * 1.6),
    contrailInterval: 1.1 + (Math.random() * 2.3)
  };
}

function createSkyHelicopter(index: number): SkyAmbientObject {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.55, metalness: 0.16 });

  const cabin = new THREE.Mesh(
    new THREE.SphereGeometry(2.5, 14, 12),
    new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.46, metalness: 0.12 })
  );
  cabin.scale.set(1.3, 0.85, 1);
  cabin.castShadow = true;
  group.add(cabin);

  const tailBoom = new THREE.Mesh(new THREE.BoxGeometry(9.5, 0.45, 0.45), bodyMaterial);
  tailBoom.position.x = -5.4;
  tailBoom.castShadow = true;
  group.add(tailBoom);

  const skidLeft = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 6.5, 8), bodyMaterial);
  skidLeft.rotation.z = Math.PI * 0.5;
  skidLeft.position.set(0, -2.45, -1.6);
  group.add(skidLeft);

  const skidRight = skidLeft.clone();
  skidRight.position.z = 1.6;
  group.add(skidRight);

  const mainRotor = new THREE.Mesh(
    new THREE.BoxGeometry(11, 0.08, 0.28),
    new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.76 })
  );
  mainRotor.name = "rotor-main";
  mainRotor.position.y = 2.3;
  group.add(mainRotor);

  const tailRotor = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 1.6, 0.24),
    new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.76 })
  );
  tailRotor.name = "rotor-tail";
  tailRotor.position.set(-9.7, 0.4, 0);
  group.add(tailRotor);

  return {
    group,
    kind: "heli",
    orbitRadius: 700 + (index * 90) + (Math.random() * 120),
    orbitSpeed: 0.08 + (Math.random() * 0.04),
    angle: ((index / 6) * Math.PI * 2) + (Math.random() * 0.5),
    baseY: 170 + (Math.random() * 140),
    bobAmp: 3 + (Math.random() * 3),
    bobSpeed: 0.55 + (Math.random() * 0.35),
    contrailTimer: 1.8 + (Math.random() * 2.2),
    contrailInterval: 2.8 + (Math.random() * 2.8)
  };
}

function applyWeatherPreset(name: WeatherPresetName, targetWorld: WorldObjects): void {
  currentWeather = name;
  weatherSelect.value = name;
  const preset = WEATHER_PRESETS[name];

  scene.background = new THREE.Color(preset.background);
  scene.fog = new THREE.Fog(preset.fogColor, preset.fogNear, preset.fogFar);

  const nextTexture = createSkyGradientTexture(preset);
  targetWorld.skyMaterial.map?.dispose();
  targetWorld.skyMaterial.map = nextTexture;
  targetWorld.skyMaterial.needsUpdate = true;

  targetWorld.ambient.color.setHex(preset.ambientColor);
  targetWorld.ambient.intensity = preset.ambientIntensity;
  targetWorld.hemisphere.color.setHex(preset.hemiSky);
  targetWorld.hemisphere.groundColor.setHex(preset.hemiGround);
  targetWorld.hemisphere.intensity = preset.hemiIntensity;
  targetWorld.sun.color.setHex(preset.sunColor);
  targetWorld.sun.intensity = preset.sunIntensity;
  targetWorld.sun.position.set(...preset.sunPosition);
  targetWorld.sunGlow.position.set(
    preset.sunPosition[0] * 3,
    preset.sunPosition[1] * 3,
    preset.sunPosition[2] * 3
  );
  (targetWorld.sunGlow.material as THREE.MeshBasicMaterial).color.setHex(preset.sunGlowColor);

  (targetWorld.ground.material as THREE.MeshStandardMaterial).color.setHex(preset.groundColor);
  (targetWorld.water.material as THREE.MeshStandardMaterial).color.setHex(preset.waterColor);
  (targetWorld.runway.material as THREE.MeshStandardMaterial).color.setHex(preset.runwayColor);
  const gridMaterial = targetWorld.grid.material as THREE.Material;
  if ("opacity" in gridMaterial) {
    (gridMaterial as THREE.LineBasicMaterial).opacity = 0.28;
    (gridMaterial as THREE.LineBasicMaterial).transparent = true;
  }

  targetWorld.mountainMeshes.forEach((mesh) => {
    (mesh.material as THREE.MeshStandardMaterial).color.setHex(preset.mountainColor);
  });

  targetWorld.treeMeshes.forEach((mesh) => {
    (mesh.material as THREE.MeshStandardMaterial).color.setHex(preset.treeColor);
  });

  targetWorld.cloudLayers.forEach((cloud, index) => {
    cloud.group.visible = index < preset.cloudCount;
    cloud.material.color.setHex(preset.cloudColor);
    cloud.material.opacity = preset.cloudOpacity;
  });
}

function createSkyGradientTexture(preset: WeatherPreset): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 512;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to create sky texture.");
  }

  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, preset.skyTop);
  gradient.addColorStop(0.52, preset.skyHorizon);
  gradient.addColorStop(1, preset.skyBottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createRadialSpriteTexture(stops: Array<[number, string]>): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to create effect sprite texture.");
  }

  const gradient = context.createRadialGradient(64, 64, 10, 64, 64, 64);
  stops.forEach(([offset, color]) => {
    gradient.addColorStop(offset, color);
  });
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createEffectSprite(
  texture: THREE.Texture,
  color: number,
  opacity: number,
  baseScale: number,
  blending: THREE.Blending = THREE.AdditiveBlending
): DestroyedEffectSprite {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending
  }));
  sprite.visible = false;
  sprite.renderOrder = 6;
  sprite.scale.setScalar(baseScale);

  return {
    sprite,
    velocity: new THREE.Vector3(),
    life: 1,
    age: 1,
    baseScale,
    spin: 0,
    drift: 0
  };
}

function resetSmokeSprite(particle: DestroyedEffectSprite): void {
  particle.life = 1.8 + (Math.random() * 1.7);
  particle.age = 0;
  particle.spin = (Math.random() - 0.5) * 0.6;
  particle.drift = Math.random() * Math.PI * 2;
  particle.sprite.visible = true;
  particle.sprite.position.set(
    (Math.random() - 0.5) * 5.6,
    0.9 + (Math.random() * 0.85),
    (Math.random() - 0.5) * 5.6
  );
  particle.velocity.set(
    (Math.random() - 0.5) * 1.8,
    8.5 + (Math.random() * 6.5),
    (Math.random() - 0.5) * 1.8
  );
  particle.baseScale = 8 + (Math.random() * 8);
  particle.sprite.scale.setScalar(particle.baseScale * 0.7);
  (particle.sprite.material as THREE.SpriteMaterial).opacity = 0.34 + (Math.random() * 0.1);
}

function resetFireSprite(particle: DestroyedEffectSprite): void {
  particle.life = 0.5 + (Math.random() * 0.55);
  particle.age = 0;
  particle.spin = (Math.random() - 0.5) * 1.6;
  particle.drift = Math.random() * Math.PI * 2;
  particle.sprite.visible = true;
  particle.sprite.position.set(
    (Math.random() - 0.5) * 2.6,
    0.7 + (Math.random() * 0.9),
    (Math.random() - 0.5) * 2.6
  );
  particle.velocity.set(
    (Math.random() - 0.5) * 1.4,
    2.2 + (Math.random() * 1.8),
    (Math.random() - 0.5) * 1.4
  );
  particle.baseScale = 7 + (Math.random() * 5);
  particle.sprite.scale.setScalar(particle.baseScale);
  (particle.sprite.material as THREE.SpriteMaterial).opacity = 0.58 + (Math.random() * 0.14);
}

function igniteEmberSprite(particle: DestroyedEffectSprite, initialVelocity: THREE.Vector3): void {
  particle.life = 0.8 + (Math.random() * 0.7);
  particle.age = 0;
  particle.spin = (Math.random() - 0.5) * 3.2;
  particle.drift = Math.random() * Math.PI * 2;
  particle.sprite.visible = true;
  particle.sprite.position.set(
    (Math.random() - 0.5) * 1.8,
    0.6 + (Math.random() * 0.7),
    (Math.random() - 0.5) * 1.8
  );
  particle.velocity.copy(initialVelocity).multiplyScalar(0.03 + (Math.random() * 0.03));
  particle.velocity.x += (Math.random() - 0.5) * 9;
  particle.velocity.y += 8 + (Math.random() * 8);
  particle.velocity.z += (Math.random() - 0.5) * 9;
  particle.baseScale = 2.4 + (Math.random() * 2.2);
  particle.sprite.scale.setScalar(particle.baseScale);
  (particle.sprite.material as THREE.SpriteMaterial).opacity = 0.9;
}

function createDestroyedAircraftEffect(ownerId: string, state: AircraftState): DestroyedAircraftEffect {
  const group = new THREE.Group();
  group.position.set(state.position.x, state.position.y, state.position.z);

  const flash = new THREE.Mesh(
    new THREE.SphereGeometry(2.4, 16, 16),
    new THREE.MeshBasicMaterial({
      color: 0xfff2a8,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  group.add(flash);

  const shockwave = new THREE.Mesh(
    new THREE.RingGeometry(2.4, 3.7, 32),
    new THREE.MeshBasicMaterial({
      color: 0xfb923c,
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  );
  shockwave.rotation.x = Math.PI / 2;
  group.add(shockwave);

  const smokeSprites = Array.from({ length: 9 }, () => {
    const particle = createEffectSprite(smokeSpriteTexture, 0x475569, 0.34, 10, THREE.NormalBlending);
    resetSmokeSprite(particle);
    particle.age = Math.random() * particle.life * 0.8;
    group.add(particle.sprite);
    return particle;
  });

  const fireSprites = Array.from({ length: 4 }, () => {
    const particle = createEffectSprite(fireSpriteTexture, 0xff8a3d, 0.68, 9);
    resetFireSprite(particle);
    particle.age = Math.random() * particle.life * 0.55;
    group.add(particle.sprite);
    return particle;
  });

  const velocity = new THREE.Vector3(state.velocity.x, state.velocity.y, state.velocity.z);
  const emberSprites = Array.from({ length: 12 }, () => {
    const particle = createEffectSprite(emberSpriteTexture, 0xffe08a, 0.9, 3.4);
    igniteEmberSprite(particle, velocity);
    group.add(particle.sprite);
    return particle;
  });

  scene.add(group);
  return {
    ownerId,
    group,
    flash,
    shockwave,
    smokeSprites,
    fireSprites,
    emberSprites,
    age: 0,
    duration: DESTROYED_EFFECT_DURATION
  };
}

function updateSmokeSprite(effectAge: number, particle: DestroyedEffectSprite, dt: number): void {
  particle.age += dt;
  const progress = clamp(particle.age / particle.life, 0, 1);
  const material = particle.sprite.material as THREE.SpriteMaterial;
  particle.velocity.x += Math.sin((effectAge * 1.7) + particle.drift) * dt * 0.9;
  particle.velocity.z += Math.cos((effectAge * 1.5) + particle.drift) * dt * 0.9;
  particle.sprite.position.addScaledVector(particle.velocity, dt);
  material.rotation += particle.spin * dt;
  particle.sprite.scale.setScalar(particle.baseScale * (0.7 + (progress * 1.8)));
  material.opacity = Math.max(0, (1 - progress) * 0.34);
}

function updateFireSprite(effectAge: number, particle: DestroyedEffectSprite, dt: number): void {
  particle.age += dt;
  const progress = clamp(particle.age / particle.life, 0, 1);
  const material = particle.sprite.material as THREE.SpriteMaterial;
  particle.sprite.position.addScaledVector(particle.velocity, dt * 0.55);
  particle.sprite.position.x += Math.sin((effectAge * 12) + particle.drift) * dt * 1.8;
  particle.sprite.position.z += Math.cos((effectAge * 11) + particle.drift) * dt * 1.8;
  material.rotation += particle.spin * dt;
  const flicker = 0.88 + (Math.sin((effectAge * 18) + particle.drift) * 0.18);
  particle.sprite.scale.setScalar(particle.baseScale * flicker * (1 + (progress * 0.35)));
  material.opacity = Math.max(0, (1 - progress) * 0.72);
}

function updateEmberSprite(particle: DestroyedEffectSprite, dt: number): void {
  particle.age += dt;
  const progress = clamp(particle.age / particle.life, 0, 1);
  const material = particle.sprite.material as THREE.SpriteMaterial;
  particle.velocity.y -= 10.5 * dt;
  particle.sprite.position.addScaledVector(particle.velocity, dt);
  material.rotation += particle.spin * dt;
  particle.sprite.scale.setScalar(particle.baseScale * (1 - (progress * 0.45)));
  material.opacity = Math.max(0, (1 - progress) * (1 - progress));
}

function disposeDestroyedAircraftEffect(effect: DestroyedAircraftEffect): void {
  scene.remove(effect.group);
  effect.group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if ("geometry" in mesh && mesh.geometry) {
      mesh.geometry.dispose();
    }

    const material = (mesh as THREE.Mesh | THREE.Sprite).material;
    if (Array.isArray(material)) {
      material.forEach((entry) => entry.dispose());
    } else {
      material?.dispose();
    }
  });
}

function updateDestroyedEffects(dt: number): void {
  for (let index = destroyedEffects.length - 1; index >= 0; index -= 1) {
    const effect = destroyedEffects[index];
    effect.age += dt;
    const flashProgress = clamp(effect.age / 0.38, 0, 1);
    const shockwaveProgress = clamp(effect.age / 0.7, 0, 1);
    const flashMaterial = effect.flash.material as THREE.MeshBasicMaterial;
    const shockwaveMaterial = effect.shockwave.material as THREE.MeshBasicMaterial;

    effect.flash.scale.setScalar(1 + (flashProgress * 9));
    flashMaterial.opacity = Math.max(0, (1 - flashProgress) * 0.95);

    effect.shockwave.scale.setScalar(1 + (shockwaveProgress * 11));
    shockwaveMaterial.opacity = Math.max(0, (1 - shockwaveProgress) * 0.62);

    let particlesAlive = false;

    // Keep the smoke and fire alive for a few seconds so the wreck reads clearly at a distance.
    effect.smokeSprites.forEach((particle) => {
      if (!particle.sprite.visible && effect.age < DESTROYED_EFFECT_SMOKE_DURATION) {
        resetSmokeSprite(particle);
      }

      if (!particle.sprite.visible) {
        return;
      }

      updateSmokeSprite(effect.age, particle, dt);
      if (particle.age >= particle.life) {
        particle.sprite.visible = false;
      } else {
        particlesAlive = true;
      }
    });

    effect.fireSprites.forEach((particle) => {
      if (!particle.sprite.visible && effect.age < DESTROYED_EFFECT_FIRE_DURATION) {
        resetFireSprite(particle);
      }

      if (!particle.sprite.visible) {
        return;
      }

      updateFireSprite(effect.age, particle, dt);
      if (particle.age >= particle.life) {
        particle.sprite.visible = false;
      } else {
        particlesAlive = true;
      }
    });

    effect.emberSprites.forEach((particle) => {
      if (!particle.sprite.visible) {
        return;
      }

      updateEmberSprite(particle, dt);
      if (particle.age >= particle.life) {
        particle.sprite.visible = false;
      } else {
        particlesAlive = true;
      }
    });

    if (effect.age >= effect.duration && !particlesAlive) {
      disposeDestroyedAircraftEffect(effect);
      destroyedEffects.splice(index, 1);
    }
  }
}

function spawnDestroyedAircraftEffect(ownerId: string, state: AircraftState): void {
  destroyedEffects.push(createDestroyedAircraftEffect(ownerId, state));
}

function clearDestroyedEffects(): void {
  destroyedEffects.forEach((effect) => {
    disposeDestroyedAircraftEffect(effect);
  });
  destroyedEffects.length = 0;
}

function resetContrail(line: THREE.Line, history: THREE.Vector3[]): void {
  history.length = 0;
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
}

function createAircraftMesh(color: number, isLocal: boolean): { group: THREE.Group; contrail: THREE.Line; history: THREE.Vector3[] } {
  const material = new THREE.MeshStandardMaterial({
    color,
    flatShading: true,
    emissive: isLocal ? 0x0c4a6e : 0x4c0519,
    emissiveIntensity: 0.6,
    roughness: 0.55,
    metalness: 0.08
  });

  const canopyMaterial = new THREE.MeshStandardMaterial({
    color: 0xdbeafe,
    transparent: true,
    opacity: 0.78,
    metalness: 0.2,
    roughness: 0.15
  });

  const group = new THREE.Group();

  const fuselage = new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.2, 12), material);
  fuselage.castShadow = true;
  group.add(fuselage);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(1, 3, 6), material);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 7;
  nose.castShadow = true;
  group.add(nose);

  const wings = new THREE.Mesh(new THREE.BoxGeometry(13, 0.35, 3.2), material);
  wings.position.z = -0.5;
  wings.castShadow = true;
  group.add(wings);

  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.25, 1.8), material);
  tailWing.position.set(0, 0.8, -4.3);
  tailWing.castShadow = true;
  group.add(tailWing);

  const tailFin = new THREE.Mesh(new THREE.BoxGeometry(0.4, 2.2, 1.8), material);
  tailFin.position.set(0, 1.4, -4.8);
  tailFin.castShadow = true;
  group.add(tailFin);

  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1.15, 12, 12), canopyMaterial);
  canopy.scale.set(1, 0.55, 1.45);
  canopy.position.set(0, 0.85, 1.3);
  group.add(canopy);

  const afterburner = new THREE.Mesh(
    new THREE.ConeGeometry(0.55, 2.6, 10),
    new THREE.MeshBasicMaterial({
      color: isLocal ? 0x22d3ee : 0xf43f5e,
      transparent: true,
      opacity: 0.86
    })
  );
  afterburner.rotation.x = -Math.PI / 2;
  afterburner.position.z = -7;
  group.add(afterburner);

  const contrailGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const contrail = new THREE.Line(
    contrailGeometry,
    new THREE.LineBasicMaterial({
      color: isLocal ? 0xbdeafe : 0xffd0d9,
      transparent: true,
      opacity: 0.46
    })
  );
  scene.add(contrail);

  return { group, contrail, history: [] };
}

function aircraftPalette(team: Team, aircraftClass: AircraftClass): { body: number; emissive: number; contrail: number } {
  if (team === "human") {
    if (aircraftClass === "interceptor") {
      return { body: 0x14b8a6, emissive: 0x0f766e, contrail: 0x99f6e4 };
    }
    if (aircraftClass === "heavy") {
      return { body: 0x1d4ed8, emissive: 0x1e3a8a, contrail: 0xbfdbfe };
    }
    return { body: 0x3b82f6, emissive: 0x1e40af, contrail: 0x93c5fd };
  }

  if (aircraftClass === "interceptor") {
    return { body: 0xfb7185, emissive: 0x9f1239, contrail: 0xfecdd3 };
  }
  if (aircraftClass === "heavy") {
    return { body: 0xea580c, emissive: 0x9a3412, contrail: 0xfdba74 };
  }
  return { body: 0xf97316, emissive: 0x7c2d12, contrail: 0xfdba74 };
}

function applyAircraftTheme(
  group: THREE.Group,
  contrail: THREE.Line,
  team: Team,
  aircraftClass: AircraftClass
): void {
  const palette = aircraftPalette(team, aircraftClass);
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }

    const material = mesh.material;
    if (material instanceof THREE.MeshStandardMaterial) {
      if (material.transparent && material.opacity < 0.85) {
        return;
      }
      material.color.setHex(palette.body);
      material.emissive.setHex(palette.emissive);
    }
  });

  if (contrail.material instanceof THREE.LineBasicMaterial) {
    contrail.material.color.setHex(palette.contrail);
  }
}

function recolorRemoteVisual(visual: AircraftVisual, team: Team, aircraftClass: AircraftClass): void {
  applyAircraftTheme(visual.group, visual.contrail, team, aircraftClass);
}

function setupSocket(): void {
  socket.on("snapshot", (payload) => {
    latestSnapshot = payload.players;

    for (const player of payload.players) {
      roster.set(player.id, player.name);
      combatantMeta.set(player.id, {
        team: player.team,
        isBot: player.isBot,
        aircraftClass: player.aircraftClass
      });

      if (player.id === playerId) {
        authoritativeLocalState = cloneAircraftState(player.state);
        localAircraftClass = player.aircraftClass;

        if (!localState.isAlive && player.state.isAlive) {
          localState = cloneAircraftState(player.state);
        }

        localState.health = player.state.health;
        localState.score = player.state.score;
        localState.deaths = player.state.deaths;
        localState.isAlive = player.state.isAlive;
        localState.respawnAt = player.state.respawnAt;

        if (!isReturningToSelection && localState.deaths >= MAX_DEATHS_BEFORE_RESET) {
          returnToSelection("Match ended for this run: 5 deaths reached.");
          return;
        }

        continue;
      }

      const visual = ensureRemoteVisual(player.id, player.name, player.state);
      visual.name = player.name;
      visual.target = cloneAircraftState(player.state);
      recolorRemoteVisual(visual, player.team, player.aircraftClass);
    }

    for (const [id, visual] of remoteVisuals) {
      if (!payload.players.some((player) => player.id === id)) {
        scene.remove(visual.group);
        scene.remove(visual.contrail);
        remoteVisuals.delete(id);
        combatantMeta.delete(id);
      }
    }
  });

  socket.on("roomState", (payload: RoomStatePayload) => {
    roster.clear();
    payload.players.forEach((player) => {
      roster.set(player.id, player.name);
      combatantMeta.set(player.id, {
        team: player.team,
        isBot: player.isBot,
        aircraftClass: player.aircraftClass
      });
    });
  });

  socket.on("fireEvent", (payload: FireEvent) => {
    const shooterMeta = combatantMeta.get(payload.shooterId);
    const tracerColor = shooterMeta?.team === "human"
      ? (payload.hitId ? 0x22c55e : 0xa7f3d0)
      : (payload.hitId ? 0xff7b54 : 0xfff5bf);
    createTracer(payload.origin, payload.direction, tracerColor);

    if (payload.shooterId === playerId) {
      playTone(880, 0.04, 0.05);
    }

    if (payload.hitId === playerId) {
      playTone(180, 0.13, 0.08);
      addFeed(`Hit by ${lookupName(payload.shooterId)}`);
    }
  });

  socket.on("missileEvent", (payload: MissileEvent) => {
    const shooterMeta = combatantMeta.get(payload.shooterId);
    const missileColor = shooterMeta?.team === "human" ? 0x22c55e : 0xf97316;
    createTracer(payload.origin, payload.direction, missileColor, 165, 0.28);

    if (payload.shooterId === playerId) {
      playTone(300, 0.18, 0.08);
      if (payload.targetId) {
        addFeed(`Missile hit ${lookupName(payload.targetId)}`);
      }
    }

    if (payload.targetId === playerId) {
      playTone(120, 0.28, 0.09);
      addFeed(`Missile impact from ${lookupName(payload.shooterId)}`);
    }
  });

  socket.on("damageEvent", (payload: DamageEvent) => {
    if (payload.targetId === playerId) {
      localState.health = payload.health;
    }

    if (payload.attackerId === playerId && payload.targetId !== playerId) {
      addFeed(`Hit ${lookupName(payload.targetId)} (${Math.round(payload.health)} hp)`);
      playTone(520, 0.06, 0.05);
    }
  });

  socket.on("deathEvent", (payload: DeathEvent) => {
    const destroyedState = resolveAircraftStateForEffect(payload.targetId);
    if (destroyedState) {
      spawnDestroyedAircraftEffect(payload.targetId, destroyedState);
      playDestroyedAircraftSound(destroyedState.position, payload.targetId === playerId);
    }

    addFeed(`${lookupName(payload.attackerId)} downed ${lookupName(payload.targetId)}`);

    if (payload.targetId === playerId) {
      localState.isAlive = false;
      localState.respawnAt = Date.now() + 3000;
      resetContrail(localAircraft.contrail, localAircraft.history);
      playTone(90, 0.35, 0.1);
      return;
    }

    const visual = remoteVisuals.get(payload.targetId);
    if (visual) {
      resetContrail(visual.contrail, visual.history);
    }
  });

  socket.on("respawnEvent", ({ playerId: respawnedId, state }) => {
    if (respawnedId === playerId) {
      localState = cloneAircraftState(state);
      authoritativeLocalState = cloneAircraftState(state);
      resetContrail(localAircraft.contrail, localAircraft.history);
      addFeed("Respawned and back in the fight");
      return;
    }

    const visual = remoteVisuals.get(respawnedId);
    if (visual) {
      visual.current = cloneAircraftState(state);
      visual.target = cloneAircraftState(state);
      resetContrail(visual.contrail, visual.history);
    }
  });

  socket.on("connect_error", () => {
    menuStatus.textContent = `Unable to reach the game server at ${SERVER_URL}. If you are using a phone, make sure it can access port 3001 on this computer.`;
    joinReady = false;
    startButton.disabled = false;
  });
}

function setupInput(): void {
  window.addEventListener("keydown", (event) => {
    if (event.code === "Escape") {
      event.preventDefault();
      if (playerId || joinReady) {
        returnToSelection("Returned to selection screen.");
      }
      return;
    }

    if (event.code === "Space") {
      event.preventDefault();
    }

    if (event.code === "KeyT" && !event.repeat) {
      event.preventDefault();
      cycleWeatherPreset();
      return;
    }

    keys.add(event.code);
  });

  window.addEventListener("keyup", (event) => {
    keys.delete(event.code);
  });

  window.addEventListener("blur", () => {
    keys.clear();
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    updateMobileUiState();
  });

  window.addEventListener("orientationchange", () => {
    updateMobileUiState();
  });

  weatherSelect.addEventListener("change", () => {
    applyWeatherPreset(weatherSelect.value as WeatherPresetName, world);
  });

  mobileFullscreenButton.addEventListener("click", async (event) => {
    event.preventDefault();
    await toggleGameFullscreen();
    if (isTouchDevice) {
      void requestLandscapeMode();
    }
    updateMobileUiState();
  });
  mobileFullscreenButton.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  mobileMenuButton.addEventListener("click", (event) => {
    event.preventDefault();
    if (playerId || joinReady) {
      returnToSelection("Returned to selection screen.");
    }
  });
  mobileMenuButton.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  document.addEventListener("fullscreenchange", () => {
    updateMobileUiState();
  });
  document.addEventListener("webkitfullscreenchange", () => {
    updateMobileUiState();
  });

  setupMobileControls();
  updateMobileUiState();

  startButton.addEventListener("click", async () => {
    if (joinReady) {
      return;
    }

    joinReady = true;
    isReturningToSelection = false;
    menuStatus.textContent = "";
    startButton.disabled = true;

    if (isTouchDevice) {
      void enterGameFullscreen();
    }

    applyWeatherPreset(weatherSelect.value as WeatherPresetName, world);

    if (!audioContext) {
      audioContext = new AudioContext();
      await audioContext.resume();
    }
    ensureEngineAudio();

    if (!socket.connected) {
      socket.connect();
    }

    const name = pilotInput.value.trim() || "AcePilot";
    const selectedClass = aircraftClassSelect.value as AircraftClass;
    const selectedDifficulty = botDifficultySelect.value as BotDifficulty;

    socket.emit("joinMatch", {
      name,
      roomId: "auto-match",
      aircraftClass: selectedClass,
      botDifficulty: selectedDifficulty
    }, (response) => {
      if (!response.accepted || !response.state || !response.playerId) {
        menuStatus.textContent = response.message ?? "Unable to join match right now.";
        startButton.disabled = false;
        joinReady = false;
        if (isTouchDevice) {
          void exitGameFullscreen();
        }
        return;
      }

      playerId = response.playerId;
      localState = cloneAircraftState(response.state);
      authoritativeLocalState = cloneAircraftState(response.state);
      localAircraftClass = selectedClass;
      applyAircraftTheme(localAircraft.group, localAircraft.contrail, "human", selectedClass);
      localAircraft.group.visible = true;
      menu.style.display = "none";
      updateMobileUiState();
      if (isTouchDevice) {
        void requestLandscapeMode();
      }
      startButton.disabled = false;
      joinReady = false;
      addFeed(`Joined live match as ${AIRCRAFT_PROFILES[selectedClass].label} (${selectedDifficulty} bots)`);
      playTone(640, 0.09, 0.06);
    });
  });
}

function setupMobileControls(): void {
  const preventTouchDefaults = (event: Event): void => {
    event.preventDefault();
  };

  const updateVirtualStick = (
    pad: HTMLElement,
    knob: HTMLElement,
    clientX: number,
    clientY: number,
    onChange: (normalizedX: number, normalizedY: number) => void
  ): void => {
    const rect = pad.getBoundingClientRect();
    const centerX = rect.left + (rect.width / 2);
    const centerY = rect.top + (rect.height / 2);
    const radius = rect.width * 0.36;
    const deltaX = clientX - centerX;
    const deltaY = clientY - centerY;
    const distance = Math.hypot(deltaX, deltaY);
    const clampFactor = distance > radius ? (radius / distance) : 1;
    const clampedX = deltaX * clampFactor;
    const clampedY = deltaY * clampFactor;
    const normalizedX = clamp(clampedX / radius, -1, 1);
    const normalizedY = clamp(clampedY / radius, -1, 1);
    onChange(normalizedX, normalizedY);
    knob.style.transform = `translate(calc(-50% + ${clampedX}px), calc(-50% + ${clampedY}px))`;
  };

  const resetVirtualStick = (
    knob: HTMLElement,
    onReset: () => void
  ): void => {
    onReset();
    knob.style.transform = "translate(-50%, -50%)";
  };

  const updateTouchThrottle = (clientY: number): void => {
    const rect = touchThrottle.getBoundingClientRect();
    const progress = clamp(1 - ((clientY - rect.top) / rect.height), 0, 1);
    localControls.throttle = MIN_THROTTLE + (progress * (1 - MIN_THROTTLE));
    updateTouchThrottleUi();
  };

  const updatePadPressedState = (pad: HTMLElement, isActive: boolean): void => {
    pad.classList.toggle("active", isActive);
  };

  const updateButtonPressedState = (button: HTMLButtonElement, isPressed: boolean): void => {
    button.classList.toggle("active", isPressed);
  };

  touchPad.addEventListener("pointerdown", (event) => {
    if (!isTouchDevice) {
      return;
    }
    event.preventDefault();
    touchPadPointerId = event.pointerId;
    touchPad.setPointerCapture(event.pointerId);
    updatePadPressedState(touchPad, true);
    updateVirtualStick(touchPad, touchKnob, event.clientX, event.clientY, (normalizedX, normalizedY) => {
      touchYaw = normalizedX;
      touchPitch = normalizedY;
    });
  });
  touchPad.addEventListener("pointermove", (event) => {
    if (touchPadPointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    updateVirtualStick(touchPad, touchKnob, event.clientX, event.clientY, (normalizedX, normalizedY) => {
      touchYaw = normalizedX;
      touchPitch = normalizedY;
    });
  });
  touchPad.addEventListener("pointerup", (event) => {
    if (touchPadPointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    touchPadPointerId = null;
    updatePadPressedState(touchPad, false);
    resetVirtualStick(touchKnob, () => {
      touchYaw = 0;
      touchPitch = 0;
    });
  });
  touchPad.addEventListener("pointercancel", (event) => {
    if (touchPadPointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    touchPadPointerId = null;
    updatePadPressedState(touchPad, false);
    resetVirtualStick(touchKnob, () => {
      touchYaw = 0;
      touchPitch = 0;
    });
  });
  touchPad.addEventListener("contextmenu", preventTouchDefaults);

  touchThrottle.addEventListener("pointerdown", (event) => {
    if (!isTouchDevice) {
      return;
    }
    event.preventDefault();
    touchThrottlePointerId = event.pointerId;
    touchThrottle.setPointerCapture(event.pointerId);
    touchThrottle.classList.add("active");
    updateTouchThrottle(event.clientY);
  });
  touchThrottle.addEventListener("pointermove", (event) => {
    if (touchThrottlePointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    updateTouchThrottle(event.clientY);
  });
  touchThrottle.addEventListener("pointerup", (event) => {
    if (touchThrottlePointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    touchThrottlePointerId = null;
    touchThrottle.classList.remove("active");
  });
  touchThrottle.addEventListener("pointercancel", (event) => {
    if (touchThrottlePointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    touchThrottlePointerId = null;
    touchThrottle.classList.remove("active");
  });
  touchThrottle.addEventListener("contextmenu", preventTouchDefaults);

  const bindHoldButton = (
    button: HTMLButtonElement,
    setValue: (next: boolean) => void
  ): void => {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      updateButtonPressedState(button, true);
      setValue(true);
    });
    const release = (event: Event): void => {
      event.preventDefault();
      updateButtonPressedState(button, false);
      setValue(false);
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("pointerleave", release);
    button.addEventListener("contextmenu", preventTouchDefaults);
  };

  bindHoldButton(touchFireButton, (next) => {
    touchFiring = next;
  });
  bindHoldButton(touchBoostButton, (next) => {
    touchBoost = next;
  });

  touchMissileButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    updateButtonPressedState(touchMissileButton, true);
    touchMissileQueued = true;
  });
  const releaseMissileButton = (event: Event): void => {
    event.preventDefault();
    updateButtonPressedState(touchMissileButton, false);
  };
  touchMissileButton.addEventListener("pointerup", releaseMissileButton);
  touchMissileButton.addEventListener("pointercancel", releaseMissileButton);
  touchMissileButton.addEventListener("pointerleave", releaseMissileButton);
  touchMissileButton.addEventListener("contextmenu", preventTouchDefaults);
  updateTouchThrottleUi();
}

function isLandscapeOrientation(): boolean {
  return window.matchMedia("(orientation: landscape)").matches;
}

function resetTouchControls(): void {
  touchYaw = 0;
  touchPitch = 0;
  touchFiring = false;
  touchBoost = false;
  touchMissileQueued = false;
  touchPadPointerId = null;
  touchThrottlePointerId = null;
  touchKnob.style.transform = "translate(-50%, -50%)";
  touchPad.classList.remove("active");
  touchThrottle.classList.remove("active");
  touchFireButton.classList.remove("active");
  touchBoostButton.classList.remove("active");
  touchMissileButton.classList.remove("active");
  updateTouchThrottleUi();
}

function updateMobileUiState(): void {
  const showMobileControls = isTouchDevice && Boolean(playerId);
  mobileControls.classList.toggle("visible", showMobileControls);
  orientationHint.classList.toggle("visible", showMobileControls && !isLandscapeOrientation());
  overlay.classList.toggle("mobile-minimal-hud", showMobileControls);
  mobileFullscreenButton.classList.toggle("visible", showMobileControls && canUseFullscreen());
  mobileFullscreenButton.textContent = isFullscreenActive() ? "EXIT" : "FULL";

  if (!showMobileControls) {
    resetTouchControls();
    return;
  }

  updateTouchThrottleUi();
}

function updateTouchThrottleUi(): void {
  const progress = clamp((localControls.throttle - MIN_THROTTLE) / (1 - MIN_THROTTLE), 0, 1);
  const bottomPercent = progress * 100;
  touchThrottleFill.style.height = `${bottomPercent}%`;
  touchThrottleThumb.style.bottom = `calc(${bottomPercent}% - 15px)`;
}

async function requestLandscapeMode(): Promise<void> {
  const orientationApi = window.screen.orientation as ScreenOrientation & {
    lock?: (orientation: string) => Promise<void>;
  };
  if (!orientationApi.lock) {
    return;
  }
  try {
    await orientationApi.lock("landscape");
  } catch {
    // Browser or OS may block orientation lock unless fullscreen is active.
  }
}

function canUseFullscreen(): boolean {
  const fullscreenDocument = document as FullscreenCapableDocument;
  const fullscreenElement = app as FullscreenCapableElement;
  return Boolean(document.fullscreenEnabled || fullscreenDocument.webkitExitFullscreen || fullscreenElement.webkitRequestFullscreen);
}

function isFullscreenActive(): boolean {
  const fullscreenDocument = document as FullscreenCapableDocument;
  return Boolean(document.fullscreenElement || fullscreenDocument.webkitFullscreenElement);
}

async function enterGameFullscreen(): Promise<void> {
  if (!canUseFullscreen() || isFullscreenActive()) {
    return;
  }

  const fullscreenElement = app as FullscreenCapableElement;
  try {
    if (fullscreenElement.requestFullscreen) {
      await fullscreenElement.requestFullscreen();
      return;
    }
    await fullscreenElement.webkitRequestFullscreen?.();
  } catch {
    // Some mobile browsers block fullscreen unless the interaction qualifies as a direct gesture.
  }
}

async function exitGameFullscreen(): Promise<void> {
  const fullscreenDocument = document as FullscreenCapableDocument;
  if (!isFullscreenActive()) {
    return;
  }

  try {
    if (document.exitFullscreen) {
      await document.exitFullscreen();
      return;
    }
    await fullscreenDocument.webkitExitFullscreen?.();
  } catch {
    // Ignore browser-specific fullscreen exit failures.
  }
}

async function toggleGameFullscreen(): Promise<void> {
  if (isFullscreenActive()) {
    await exitGameFullscreen();
    return;
  }
  await enterGameFullscreen();
}

function ensureRemoteVisual(id: string, name: string, state: AircraftState): AircraftVisual {
  const existing = remoteVisuals.get(id);
  if (existing) {
    return existing;
  }

  const created = createAircraftMesh(0xf97316, false);
  const visual: AircraftVisual = {
    id,
    name,
    group: created.group,
    contrail: created.contrail,
    history: created.history,
    current: cloneAircraftState(state),
    target: cloneAircraftState(state)
  };

  scene.add(visual.group);
  remoteVisuals.set(id, visual);
  return visual;
}

function cloneAircraftState(state: AircraftState): AircraftState {
  return {
    ...state,
    position: copyVec3(state.position),
    rotation: { ...state.rotation },
    velocity: copyVec3(state.velocity)
  };
}

function resolveAircraftStateForEffect(id: string): AircraftState | undefined {
  if (id === playerId) {
    return cloneAircraftState(localState);
  }

  const remoteVisual = remoteVisuals.get(id);
  if (remoteVisual) {
    return cloneAircraftState(remoteVisual.current);
  }

  const snapshotPlayer = latestSnapshot.find((player) => player.id === id);
  return snapshotPlayer ? cloneAircraftState(snapshotPlayer.state) : undefined;
}

function animate(): void {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();
  elapsedTime += dt;

  updateControls(dt);

  if (playerId) {
    updateLocalSimulation(dt, now);
  }

  updateWorld(dt, elapsedTime);
  updateRemoteVisuals(dt);
  updateDestroyedEffects(dt);
  updateCamera(dt);
  updateEngineAudio();
  updateTracers(dt);
  updateFeed(dt);
  updateHud();

  renderer.render(scene, camera);
}

function updateControls(dt: number): void {
  const keyboardPitch = axisFromKeys(["KeyS", "ArrowDown"], ["KeyW", "ArrowUp"]);
  const keyboardYaw = axisFromKeys(["KeyD", "ArrowRight"], ["KeyA", "ArrowLeft"]);

  if (keys.has("KeyR")) {
    localControls.throttle = Math.min(1, localControls.throttle + (0.38 * dt));
  }

  if (keys.has("KeyF")) {
    localControls.throttle = Math.max(MIN_THROTTLE, localControls.throttle - (0.38 * dt));
  }

  let gamepadPitch = 0;
  let gamepadYaw = 0;
  let gamepadFiring = false;
  let gamepadMissile = false;
  let gamepadBoost = false;
  let gamepadUsed = false;
  const gamepad = navigator.getGamepads?.()[0];

  if (gamepad) {
    gamepadPitch = applyDeadzone(gamepad.axes[1] ?? 0);
    gamepadYaw = applyDeadzone(gamepad.axes[0] ?? 0);
    const leftTrigger = gamepad.buttons[6]?.value ?? 0;
    const rightTrigger = gamepad.buttons[7]?.value ?? 0;
    localControls.throttle = clamp(localControls.throttle + ((rightTrigger - leftTrigger) * 0.55 * dt), MIN_THROTTLE, 1);
    gamepadFiring = Boolean(gamepad.buttons[0]?.pressed || gamepad.buttons[5]?.pressed);
    gamepadMissile = Boolean(gamepad.buttons[2]?.pressed);
    gamepadBoost = Boolean(gamepad.buttons[1]?.pressed || rightTrigger > 0.92);
    gamepadUsed = Math.abs(gamepadPitch) > 0.1 || Math.abs(gamepadYaw) > 0.1 ||
      leftTrigger > 0.12 || rightTrigger > 0.12 || gamepadFiring || gamepadBoost || gamepadMissile;
  }

  const touchUsed = Math.abs(touchPitch) > 0.05
    || Math.abs(touchYaw) > 0.05
    || touchFiring
    || touchBoost
    || touchMissileQueued
    || touchThrottlePointerId !== null;

  if (touchUsed) {
    activeInputMode = "touch";
  } else if (gamepadUsed) {
    activeInputMode = "gamepad";
  } else if (keys.size > 0) {
    activeInputMode = "keyboard";
  }

  localControls.pitch = clamp(keyboardPitch + gamepadPitch + touchPitch, -1, 1);
  // Invert yaw once here so A/left-stick-left/left-drag always turns left.
  localControls.yaw = clamp(-(keyboardYaw + gamepadYaw + touchYaw), -1, 1);
  localControls.roll = 0;
  localControls.boost = keys.has("ShiftLeft") || keys.has("ShiftRight") || gamepadBoost || touchBoost;
  localControls.firing = keys.has("Space") || gamepadFiring || touchFiring;
  missileTriggerHeld = keys.has("KeyX") || gamepadMissile || touchMissileQueued;
  updateTouchThrottleUi();
}

function updateLocalSimulation(dt: number, now: number): void {
  if (localState.isAlive) {
    localState = simulateAircraft(localState, localControls, dt, localAircraftClass);
  }

  reconcileLocalState();
  applyAircraftPose(localAircraft.group, localState);
  localAircraft.group.visible = Boolean(playerId) && localState.isAlive;
  localAircraft.contrail.visible = Boolean(playerId) && localState.isAlive;
  if (localState.isAlive) {
    updateContrail(localAircraft.contrail, localAircraft.history, localState.position, 14);
  }

  if (socket.connected && now >= nextControlsAt) {
    socket.emit("controls", { ...localControls });
    nextControlsAt = now + SEND_CONTROLS_MS;
  }

  if (socket.connected && localControls.firing && localState.isAlive && now >= nextShotAt) {
    const direction = forwardFromRotation(localState.rotation);
    socket.emit("fire", {
      origin: copyVec3(localState.position),
      direction
    });
    nextShotAt = now + FIRE_INTERVAL_MS;
  }

  if (socket.connected && missileTriggerHeld && localState.isAlive && now >= nextMissileAt) {
    socket.emit("missile");
    nextMissileAt = now + MISSILE_INTERVAL_MS;
    touchMissileQueued = false;
  }
}

function reconcileLocalState(): void {
  const errorX = authoritativeLocalState.position.x - localState.position.x;
  const errorY = authoritativeLocalState.position.y - localState.position.y;
  const errorZ = authoritativeLocalState.position.z - localState.position.z;
  const totalError = Math.sqrt((errorX * errorX) + (errorY * errorY) + (errorZ * errorZ));

  if (totalError > 0.35) {
    localState.position.x = lerp(localState.position.x, authoritativeLocalState.position.x, 0.12);
    localState.position.y = lerp(localState.position.y, authoritativeLocalState.position.y, 0.12);
    localState.position.z = lerp(localState.position.z, authoritativeLocalState.position.z, 0.12);
  }

  localState.rotation.pitch = lerp(localState.rotation.pitch, authoritativeLocalState.rotation.pitch, 0.08);
  localState.rotation.yaw = lerp(localState.rotation.yaw, authoritativeLocalState.rotation.yaw, 0.08);
  localState.rotation.roll = lerp(localState.rotation.roll, authoritativeLocalState.rotation.roll, 0.08);
}

function updateWorld(_dt: number, time: number): void {
  world.cloudLayers.forEach((cloud, index) => {
    if (!cloud.group.visible) {
      return;
    }

    cloud.group.position.x += cloud.drift * 0.05;
    cloud.group.position.y = cloud.baseY + (Math.sin(time * 0.18 + cloud.sway) * 8);
    cloud.group.position.z += Math.sin(time * 0.04 + index) * 0.14;

    if (cloud.group.position.x > 1500) {
      cloud.group.position.x = -1500;
    }
  });

  world.skyAmbientObjects.forEach((object) => {
    object.angle += object.orbitSpeed * _dt;
    const x = Math.cos(object.angle) * object.orbitRadius;
    const z = Math.sin(object.angle) * object.orbitRadius;
    const y = object.baseY + (Math.sin((time * object.bobSpeed) + object.angle) * object.bobAmp);
    object.group.position.set(x, y, z);
    object.group.rotation.y = (-object.angle + (Math.PI * 0.5));

    if (object.kind === "parachute") {
      object.group.rotation.z = Math.sin((time * 0.55) + object.angle) * 0.07;
    } else if (object.kind === "balloon") {
      object.group.rotation.z = Math.sin((time * 0.35) + object.angle) * 0.03;
      object.group.rotation.x = Math.cos((time * 0.28) + object.angle) * 0.025;
    } else if (object.kind === "bird") {
      const flap = Math.sin((time * 10.5) + (object.angle * 2.1)) * 0.52;
      const leftWing = object.group.getObjectByName("wing-left");
      const rightWing = object.group.getObjectByName("wing-right");
      if (leftWing) {
        leftWing.rotation.z = flap;
      }
      if (rightWing) {
        rightWing.rotation.z = -flap;
      }
      object.group.rotation.x = Math.sin((time * 1.4) + object.angle) * 0.06;
    } else if (object.kind === "heli") {
      const mainRotor = object.group.getObjectByName("rotor-main");
      const tailRotor = object.group.getObjectByName("rotor-tail");
      if (mainRotor) {
        mainRotor.rotation.y += 1.6;
      }
      if (tailRotor) {
        tailRotor.rotation.x += 1.9;
      }
      object.group.rotation.z = Math.sin((time * 0.9) + object.angle) * 0.07;
      object.group.rotation.x = Math.sin((time * 0.7) + object.angle) * 0.04;
    } else {
      object.group.rotation.z = Math.sin((time * 0.5) + object.angle) * 0.035;
      object.group.rotation.x = Math.sin((time * 0.35) + object.angle) * 0.02;
    }

    if ((object.kind === "plane" || object.kind === "heli") && object.contrailInterval !== undefined) {
      object.contrailTimer = (object.contrailTimer ?? object.contrailInterval) - _dt;
      if (object.contrailTimer <= 0) {
        const tangentX = -Math.sin(object.angle);
        const tangentZ = Math.cos(object.angle);
        const contrailDirection = {
          x: -tangentX,
          y: object.kind === "heli" ? 0.02 : 0.06,
          z: -tangentZ
        };
        const chance = object.kind === "plane" ? 0.45 : 0.2;
        if (Math.random() < chance) {
          createTracer(
            { x, y, z },
            contrailDirection,
            0xe2e8f0,
            object.kind === "plane" ? 75 : 42,
            object.kind === "plane" ? 0.55 : 0.35
          );
        }
        object.contrailTimer = object.contrailInterval + (Math.random() * object.contrailInterval);
      }
    }
  });

  world.sunGlow.scale.setScalar(1 + (Math.sin(time * 0.35) * 0.05));
}

function updateRemoteVisuals(dt: number): void {
  for (const visual of remoteVisuals.values()) {
    visual.current.position.x = lerp(visual.current.position.x, visual.target.position.x, dt * REMOTE_LERP);
    visual.current.position.y = lerp(visual.current.position.y, visual.target.position.y, dt * REMOTE_LERP);
    visual.current.position.z = lerp(visual.current.position.z, visual.target.position.z, dt * REMOTE_LERP);
    visual.current.rotation.pitch = lerp(visual.current.rotation.pitch, visual.target.rotation.pitch, dt * REMOTE_LERP);
    visual.current.rotation.yaw = lerp(visual.current.rotation.yaw, visual.target.rotation.yaw, dt * REMOTE_LERP);
    visual.current.rotation.roll = lerp(visual.current.rotation.roll, visual.target.rotation.roll, dt * REMOTE_LERP);
    visual.current.isAlive = visual.target.isAlive;

    visual.group.visible = visual.current.isAlive;
    visual.contrail.visible = visual.current.isAlive;

    applyAircraftPose(visual.group, visual.current);
    if (visual.current.isAlive) {
      updateContrail(visual.contrail, visual.history, visual.current.position, 10);
    }
  }
}

function updateCamera(dt: number): void {
  if (!playerId) {
    camera.position.lerp(new THREE.Vector3(0, 105, -180), dt * 1.3);
    camera.lookAt(0, 75, 0);
    return;
  }

  const forward = forwardFromRotation(localState.rotation);
  const followOffset = scaleVec3(forward, -52);
  const targetPosition = new THREE.Vector3(
    localState.position.x + followOffset.x,
    localState.position.y + 19,
    localState.position.z + followOffset.z
  );

  camera.position.lerp(targetPosition, dt * 2.75);
  camera.lookAt(localState.position.x, localState.position.y + 5, localState.position.z);
}

function updateTracers(dt: number): void {
  for (let index = tracers.length - 1; index >= 0; index -= 1) {
    const tracer = tracers[index];
    tracer.life -= dt;

    if (tracer.life <= 0) {
      scene.remove(tracer.line);
      tracers.splice(index, 1);
    }
  }
}

function updateFeed(dt: number): void {
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    feed[index].life -= dt;

    if (feed[index].life <= 0) {
      feed.splice(index, 1);
    }
  }
}

function computeTargetAssist(): TargetAssistInfo | undefined {
  if (!playerId || !localState.isAlive) {
    return undefined;
  }

  const localForward = forwardFromRotation(localState.rotation);
  const localPosition = localState.position;
  let best: TargetAssistInfo | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of latestSnapshot) {
    if (candidate.id === playerId || !candidate.state.isAlive) {
      continue;
    }

    const delta = {
      x: candidate.state.position.x - localPosition.x,
      y: candidate.state.position.y - localPosition.y,
      z: candidate.state.position.z - localPosition.z
    };
    const distanceSq = dotVec3(delta, delta);
    if (distanceSq <= 0.0001) {
      continue;
    }
    const distance = Math.sqrt(distanceSq);
    const directionToTarget = {
      x: delta.x / distance,
      y: delta.y / distance,
      z: delta.z / distance
    };
    const aimDot = dotVec3(localForward, directionToTarget);

    const targetForward = forwardFromRotation(candidate.state.rotation);
    const targetToAttacker = {
      x: -directionToTarget.x,
      y: -directionToTarget.y,
      z: -directionToTarget.z
    };
    const backsideDot = dotVec3(targetForward, targetToAttacker);
    const missileLocked = aimDot > CLIENT_MISSILE_LOCK_DOT && backsideDot < CLIENT_MISSILE_BACKSIDE_DOT;

    // Bias toward easier targets: on-axis, close, and bots.
    let score = distance + ((1 - aimDot) * 260);
    if (candidate.isBot) {
      score -= 180;
    }
    if (missileLocked) {
      score -= 95;
    }

    if (score >= bestScore) {
      continue;
    }

    const projected = new THREE.Vector3(
      candidate.state.position.x,
      candidate.state.position.y + 6,
      candidate.state.position.z
    ).project(camera);
    const screenX = (projected.x * 0.5 + 0.5) * window.innerWidth;
    const screenY = ((-projected.y) * 0.5 + 0.5) * window.innerHeight;
    const onScreen = (
      projected.z > -1
      && projected.z < 1
      && projected.x >= -1
      && projected.x <= 1
      && projected.y >= -1
      && projected.y <= 1
    );

    best = {
      id: candidate.id,
      name: candidate.name,
      isBot: candidate.isBot,
      distance,
      aimDot,
      missileLocked,
      screenX,
      screenY,
      onScreen
    };
    bestScore = score;
  }

  return best;
}

function updateTargetIndicator(target: TargetAssistInfo | undefined): void {
  if (!target || !playerId || !localState.isAlive) {
    targetIndicator.style.display = "none";
    targetIndicator.classList.remove("locked");
    return;
  }

  targetIndicator.style.display = "block";
  targetIndicator.classList.toggle("locked", target.missileLocked);
  const badge = target.isBot ? "BOT" : "PILOT";
  const lockText = target.missileLocked ? "LOCK" : "TRACK";
  const alignment = Math.round(Math.max(0, target.aimDot) * 100);
  targetIndicator.innerHTML = `
    <strong>${lockText}</strong>
    <span>[${badge}] ${target.name}</span>
    <span>${Math.round(target.distance)}m | align ${alignment}%</span>
  `;

  const clampedX = clamp(target.screenX, TARGET_INDICATOR_MARGIN_PX, window.innerWidth - TARGET_INDICATOR_MARGIN_PX);
  const clampedY = clamp(target.screenY, TARGET_INDICATOR_MARGIN_PX, window.innerHeight - TARGET_INDICATOR_MARGIN_PX);
  targetIndicator.style.left = `${clampedX}px`;
  targetIndicator.style.top = `${clampedY}px`;
  targetIndicator.style.opacity = target.onScreen ? "1" : "0.8";
}

function updateHud(): void {
  const isMobileMinimal = isTouchDevice && Boolean(playerId);
  const missileReadyIn = Math.max(0, Math.ceil((nextMissileAt - performance.now()) / 1000));
  const healthText = playerId ? Math.round(localState.health).toString() : "-";
  const killsText = playerId ? localState.score.toString() : "0";
  const deathsText = playerId ? localState.deaths.toString() : "0";
  const missileStatusText = playerId ? (missileReadyIn > 0 ? "M:NR" : "M:R") : "M:NR";
  const targetAssist = computeTargetAssist();

  updateTargetIndicator(targetAssist);
  statsPanel.classList.toggle("stats-horizontal", isMobileMinimal);
  statsPanel.classList.toggle("stats-vertical", !isMobileMinimal);
  statsPanel.innerHTML = isMobileMinimal
    ? `
      <span>H:${healthText}</span>
      <span>K:${killsText}</span>
      <span>D:${deathsText}</span>
      <span>${missileStatusText}</span>
    `
    : `
      <span>H:${healthText}</span>
      <span>K:${killsText}</span>
      <span>D:${deathsText}</span>
      <span>${missileStatusText}</span>
    `;

  if (isMobileMinimal) {
    scoreboardPanel.innerHTML = "";
  } else {
    const topPlayers = [...latestSnapshot]
      .sort((left, right) => {
        if (right.state.score === left.state.score) {
          return left.state.deaths - right.state.deaths;
        }

        return right.state.score - left.state.score;
      })
      .slice(0, 5);

    scoreboardPanel.innerHTML = topPlayers.map((player, index) => {
      const marker = player.id === playerId ? ">" : "";
      return `<span>${marker}${index + 1}.${player.name} ${player.state.score}/${player.state.deaths}</span>`;
    }).join("") || '<span class="muted">Waiting...</span>';
  }

  feedPanel.innerHTML = "";
  centerPanel.innerHTML = "";
}

function applyAircraftPose(group: THREE.Group, state: AircraftState): void {
  group.position.set(state.position.x, state.position.y, state.position.z);
  group.rotation.order = "YXZ";
  group.rotation.y = state.rotation.yaw;
  group.rotation.x = state.rotation.pitch;
  group.rotation.z = state.rotation.roll;
}

function updateContrail(line: THREE.Line, history: THREE.Vector3[], position: Vec3, maxPoints: number): void {
  history.unshift(new THREE.Vector3(position.x, position.y, position.z));

  if (history.length > maxPoints) {
    history.length = maxPoints;
  }

  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry().setFromPoints(history);
}

function createTracer(
  origin: Vec3,
  direction: Vec3,
  color: number,
  length = 90,
  lifetime = 0.14
): void {
  const start = new THREE.Vector3(origin.x, origin.y, origin.z);
  const end = start.clone().add(new THREE.Vector3(direction.x, direction.y, direction.z).multiplyScalar(length));
  const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.88 });
  const line = new THREE.Line(geometry, material);
  scene.add(line);
  tracers.push({ line, life: lifetime });
}

function addFeed(text: string): void {
  feed.unshift({ text, life: 5 });
  feed.splice(6);
}

function lookupName(id: string): string {
  return roster.get(id) ?? (id ? `Pilot-${id.slice(0, 4)}` : "Pilot");
}

function createNoiseBuffer(context: AudioContext, duration = 1): AudioBuffer {
  const sampleRate = context.sampleRate;
  const frameCount = Math.max(1, Math.floor(sampleRate * duration));
  const buffer = context.createBuffer(1, frameCount, sampleRate);
  const channel = buffer.getChannelData(0);

  for (let index = 0; index < frameCount; index += 1) {
    channel[index] = (Math.random() * 2) - 1;
  }

  return buffer;
}

function playDestroyedAircraftSound(position: Vec3, isLocalTarget = false): void {
  if (!audioContext) {
    return;
  }
  if (audioContext.state === "suspended") {
    void audioContext.resume();
  }

  const distance = isLocalTarget || !playerId
    ? 0
    : Math.hypot(
      position.x - localState.position.x,
      position.y - localState.position.y,
      position.z - localState.position.z
    );
  const distanceMix = isLocalTarget
    ? 1
    : clamp(1 - (distance / 950), 0.08, 0.88);

  if (distanceMix <= 0.08 && !isLocalTarget) {
    return;
  }

  const now = audioContext.currentTime;
  const impact = audioContext.createOscillator();
  const rumble = audioContext.createOscillator();
  const debrisNoise = audioContext.createBufferSource();
  const crackleNoise = audioContext.createBufferSource();
  const impactFilter = audioContext.createBiquadFilter();
  const debrisFilter = audioContext.createBiquadFilter();
  const crackleFilter = audioContext.createBiquadFilter();
  const impactGain = audioContext.createGain();
  const rumbleGain = audioContext.createGain();
  const debrisGain = audioContext.createGain();
  const crackleGain = audioContext.createGain();
  const masterGain = audioContext.createGain();

  impact.type = "sawtooth";
  rumble.type = "triangle";
  impact.frequency.setValueAtTime(220, now);
  impact.frequency.exponentialRampToValueAtTime(42, now + 0.62);
  rumble.frequency.setValueAtTime(72, now);
  rumble.frequency.exponentialRampToValueAtTime(24, now + 1);

  debrisNoise.buffer = createNoiseBuffer(audioContext, 1.25);
  crackleNoise.buffer = createNoiseBuffer(audioContext, 0.48);

  impactFilter.type = "lowpass";
  impactFilter.frequency.setValueAtTime(860, now);
  impactFilter.frequency.exponentialRampToValueAtTime(180, now + 0.7);
  impactFilter.Q.value = 0.8;

  debrisFilter.type = "bandpass";
  debrisFilter.frequency.setValueAtTime(540, now);
  debrisFilter.frequency.exponentialRampToValueAtTime(240, now + 0.8);
  debrisFilter.Q.value = 0.7;

  crackleFilter.type = "highpass";
  crackleFilter.frequency.setValueAtTime(1500, now);
  crackleFilter.Q.value = 0.65;

  impactGain.gain.setValueAtTime(0.0001, now);
  impactGain.gain.exponentialRampToValueAtTime(0.18 * distanceMix, now + 0.02);
  impactGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.62);

  rumbleGain.gain.setValueAtTime(0.0001, now);
  rumbleGain.gain.exponentialRampToValueAtTime(0.16 * distanceMix, now + 0.04);
  rumbleGain.gain.exponentialRampToValueAtTime(0.0001, now + 1);

  debrisGain.gain.setValueAtTime(0.0001, now);
  debrisGain.gain.exponentialRampToValueAtTime(0.22 * distanceMix, now + 0.03);
  debrisGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);

  crackleGain.gain.setValueAtTime(0.0001, now);
  crackleGain.gain.exponentialRampToValueAtTime(0.1 * distanceMix, now + 0.015);
  crackleGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.38);

  masterGain.gain.setValueAtTime(0.9, now);

  impact.connect(impactFilter);
  impactFilter.connect(impactGain);
  impactGain.connect(masterGain);

  rumble.connect(rumbleGain);
  rumbleGain.connect(masterGain);

  debrisNoise.connect(debrisFilter);
  debrisFilter.connect(debrisGain);
  debrisGain.connect(masterGain);

  crackleNoise.connect(crackleFilter);
  crackleFilter.connect(crackleGain);
  crackleGain.connect(masterGain);

  masterGain.connect(audioContext.destination);

  impact.start(now);
  rumble.start(now);
  debrisNoise.start(now);
  crackleNoise.start(now);

  impact.stop(now + 0.7);
  rumble.stop(now + 1.05);
  debrisNoise.stop(now + 0.95);
  crackleNoise.stop(now + 0.42);
}

function playTone(frequency: number, duration: number, volume: number): void {
  if (!audioContext) {
    return;
  }
  if (audioContext.state === "suspended") {
    void audioContext.resume();
  }

  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const filter = audioContext.createBiquadFilter();
  const gain = audioContext.createGain();
  const noise = audioContext.createBufferSource();
  const noiseFilter = audioContext.createBiquadFilter();
  const noiseGain = audioContext.createGain();

  oscillator.type = frequency < 160 ? "triangle" : "sawtooth";
  oscillator.frequency.setValueAtTime(frequency * 1.15, now);
  oscillator.frequency.exponentialRampToValueAtTime(Math.max(50, frequency * 0.82), now + duration);

  filter.type = "bandpass";
  filter.frequency.setValueAtTime(Math.max(180, frequency * 1.2), now);
  filter.Q.value = 1.2;

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  noise.buffer = createNoiseBuffer(audioContext, duration + 0.04);
  noise.loop = false;
  noiseFilter.type = "highpass";
  noiseFilter.frequency.setValueAtTime(Math.max(250, frequency * 0.7), now);
  noiseGain.gain.setValueAtTime(Math.max(0.0002, volume * 0.4), now);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(audioContext.destination);

  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(audioContext.destination);

  oscillator.start(now);
  noise.start(now);
  oscillator.stop(now + duration);
  noise.stop(now + duration + 0.02);
}

function ensureEngineAudio(): void {
  if (!audioContext || engineAudio) {
    return;
  }

  const baseOscillator = audioContext.createOscillator();
  const harmonicOscillator = audioContext.createOscillator();
  const lfoOscillator = audioContext.createOscillator();
  const noiseSource = audioContext.createBufferSource();
  const toneFilter = audioContext.createBiquadFilter();
  const noiseFilter = audioContext.createBiquadFilter();
  const toneGain = audioContext.createGain();
  const noiseGain = audioContext.createGain();
  const lfoGain = audioContext.createGain();
  const masterGain = audioContext.createGain();

  baseOscillator.type = "sawtooth";
  harmonicOscillator.type = "triangle";
  lfoOscillator.type = "sine";

  baseOscillator.frequency.value = 92;
  harmonicOscillator.frequency.value = 186;
  lfoOscillator.frequency.value = 5;

  toneFilter.type = "lowpass";
  toneFilter.frequency.value = 920;
  toneFilter.Q.value = 0.85;

  noiseFilter.type = "highpass";
  noiseFilter.frequency.value = 1200;
  noiseFilter.Q.value = 0.7;

  toneGain.gain.value = 0.0001;
  noiseGain.gain.value = 0.0001;
  lfoGain.gain.value = 3.2;
  masterGain.gain.value = 0.0001;

  noiseSource.buffer = createNoiseBuffer(audioContext, 2);
  noiseSource.loop = true;

  baseOscillator.connect(toneFilter);
  harmonicOscillator.connect(toneFilter);
  toneFilter.connect(toneGain);
  toneGain.connect(masterGain);

  noiseSource.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(masterGain);

  lfoOscillator.connect(lfoGain);
  lfoGain.connect(baseOscillator.frequency);
  lfoGain.connect(harmonicOscillator.detune);

  masterGain.connect(audioContext.destination);

  baseOscillator.start();
  harmonicOscillator.start();
  lfoOscillator.start();
  noiseSource.start();

  engineAudio = {
    baseOscillator,
    harmonicOscillator,
    lfoOscillator,
    noiseSource,
    toneFilter,
    noiseFilter,
    toneGain,
    noiseGain,
    lfoGain,
    masterGain
  };
}

function stopEngineAudio(): void {
  if (!engineAudio) {
    return;
  }

  const now = audioContext?.currentTime ?? 0;
  engineAudio.masterGain.gain.cancelScheduledValues(now);
  engineAudio.masterGain.gain.setValueAtTime(engineAudio.masterGain.gain.value, now);
  engineAudio.masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  engineAudio.baseOscillator.stop(now + 0.14);
  engineAudio.harmonicOscillator.stop(now + 0.14);
  engineAudio.lfoOscillator.stop(now + 0.14);
  engineAudio.noiseSource.stop(now + 0.14);
  engineAudio.baseOscillator.disconnect();
  engineAudio.harmonicOscillator.disconnect();
  engineAudio.lfoOscillator.disconnect();
  engineAudio.noiseSource.disconnect();
  engineAudio.toneFilter.disconnect();
  engineAudio.noiseFilter.disconnect();
  engineAudio.toneGain.disconnect();
  engineAudio.noiseGain.disconnect();
  engineAudio.lfoGain.disconnect();
  engineAudio.masterGain.disconnect();
  engineAudio = null;
}

function updateEngineAudio(): void {
  if (!audioContext || !engineAudio) {
    return;
  }

  const now = audioContext.currentTime;
  const hasLiveAircraft = Boolean(playerId) && localState.isAlive;
  const throttleFactor = localControls.throttle;
  const speedFactor = clamp(localState.speed / 250, 0, 1);
  const boostFactor = localControls.boost ? 1 : 0;
  const targetBaseFrequency = hasLiveAircraft
    ? 62 + (throttleFactor * 52) + (speedFactor * 86) + (boostFactor * 18)
    : 58;
  const targetHarmonicFrequency = targetBaseFrequency * 2.03;
  const targetToneGain = hasLiveAircraft
    ? 0.018 + (throttleFactor * 0.03) + (speedFactor * 0.017) + (boostFactor * 0.008)
    : 0.0001;
  const targetNoiseGain = hasLiveAircraft
    ? 0.002 + (speedFactor * 0.018) + (boostFactor * 0.01)
    : 0.0001;
  const targetMasterGain = hasLiveAircraft ? 0.82 : 0.0001;
  const targetToneFilter = hasLiveAircraft
    ? 520 + (throttleFactor * 820) + (speedFactor * 1100)
    : 420;
  const targetNoiseFilter = hasLiveAircraft ? 850 + (speedFactor * 1900) : 700;
  const targetLfoFrequency = hasLiveAircraft ? 4.5 + (speedFactor * 7.5) : 3.8;
  const targetLfoDepth = hasLiveAircraft ? 2 + (throttleFactor * 6) : 1.2;

  engineAudio.baseOscillator.frequency.setTargetAtTime(targetBaseFrequency, now, 0.09);
  engineAudio.harmonicOscillator.frequency.setTargetAtTime(targetHarmonicFrequency, now, 0.09);
  engineAudio.toneFilter.frequency.setTargetAtTime(targetToneFilter, now, 0.1);
  engineAudio.noiseFilter.frequency.setTargetAtTime(targetNoiseFilter, now, 0.1);
  engineAudio.toneGain.gain.setTargetAtTime(targetToneGain, now, 0.12);
  engineAudio.noiseGain.gain.setTargetAtTime(targetNoiseGain, now, 0.11);
  engineAudio.masterGain.gain.setTargetAtTime(targetMasterGain, now, 0.13);
  engineAudio.lfoOscillator.frequency.setTargetAtTime(targetLfoFrequency, now, 0.14);
  engineAudio.lfoGain.gain.setTargetAtTime(targetLfoDepth, now, 0.14);
}

function axisFromKeys(positiveKeys: string[], negativeKeys: string[]): number {
  return (positiveKeys.some((code) => keys.has(code)) ? 1 : 0) +
    (negativeKeys.some((code) => keys.has(code)) ? -1 : 0);
}

function applyDeadzone(value: number, deadzone = 0.18): number {
  if (Math.abs(value) < deadzone) {
    return 0;
  }

  return value;
}

function cycleWeatherPreset(): void {
  const nextIndex = (WEATHER_ORDER.indexOf(currentWeather) + 1) % WEATHER_ORDER.length;
  applyWeatherPreset(WEATHER_ORDER[nextIndex], world);
  addFeed(`Weather changed to ${WEATHER_PRESETS[WEATHER_ORDER[nextIndex]].label}`);
}

function returnToSelection(message: string): void {
  if (isReturningToSelection) {
    return;
  }

  isReturningToSelection = true;
  joinReady = false;
  startButton.disabled = false;
  if (isTouchDevice) {
    void exitGameFullscreen();
  }
  menu.style.display = "flex";
  menuStatus.textContent = message;
  updateMobileUiState();

  keys.clear();
  nextControlsAt = 0;
  nextShotAt = 0;
  nextMissileAt = 0;
  missileTriggerHeld = false;
  resetTouchControls();
  feed.length = 0;
  latestSnapshot = [];
  roster.clear();
  combatantMeta.clear();

  for (const visual of remoteVisuals.values()) {
    scene.remove(visual.group);
    scene.remove(visual.contrail);
  }
  remoteVisuals.clear();
  clearDestroyedEffects();

  localAircraft.group.visible = false;
  localAircraft.contrail.visible = false;
  resetContrail(localAircraft.contrail, localAircraft.history);
  localState = createAircraftState(0, localAircraftClass);
  authoritativeLocalState = createAircraftState(0, localAircraftClass);
  playerId = "";
  updateMobileUiState();

  if (socket.connected) {
    socket.disconnect();
  }
  stopEngineAudio();

  isReturningToSelection = false;
}
