export type Vec3 = {
  x: number;
  y: number;
  z: number;
};

export type Rotation = {
  pitch: number;
  yaw: number;
  roll: number;
};

export type ControlState = {
  pitch: number;
  yaw: number;
  roll: number;
  throttle: number;
  boost: boolean;
  firing: boolean;
};

export type AircraftClass = "fighter" | "interceptor" | "heavy";
export type Team = "human" | "bot";
export type BotDifficulty = "easy" | "medium" | "hard";

export type AircraftState = {
  position: Vec3;
  rotation: Rotation;
  velocity: Vec3;
  speed: number;
  health: number;
  ammoHeat: number;
  isAlive: boolean;
  respawnAt: number;
  score: number;
  deaths: number;
};

export type SnapshotPlayer = {
  id: string;
  name: string;
  team: Team;
  isBot: boolean;
  aircraftClass: AircraftClass;
  state: AircraftState;
};

export const GAME_BOUNDS = 1800;
export const FLOOR_HEIGHT = 14;
export const RESPAWN_DELAY_MS = 3000;
export const FIRE_INTERVAL_MS = 120;
export const FIRE_DAMAGE = 12;
export const FIRE_RANGE = 360;
export const HIT_RADIUS = 9;
export const MISSILE_INTERVAL_MS = 3000;
export const MISSILE_DAMAGE = 100;
export const MISSILE_RANGE = 680;
export const MISSILE_SPLASH_RADIUS = 170;
export const MISSILE_BACKSIDE_DOT = -0.55;

export type AircraftProfile = {
  label: string;
  maxHealth: number;
  minSpeed: number;
  maxSpeed: number;
  boostSpeed: number;
  throttleAcceleration: number;
  drag: number;
  pitchSpeed: number;
  yawSpeed: number;
  rollSpeed: number;
  climbAssist: number;
};

export const AIRCRAFT_PROFILES: Record<AircraftClass, AircraftProfile> = {
  fighter: {
    label: "Fighter",
    maxHealth: 100,
    minSpeed: 30,
    maxSpeed: 168,
    boostSpeed: 232,
    throttleAcceleration: 42,
    drag: 0.08,
    pitchSpeed: 1.24,
    yawSpeed: 1.1,
    rollSpeed: 1.9,
    climbAssist: 0.19
  },
  interceptor: {
    label: "Interceptor",
    maxHealth: 82,
    minSpeed: 36,
    maxSpeed: 196,
    boostSpeed: 262,
    throttleAcceleration: 50,
    drag: 0.075,
    pitchSpeed: 1.36,
    yawSpeed: 1.2,
    rollSpeed: 2.2,
    climbAssist: 0.2
  },
  heavy: {
    label: "Heavy",
    maxHealth: 138,
    minSpeed: 24,
    maxSpeed: 144,
    boostSpeed: 205,
    throttleAcceleration: 34,
    drag: 0.09,
    pitchSpeed: 1.02,
    yawSpeed: 0.92,
    rollSpeed: 1.55,
    climbAssist: 0.16
  }
} as const;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function copyVec3(value: Vec3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scaleVec3(value: Vec3, scalar: number): Vec3 {
  return { x: value.x * scalar, y: value.y * scalar, z: value.z * scalar };
}

export function lengthVec3(value: Vec3): number {
  return Math.sqrt((value.x * value.x) + (value.y * value.y) + (value.z * value.z));
}

export function normalizeVec3(value: Vec3): Vec3 {
  const length = lengthVec3(value) || 1;
  return scaleVec3(value, 1 / length);
}

export function dotVec3(a: Vec3, b: Vec3): number {
  return (a.x * b.x) + (a.y * b.y) + (a.z * b.z);
}

export function createDefaultControls(): ControlState {
  return {
    pitch: 0,
    yaw: 0,
    roll: 0,
    throttle: 0.65,
    boost: false,
    firing: false
  };
}

export function createAircraftState(seed = 0, aircraftClass: AircraftClass = "fighter"): AircraftState {
  const profile = AIRCRAFT_PROFILES[aircraftClass];
  return {
    position: vec3(seed * 60, 120 + (seed * 10), seed * -80),
    rotation: { pitch: 0, yaw: Math.PI, roll: 0 },
    velocity: vec3(0, 0, -40),
    speed: lerp(profile.minSpeed, profile.maxSpeed, 0.25),
    health: profile.maxHealth,
    ammoHeat: 0,
    isAlive: true,
    respawnAt: 0,
    score: 0,
    deaths: 0
  };
}

export function forwardFromRotation(rotation: Rotation): Vec3 {
  const cosPitch = Math.cos(rotation.pitch);
  return normalizeVec3({
    x: Math.sin(rotation.yaw) * cosPitch,
    y: -Math.sin(rotation.pitch),
    z: Math.cos(rotation.yaw) * cosPitch
  });
}

export function clampToBounds(position: Vec3): Vec3 {
  return {
    x: clamp(position.x, -GAME_BOUNDS, GAME_BOUNDS),
    y: clamp(position.y, FLOOR_HEIGHT, 800),
    z: clamp(position.z, -GAME_BOUNDS, GAME_BOUNDS)
  };
}

export function simulateAircraft(
  state: AircraftState,
  controls: ControlState,
  dt: number,
  aircraftClass: AircraftClass = "fighter"
): AircraftState {
  const profile = AIRCRAFT_PROFILES[aircraftClass];
  const next = {
    ...state,
    position: copyVec3(state.position),
    rotation: { ...state.rotation },
    velocity: copyVec3(state.velocity)
  };

  if (!next.isAlive) {
    return next;
  }

  next.rotation.pitch = clamp(
    next.rotation.pitch + (controls.pitch * profile.pitchSpeed * dt),
    -0.75,
    0.75
  );
  next.rotation.yaw += controls.yaw * profile.yawSpeed * dt;
  next.rotation.roll = clamp(
    next.rotation.roll + (controls.roll * profile.rollSpeed * dt),
    -1.15,
    1.15
  );

  const targetSpeed = controls.boost
    ? profile.boostSpeed
    : lerp(profile.minSpeed, profile.maxSpeed, clamp(controls.throttle, 0, 1));
  next.speed = lerp(next.speed, targetSpeed, clamp(profile.throttleAcceleration * dt * 0.04, 0, 1));

  const forward = forwardFromRotation(next.rotation);
  const lift = Math.max(0, next.speed * profile.climbAssist * Math.cos(next.rotation.roll));
  next.velocity = scaleVec3(forward, next.speed);
  next.velocity.y += lift * dt * 10;
  next.velocity.y -= 9 * dt;
  next.velocity = scaleVec3(next.velocity, 1 - (profile.drag * dt));
  next.position = clampToBounds(addVec3(next.position, scaleVec3(next.velocity, dt)));

  if (next.position.y <= FLOOR_HEIGHT + 1) {
    next.position.y = FLOOR_HEIGHT + 1;
    next.rotation.pitch = clamp(next.rotation.pitch, -0.05, 0.4);
  }

  next.ammoHeat = Math.max(0, next.ammoHeat - (15 * dt));
  return next;
}

export function resetAircraft(
  state: AircraftState,
  seed = 0,
  aircraftClass: AircraftClass = "fighter"
): AircraftState {
  const reset = createAircraftState(seed, aircraftClass);
  reset.score = state.score;
  reset.deaths = state.deaths;
  return reset;
}

export function pointAlongRay(origin: Vec3, direction: Vec3, distance: number): Vec3 {
  return addVec3(origin, scaleVec3(normalizeVec3(direction), distance));
}

export function distancePointToRay(point: Vec3, origin: Vec3, direction: Vec3): number {
  const normalized = normalizeVec3(direction);
  const toPoint = subVec3(point, origin);
  const projected = dotVec3(toPoint, normalized);
  const clampedProjection = Math.max(0, Math.min(FIRE_RANGE, projected));
  const closest = addVec3(origin, scaleVec3(normalized, clampedProjection));
  return lengthVec3(subVec3(point, closest));
}
