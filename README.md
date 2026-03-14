# Browser Aircraft Shooter

Low-poly multiplayer aircraft dogfighting for the browser using `Three.js` on the client and `Socket.IO` on the server.

## Features

- Brighter cinematic sky arena with selectable weather presets
- Flight controls for pitch, yaw, throttle, and boost
- Keyboard-first controls with gamepad support
- Real-time multiplayer room join flow
- Server-authoritative shooting, damage, kills, respawn, and score sync
- scoreboard, audio cues, contrails, and brighter tracer effects

## Local Development

Install dependencies:

```bash
npm install
```

Start the server:

```bash
npm run dev:server
```

Start the client in another terminal:

```bash
npm run dev:client
```

Open [http://localhost:5173](http://localhost:5173).

## Controls

Keyboard:

- `W` / `S`: pitch up/down
- `A` / `D`: yaw left/right
- `Arrow keys`: alternate pitch/yaw support
- `R` / `F`: throttle up/down
- `Shift`: boost
- `Space`: fire
- `X`: missile lock shot
- `T`: cycle weather preset

Gamepad:

- Left stick: pitch and yaw
- Left / right triggers: throttle down / up
- `A` or right bumper: fire
- `X` / Square: missile lock shot
- `B` or full right trigger: boost

## Weather Presets

- `Clear Blue`
- `Cloudy`
- `Sunset`
- `Storm Front`
- `High Fog`

## Build

```bash
npm run build
```
