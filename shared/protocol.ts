import type {
  AircraftClass,
  AircraftState,
  BotDifficulty,
  ControlState,
  SnapshotPlayer,
  Vec3
} from "./game";

export type JoinPayload = {
  name: string;
  roomId: string;
  aircraftClass: AircraftClass;
  botDifficulty: BotDifficulty;
};

export type FirePayload = {
  origin: Vec3;
  direction: Vec3;
};

export type FireEvent = {
  shooterId: string;
  origin: Vec3;
  direction: Vec3;
  hitId?: string;
};

export type MissileEvent = {
  shooterId: string;
  targetId?: string;
  origin: Vec3;
  direction: Vec3;
};

export type DamageEvent = {
  attackerId: string;
  targetId: string;
  health: number;
};

export type DeathEvent = {
  attackerId: string;
  targetId: string;
};

export type SnapshotPayload = {
  now: number;
  roomId: string;
  players: SnapshotPlayer[];
};

export type WelcomePayload = {
  accepted: boolean;
  message?: string;
  playerId: string;
  state?: AircraftState;
  roomId: string;
};

export type RoomStatePayload = {
  players: Array<Pick<SnapshotPlayer, "id" | "name" | "team" | "isBot" | "aircraftClass">>;
};

export type ClientToServerEvents = {
  joinMatch: (payload: JoinPayload, callback: (response: WelcomePayload) => void) => void;
  controls: (payload: ControlState) => void;
  fire: (payload: FirePayload) => void;
  missile: () => void;
};

export type ServerToClientEvents = {
  snapshot: (payload: SnapshotPayload) => void;
  roomState: (payload: RoomStatePayload) => void;
  fireEvent: (payload: FireEvent) => void;
  missileEvent: (payload: MissileEvent) => void;
  damageEvent: (payload: DamageEvent) => void;
  deathEvent: (payload: DeathEvent) => void;
  respawnEvent: (payload: { playerId: string; state: AircraftState }) => void;
};
