import { createServer } from "node:http";
import { Server } from "socket.io";

import {
  AIRCRAFT_PROFILES,
  type AircraftClass,
  FIRE_DAMAGE,
  FIRE_INTERVAL_MS,
  FIRE_RANGE,
  HIT_RADIUS,
  MISSILE_DAMAGE,
  MISSILE_INTERVAL_MS,
  MISSILE_RANGE,
  MISSILE_SPLASH_RADIUS,
  RESPAWN_DELAY_MS,
  type BotDifficulty,
  type Team,
  clamp,
  createAircraftState,
  createDefaultControls,
  distancePointToRay,
  dotVec3,
  forwardFromRotation,
  resetAircraft,
  simulateAircraft,
  subVec3
} from "../../shared/game";
import type { AircraftState, ControlState } from "../../shared/game";
import type {
  ClientToServerEvents,
  FireEvent,
  MissileEvent,
  RoomStatePayload,
  ServerToClientEvents,
  SnapshotPayload,
  WelcomePayload
} from "../../shared/protocol";

type ConnectedPlayer = {
  id: string;
  name: string;
  isBot: boolean;
  team: Team;
  aircraftClass: AircraftClass;
  state: AircraftState;
  controls: ControlState;
  lastShotAt: number;
  lastMissileAt: number;
  spawnProtectedUntil: number;
  seed: number;
};

type GameInstance = {
  id: string;
  players: Map<string, ConnectedPlayer>;
  nextBotSerial: number;
  botDifficulty: BotDifficulty;
  isDraining: boolean;
  createdAt: number;
  drainStartedAt?: number;
};

const port = Number(process.env.PORT ?? 3001);
const tickRate = 30;
const tickMs = 1000 / tickRate;
const tickSeconds = tickMs / 1000;
const INSTANCE_ROOM_PREFIX = "public-airspace";
const MAX_HUMAN_PLAYERS_PER_INSTANCE = 300;
const TARGET_POPULATION_WITH_BOTS = 100;
const BOT_ACTIVE_HUMAN_THRESHOLD = 100;
const SPAWN_PROTECTION_MS = 4500;
const HUMAN_HEALTH_REGEN_PER_SECOND = 4;
const MAX_MIGRATIONS_PER_TICK = 10;
const HUMAN_AIM_ASSIST_CONE_DOT = 0.75;
const HUMAN_AIM_ASSIST_MAX_RAY_DISTANCE = HIT_RADIUS * 4.5;
const HUMAN_AIM_ASSIST_BOT_PRIORITY = 22;
const HUMAN_MISSILE_LOCK_DOT = 0.05;
const HUMAN_MISSILE_BACKSIDE_DOT = 0.65;

const instances = new Map<string, GameInstance>();
const playerInstanceBySocket = new Map<string, string>();
let nextInstanceSerial = 1;

const httpServer = createServer();
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: "*"
  }
});

function sanitizeText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 18) : fallback;
}

function sanitizeAircraftClass(value: string | undefined): AircraftClass {
  if (value === "interceptor" || value === "heavy") {
    return value;
  }
  return "fighter";
}

function sanitizeBotDifficulty(value: string | undefined): BotDifficulty {
  if (value === "easy" || value === "hard") {
    return value;
  }
  return "medium";
}

function normalizeAngle(value: number): number {
  let angle = value;
  while (angle > Math.PI) {
    angle -= Math.PI * 2;
  }
  while (angle < -Math.PI) {
    angle += Math.PI * 2;
  }
  return angle;
}

function sanitizeControls(payload: ControlState): ControlState {
  return {
    pitch: clamp(payload.pitch || 0, -1, 1),
    yaw: clamp(payload.yaw || 0, -1, 1),
    roll: clamp(payload.roll || 0, -1, 1),
    throttle: clamp(payload.throttle || 0.65, 0.15, 1),
    boost: Boolean(payload.boost),
    firing: Boolean(payload.firing)
  };
}

function copyState(state: AircraftState): AircraftState {
  return {
    ...state,
    position: { ...state.position },
    rotation: { ...state.rotation },
    velocity: { ...state.velocity }
  };
}

function createInstance(): GameInstance {
  const instanceId = `${INSTANCE_ROOM_PREFIX}-${nextInstanceSerial}`;
  nextInstanceSerial += 1;

  const instance: GameInstance = {
    id: instanceId,
    players: new Map<string, ConnectedPlayer>(),
    nextBotSerial: 1,
    botDifficulty: "medium",
    isDraining: false,
    createdAt: Date.now()
  };
  instances.set(instanceId, instance);
  return instance;
}

function ensureAtLeastOneInstance(): GameInstance {
  const existing = [...instances.values()][0];
  return existing ?? createInstance();
}

function allHumans(instance: GameInstance): ConnectedPlayer[] {
  return [...instance.players.values()].filter((player) => !player.isBot);
}

function allBots(instance: GameInstance): ConnectedPlayer[] {
  return [...instance.players.values()].filter((player) => player.isBot);
}

function totalHumans(): number {
  let total = 0;
  for (const instance of instances.values()) {
    total += allHumans(instance).length;
  }
  return total;
}

function applyRunwaySpawn(state: AircraftState, seed: number, aircraftClass: AircraftClass): AircraftState {
  const profile = AIRCRAFT_PROFILES[aircraftClass];
  const lane = seed % 4;
  const row = Math.floor(seed / 4) % 2;
  state.position.x = -70 + (lane * 45);
  state.position.y = 22;
  state.position.z = -300 + (row * 240);
  state.rotation.pitch = 0;
  state.rotation.yaw = 0;
  state.rotation.roll = 0;
  state.velocity.x = 0;
  state.velocity.y = 0;
  state.velocity.z = profile.minSpeed + 8;
  state.speed = profile.minSpeed + 16;
  state.health = profile.maxHealth;
  return state;
}

function seededNoise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function applyBotSpawn(state: AircraftState, seed: number, aircraftClass: AircraftClass): AircraftState {
  const profile = AIRCRAFT_PROFILES[aircraftClass];
  const ringIndex = seed % 24;
  const ringBand = Math.floor(seed / 24) % 6;
  const angleJitter = (seededNoise(seed + 3) - 0.5) * 0.55;
  const angle = ((ringIndex / 24) * Math.PI * 2) + angleJitter;
  const radius = 520 + (ringBand * 170);
  const xJitter = (seededNoise(seed + 7) - 0.5) * 120;
  const zJitter = (seededNoise(seed + 11) - 0.5) * 120;

  state.position.x = (Math.cos(angle) * radius) + xJitter;
  state.position.y = 130 + ((seed % 5) * 28) + (seededNoise(seed + 17) * 36);
  state.position.z = (Math.sin(angle) * radius) + zJitter;
  state.rotation.pitch = 0;
  state.rotation.yaw = normalizeAngle(angle + Math.PI + ((seededNoise(seed + 21) - 0.5) * 0.6));
  state.rotation.roll = 0;

  const forward = forwardFromRotation(state.rotation);
  const cruiseSpeed = profile.minSpeed + 22;
  state.velocity.x = forward.x * cruiseSpeed;
  state.velocity.y = 0;
  state.velocity.z = forward.z * cruiseSpeed;
  state.speed = cruiseSpeed;
  state.health = profile.maxHealth;
  return state;
}

function snapshotForInstance(instance: GameInstance): SnapshotPayload {
  return {
    now: Date.now(),
    roomId: instance.id,
    players: [...instance.players.values()]
      .map((player) => ({
        id: player.id,
        name: player.name,
        team: player.team,
        isBot: player.isBot,
        aircraftClass: player.aircraftClass,
        state: copyState(player.state)
      }))
  };
}

function roomStateForInstance(instance: GameInstance): RoomStatePayload {
  return {
    players: [...instance.players.values()]
      .map((player) => ({
        id: player.id,
        name: player.name,
        team: player.team,
        isBot: player.isBot,
        aircraftClass: player.aircraftClass
      }))
  };
}

function emitRoster(instance: GameInstance): void {
  io.to(instance.id).emit("roomState", roomStateForInstance(instance));
}

function emitSnapshot(instance: GameInstance): void {
  io.to(instance.id).emit("snapshot", snapshotForInstance(instance));
}

function respawnPlayer(instance: GameInstance, player: ConnectedPlayer): void {
  const reset = resetAircraft(player.state, player.seed, player.aircraftClass);
  player.state = player.isBot
    ? applyBotSpawn(reset, player.seed, player.aircraftClass)
    : applyRunwaySpawn(reset, player.seed, player.aircraftClass);
  player.spawnProtectedUntil = Date.now() + SPAWN_PROTECTION_MS;
  io.to(instance.id).emit("respawnEvent", {
    playerId: player.id,
    state: copyState(player.state)
  });
}

function tryFire(instance: GameInstance, player: ConnectedPlayer): void {
  const now = Date.now();
  const botFireInterval = instance.botDifficulty === "easy"
    ? FIRE_INTERVAL_MS * 4.5
    : instance.botDifficulty === "hard"
      ? FIRE_INTERVAL_MS * 3.2
      : FIRE_INTERVAL_MS * 3.8;
  const minShotInterval = player.isBot ? botFireInterval : FIRE_INTERVAL_MS;

  if (!player.state.isAlive || (now - player.lastShotAt) < minShotInterval) {
    return;
  }

  player.lastShotAt = now;
  const direction = forwardFromRotation(player.state.rotation);
  const origin = {
    x: player.state.position.x + (direction.x * 10),
    y: player.state.position.y + (direction.y * 10),
    z: player.state.position.z + (direction.z * 10)
  };

  let closestTarget: ConnectedPlayer | undefined;
  let bestTargetScore = Number.POSITIVE_INFINITY;

  for (const candidate of instance.players.values()) {
    if (candidate.id === player.id || !candidate.state.isAlive) {
      continue;
    }

    if (candidate.spawnProtectedUntil > now) {
      continue;
    }

    const toTarget = subVec3(candidate.state.position, origin);
    const forwardDistance = dotVec3(toTarget, direction);
    const maxRange = player.isBot ? Math.min(FIRE_RANGE, 230) : FIRE_RANGE;
    if (forwardDistance < 0 || forwardDistance > maxRange) {
      continue;
    }

    const targetDistance = Math.sqrt(dotVec3(toTarget, toTarget)) || 1;
    const directionToTarget = {
      x: toTarget.x / targetDistance,
      y: toTarget.y / targetDistance,
      z: toTarget.z / targetDistance
    };
    const aimDot = dotVec3(direction, directionToTarget);
    const distanceToRay = distancePointToRay(candidate.state.position, origin, direction);
    const hitRadius = player.isBot ? HIT_RADIUS * 0.62 : HIT_RADIUS * 1.2;

    if (player.isBot) {
      if (distanceToRay <= hitRadius && forwardDistance < bestTargetScore) {
        bestTargetScore = forwardDistance;
        closestTarget = candidate;
      }
      continue;
    }

    const isDirectHit = distanceToRay <= hitRadius;
    const isAssistedHit = (
      aimDot >= HUMAN_AIM_ASSIST_CONE_DOT
      && distanceToRay <= HUMAN_AIM_ASSIST_MAX_RAY_DISTANCE
    );
    if (!isDirectHit && !isAssistedHit) {
      continue;
    }

    // Score candidates by alignment + range, and slightly prefer bots for easier progression.
    let score = (distanceToRay * 0.9) + (forwardDistance * 0.025) + ((1 - aimDot) * 35);
    if (isDirectHit) {
      score -= 15;
    }
    if (candidate.isBot) {
      score -= HUMAN_AIM_ASSIST_BOT_PRIORITY;
    }

    if (score < bestTargetScore) {
      bestTargetScore = score;
      closestTarget = candidate;
    }
  }

  const fireEvent: FireEvent = {
    shooterId: player.id,
    origin,
    direction
  };

  if (closestTarget) {
    const damage = player.isBot ? Math.max(4, Math.floor(FIRE_DAMAGE * 0.42)) : FIRE_DAMAGE;
    closestTarget.state.health = Math.max(0, closestTarget.state.health - damage);
    fireEvent.hitId = closestTarget.id;

    io.to(instance.id).emit("damageEvent", {
      attackerId: player.id,
      targetId: closestTarget.id,
      health: closestTarget.state.health
    });

    if (closestTarget.state.health <= 0) {
      closestTarget.state.isAlive = false;
      closestTarget.state.deaths += 1;
      closestTarget.state.respawnAt = now + RESPAWN_DELAY_MS;
      closestTarget.controls = createDefaultControls();
      player.state.score += 1;

      io.to(instance.id).emit("deathEvent", {
        attackerId: player.id,
        targetId: closestTarget.id
      });
    }
  }

  io.to(instance.id).emit("fireEvent", fireEvent);
}

function hasMissileLock(attacker: ConnectedPlayer, target: ConnectedPlayer): boolean {
  const delta = subVec3(target.state.position, attacker.state.position);
  const distanceSq = dotVec3(delta, delta);
  if (distanceSq > (MISSILE_RANGE * MISSILE_RANGE)) {
    return false;
  }

  const attackerForward = forwardFromRotation(attacker.state.rotation);
  const targetForward = forwardFromRotation(target.state.rotation);
  const distance = Math.sqrt(distanceSq) || 1;
  const directionToTarget = {
    x: delta.x / distance,
    y: delta.y / distance,
    z: delta.z / distance
  };
  const targetToAttacker = {
    x: -directionToTarget.x,
    y: -directionToTarget.y,
    z: -directionToTarget.z
  };

  const attackerAimDot = dotVec3(attackerForward, directionToTarget);
  const backsideDot = dotVec3(targetForward, targetToAttacker);
  if (attacker.isBot) {
    return attackerAimDot > 0.2 && backsideDot < 0.15;
  }

  // Human lock is more forgiving to make target acquisition practical at high speeds.
  return attackerAimDot > HUMAN_MISSILE_LOCK_DOT && backsideDot < HUMAN_MISSILE_BACKSIDE_DOT;
}

function tryMissile(instance: GameInstance, player: ConnectedPlayer): void {
  const now = Date.now();
  const missileInterval = player.isBot ? (MISSILE_INTERVAL_MS * 3) : MISSILE_INTERVAL_MS;
  if (!player.state.isAlive || (now - player.lastMissileAt) < missileInterval) {
    return;
  }

  let bestTarget: ConnectedPlayer | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of instance.players.values()) {
    if (candidate.id === player.id || !candidate.state.isAlive) {
      continue;
    }
    if (candidate.spawnProtectedUntil > now) {
      continue;
    }
    if (!hasMissileLock(player, candidate)) {
      continue;
    }

    const delta = subVec3(candidate.state.position, player.state.position);
    const distance = Math.sqrt(dotVec3(delta, delta));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestTarget = candidate;
    }
  }

  const forward = forwardFromRotation(player.state.rotation);
  const origin = {
    x: player.state.position.x + (forward.x * 12),
    y: player.state.position.y + (forward.y * 12),
    z: player.state.position.z + (forward.z * 12)
  };
  const missileEvent: MissileEvent = {
    shooterId: player.id,
    origin,
    direction: forward
  };

  if (!bestTarget) {
    return;
  }

  player.lastMissileAt = now;
  missileEvent.targetId = bestTarget.id;
  const impactPoint = { ...bestTarget.state.position };

  for (const candidate of instance.players.values()) {
    if (candidate.id === player.id || !candidate.state.isAlive) {
      continue;
    }
    if (candidate.spawnProtectedUntil > now) {
      continue;
    }

    const delta = subVec3(candidate.state.position, impactPoint);
    const distance = Math.sqrt(dotVec3(delta, delta));
    if (distance > MISSILE_SPLASH_RADIUS) {
      continue;
    }

    const damage = player.isBot ? Math.max(16, Math.floor(MISSILE_DAMAGE * 0.35)) : MISSILE_DAMAGE;
    candidate.state.health = Math.max(0, candidate.state.health - damage);
    io.to(instance.id).emit("damageEvent", {
      attackerId: player.id,
      targetId: candidate.id,
      health: candidate.state.health
    });

    if (candidate.state.health <= 0) {
      candidate.state.isAlive = false;
      candidate.state.deaths += 1;
      candidate.state.respawnAt = now + RESPAWN_DELAY_MS;
      candidate.controls = createDefaultControls();
      player.state.score += 1;
      io.to(instance.id).emit("deathEvent", {
        attackerId: player.id,
        targetId: candidate.id
      });
    }
  }

  io.to(instance.id).emit("missileEvent", missileEvent);
}

function updateBotControls(instance: GameInstance, bot: ConnectedPlayer): void {
  const targets = [...instance.players.values()].filter(
    (candidate) => candidate.id !== bot.id && candidate.state.isAlive
  );
  if (targets.length === 0) {
    bot.controls = {
      ...createDefaultControls(),
      throttle: 0.7
    };
    return;
  }

  targets.sort((left, right) => {
    const leftDelta = subVec3(left.state.position, bot.state.position);
    const rightDelta = subVec3(right.state.position, bot.state.position);
    const leftDistance = dotVec3(leftDelta, leftDelta);
    const rightDistance = dotVec3(rightDelta, rightDelta);
    return leftDistance - rightDistance;
  });

  const target = targets[0];
  const delta = subVec3(target.state.position, bot.state.position);
  const flatDistance = Math.sqrt((delta.x * delta.x) + (delta.z * delta.z)) || 1;
  const distance = Math.sqrt((delta.x * delta.x) + (delta.y * delta.y) + (delta.z * delta.z));
  const desiredYaw = Math.atan2(delta.x, delta.z);
  const desiredPitch = clamp(-Math.atan2(delta.y, flatDistance), -0.5, 0.5);
  const yawDelta = normalizeAngle(desiredYaw - bot.state.rotation.yaw);
  const pitchDelta = desiredPitch - bot.state.rotation.pitch;

  const diffConfig = instance.botDifficulty === "easy"
    ? { aim: 0.32, fireYaw: 0.05, firePitch: 0.045, chaseDistance: 760, cruiseThrottle: 0.38, boostTurn: 2.2, fireDistance: 170 }
    : instance.botDifficulty === "hard"
      ? { aim: 0.62, fireYaw: 0.08, firePitch: 0.07, chaseDistance: 620, cruiseThrottle: 0.5, boostTurn: 1.55, fireDistance: 210 }
      : { aim: 0.45, fireYaw: 0.06, firePitch: 0.055, chaseDistance: 700, cruiseThrottle: 0.44, boostTurn: 1.9, fireDistance: 185 };

  const aggressive = distance > diffConfig.chaseDistance;
  bot.controls = {
    pitch: clamp(pitchDelta * diffConfig.aim, -1, 1),
    yaw: clamp(yawDelta * diffConfig.aim, -1, 1),
    roll: clamp(yawDelta * (diffConfig.aim * 0.45), -1, 1),
    throttle: aggressive ? 0.72 : diffConfig.cruiseThrottle,
    boost: false,
    firing: distance < diffConfig.fireDistance && Math.abs(yawDelta) < diffConfig.fireYaw && Math.abs(pitchDelta) < diffConfig.firePitch
  };

  if (bot.state.position.y < 45) {
    bot.controls.pitch = -0.75;
    bot.controls.throttle = 1;
    bot.controls.boost = true;
  }
}

function addBot(instance: GameInstance, seed: number): void {
  const id = `bot-${instance.id}-${instance.nextBotSerial}`;
  instance.nextBotSerial += 1;
  const classCycle: AircraftClass[] = ["fighter", "interceptor", "heavy"];
  const aircraftClass = classCycle[seed % classCycle.length];
  const state = applyBotSpawn(createAircraftState(seed, aircraftClass), seed, aircraftClass);
  const bot: ConnectedPlayer = {
    id,
    name: `Bot-${id.split("-")[1]}`,
    isBot: true,
    team: "bot",
    aircraftClass,
    state,
    controls: createDefaultControls(),
    lastShotAt: 0,
    lastMissileAt: 0,
    spawnProtectedUntil: Date.now() + SPAWN_PROTECTION_MS,
    seed
  };
  instance.players.set(id, bot);
}

function rebalancePopulation(instance: GameInstance): void {
  const humans = allHumans(instance);
  const bots = allBots(instance);

  if (instance.isDraining) {
    bots.forEach((bot) => {
      instance.players.delete(bot.id);
    });
    return;
  }

  if (humans.length === 0) {
    bots.forEach((bot) => {
      instance.players.delete(bot.id);
    });
    instance.botDifficulty = "medium";
    return;
  }

  const desiredBots = humans.length >= BOT_ACTIVE_HUMAN_THRESHOLD
    ? 0
    : Math.max(0, TARGET_POPULATION_WITH_BOTS - humans.length);

  if (bots.length < desiredBots) {
    const toAdd = desiredBots - bots.length;
    for (let index = 0; index < toAdd; index += 1) {
      addBot(instance, instance.players.size);
    }
    return;
  }

  if (bots.length > desiredBots) {
    const toRemove = bots.length - desiredBots;
    bots
      .sort((left, right) => right.id.localeCompare(left.id))
      .slice(0, toRemove)
      .forEach((bot) => {
        instance.players.delete(bot.id);
      });
  }
}

function sortedJoinableInstances(): GameInstance[] {
  return [...instances.values()]
    .filter((instance) => !instance.isDraining)
    .sort((left, right) => {
      const leftHumans = allHumans(left).length;
      const rightHumans = allHumans(right).length;
      if (leftHumans === rightHumans) {
        return left.createdAt - right.createdAt;
      }
      return leftHumans - rightHumans;
    });
}

function pickJoinInstance(): GameInstance {
  ensureAtLeastOneInstance();
  const joinable = sortedJoinableInstances()
    .filter((instance) => allHumans(instance).length < MAX_HUMAN_PLAYERS_PER_INSTANCE);

  if (joinable.length > 0) {
    return joinable[0];
  }

  return createInstance();
}

function pickMigrationTarget(excludingInstanceId: string): GameInstance | undefined {
  return sortedJoinableInstances().find((instance) => (
    instance.id !== excludingInstanceId
    && allHumans(instance).length < MAX_HUMAN_PLAYERS_PER_INSTANCE
  ));
}

function moveOneHumanFromInstance(source: GameInstance): boolean {
  const target = pickMigrationTarget(source.id);
  if (!target) {
    return false;
  }

  const playerToMove = [...source.players.values()].find((player) => !player.isBot);
  if (!playerToMove) {
    return false;
  }

  const socket = io.sockets.sockets.get(playerToMove.id);
  if (!socket) {
    source.players.delete(playerToMove.id);
    playerInstanceBySocket.delete(playerToMove.id);
    return true;
  }

  source.players.delete(playerToMove.id);
  socket.leave(source.id);

  const targetSeed = target.players.size;
  playerToMove.seed = targetSeed;
  playerToMove.controls = createDefaultControls();
  playerToMove.state = applyRunwaySpawn(
    resetAircraft(playerToMove.state, targetSeed, playerToMove.aircraftClass),
    targetSeed,
    playerToMove.aircraftClass
  );
  playerToMove.spawnProtectedUntil = Date.now() + SPAWN_PROTECTION_MS;

  target.players.set(playerToMove.id, playerToMove);
  playerInstanceBySocket.set(playerToMove.id, target.id);
  socket.join(target.id);

  emitRoster(source);
  emitSnapshot(source);
  emitRoster(target);
  emitSnapshot(target);
  return true;
}

function cleanupEmptyInstances(): void {
  const current = [...instances.values()];
  for (const instance of current) {
    if (instances.size <= 1) {
      break;
    }
    if (instance.players.size === 0) {
      instances.delete(instance.id);
    }
  }
  ensureAtLeastOneInstance();
}

function markInstancesForDrain(): void {
  ensureAtLeastOneInstance();
  const humans = totalHumans();
  const requiredInstances = Math.max(1, Math.ceil(humans / MAX_HUMAN_PLAYERS_PER_INSTANCE));
  const activeInstances = [...instances.values()]
    .filter((instance) => !instance.isDraining)
    .sort((left, right) => {
      const leftHumans = allHumans(left).length;
      const rightHumans = allHumans(right).length;
      if (leftHumans === rightHumans) {
        return right.createdAt - left.createdAt;
      }
      return leftHumans - rightHumans;
    });
  const drainingInstances = [...instances.values()]
    .filter((instance) => instance.isDraining)
    .sort((left, right) => {
      const leftHumans = allHumans(left).length;
      const rightHumans = allHumans(right).length;
      if (leftHumans === rightHumans) {
        return left.createdAt - right.createdAt;
      }
      return rightHumans - leftHumans;
    });

  if (activeInstances.length > requiredInstances) {
    const toDrain = activeInstances.length - requiredInstances;
    for (let index = 0; index < toDrain; index += 1) {
      const instance = activeInstances[index];
      instance.isDraining = true;
      if (!instance.drainStartedAt) {
        instance.drainStartedAt = Date.now();
      }
    }
  }

  if (activeInstances.length < requiredInstances) {
    const toUndrain = Math.min(requiredInstances - activeInstances.length, drainingInstances.length);
    for (let index = 0; index < toUndrain; index += 1) {
      const instance = drainingInstances[index];
      instance.isDraining = false;
      instance.drainStartedAt = undefined;
    }
  }

  const refreshedActiveCount = [...instances.values()].filter((instance) => !instance.isDraining).length;
  if (refreshedActiveCount < requiredInstances) {
    const toCreate = requiredInstances - refreshedActiveCount;
    for (let index = 0; index < toCreate; index += 1) {
      createInstance();
    }
  }
}

function migrateDrainingInstances(): void {
  let moves = 0;
  const draining = [...instances.values()]
    .filter((instance) => instance.isDraining)
    .sort((left, right) => {
      const leftHumans = allHumans(left).length;
      const rightHumans = allHumans(right).length;
      return leftHumans - rightHumans;
    });

  for (const source of draining) {
    while (moves < MAX_MIGRATIONS_PER_TICK && allHumans(source).length > 0) {
      const moved = moveOneHumanFromInstance(source);
      if (!moved) {
        return;
      }
      moves += 1;
    }
  }
}

function rebalanceInstances(): void {
  markInstancesForDrain();
  migrateDrainingInstances();
  for (const instance of instances.values()) {
    rebalancePopulation(instance);
  }
  cleanupEmptyInstances();
}

function instanceAndPlayerForSocket(socketId: string): {
  instance: GameInstance;
  player: ConnectedPlayer;
} | undefined {
  const instanceId = playerInstanceBySocket.get(socketId);
  if (!instanceId) {
    return undefined;
  }
  const instance = instances.get(instanceId);
  if (!instance) {
    playerInstanceBySocket.delete(socketId);
    return undefined;
  }
  const player = instance.players.get(socketId);
  if (!player) {
    playerInstanceBySocket.delete(socketId);
    return undefined;
  }
  return { instance, player };
}

ensureAtLeastOneInstance();

io.on("connection", (socket) => {
  socket.on("joinMatch", (payload, callback) => {
    rebalanceInstances();
    const instance = pickJoinInstance();
    const name = sanitizeText(payload.name, `Pilot-${socket.id.slice(0, 4)}`);
    const aircraftClass = sanitizeAircraftClass(payload.aircraftClass);
    instance.botDifficulty = sanitizeBotDifficulty(payload.botDifficulty);
    const seed = instance.players.size;
    const state = applyRunwaySpawn(createAircraftState(seed, aircraftClass), seed, aircraftClass);

    const player: ConnectedPlayer = {
      id: socket.id,
      name,
      isBot: false,
      team: "human",
      aircraftClass,
      state,
      controls: createDefaultControls(),
      lastShotAt: 0,
      lastMissileAt: 0,
      spawnProtectedUntil: Date.now() + SPAWN_PROTECTION_MS,
      seed
    };

    instance.players.set(socket.id, player);
    playerInstanceBySocket.set(socket.id, instance.id);
    socket.join(instance.id);
    rebalanceInstances();

    const welcome: WelcomePayload = {
      accepted: true,
      playerId: socket.id,
      roomId: instance.id,
      state: copyState(player.state)
    };

    callback(welcome);
    emitRoster(instance);
    emitSnapshot(instance);
  });

  socket.on("controls", (payload) => {
    const details = instanceAndPlayerForSocket(socket.id);
    if (!details || details.player.isBot) {
      return;
    }

    details.player.controls = sanitizeControls(payload);
  });

  socket.on("fire", () => {
    const details = instanceAndPlayerForSocket(socket.id);
    if (!details) {
      return;
    }

    if (details.player.isBot) {
      return;
    }

    tryFire(details.instance, details.player);
  });

  socket.on("missile", () => {
    const details = instanceAndPlayerForSocket(socket.id);
    if (!details || details.player.isBot) {
      return;
    }
    tryMissile(details.instance, details.player);
  });

  socket.on("disconnect", () => {
    const details = instanceAndPlayerForSocket(socket.id);
    if (!details) {
      return;
    }

    details.instance.players.delete(socket.id);
    playerInstanceBySocket.delete(socket.id);
    rebalanceInstances();
    emitRoster(details.instance);
    emitSnapshot(details.instance);
  });
});

setInterval(() => {
  const now = Date.now();
  rebalanceInstances();

  for (const instance of instances.values()) {
    for (const player of instance.players.values()) {
      if (player.state.isAlive) {
        if (player.isBot) {
          updateBotControls(instance, player);
        }

        player.state = simulateAircraft(player.state, player.controls, tickSeconds, player.aircraftClass);

        if (!player.isBot) {
          const maxHealth = AIRCRAFT_PROFILES[player.aircraftClass].maxHealth;
          if (player.state.health < maxHealth) {
            player.state.health = Math.min(
              maxHealth,
              player.state.health + (HUMAN_HEALTH_REGEN_PER_SECOND * tickSeconds)
            );
          }
        }

        if (player.controls.firing) {
          tryFire(instance, player);
        }

        if (player.isBot) {
          tryMissile(instance, player);
        }

        continue;
      }

      if (player.state.respawnAt > 0 && now >= player.state.respawnAt) {
        respawnPlayer(instance, player);
      }
    }
    if (allHumans(instance).length > 0) {
      emitSnapshot(instance);
    }
  }
}, tickMs);

httpServer.listen(port, () => {
  console.log(`Aircraft shooter server listening on http://localhost:${port}`);
});
