# v0.1.1 — Blank Launcher + Spatial Graph Map

This patch keeps the existing runtime, DeepSeek/Codex adapters, save rules and modules intact. It changes the product shell in two places.

## Blank launcher

The app no longer drops directly into the current/demo world on page load. The first screen is a launcher with:

- Continue current autosave (only when one exists)
- Create a new AI world
- Optional Prompt import (`.txt`, `.md`, or a full Prompt Profile `.json`)
- Import a standard Framework Save Package or World Package JSON
- Open the Harbor demo explicitly as a test world

A plain-text Prompt is stored as the imported `engine_policy` while the other role fragments continue to use the framework defaults. A full Prompt Profile JSON replaces the whole profile for the newly created world.

Legacy/foreign-save semantic migration is still a later feature; arbitrary old RPG JSON is not silently guessed into the schema.

## Spatial graph map

The map panel now renders an SVG node/edge map:

- location = node
- route = line
- route label = travel minutes
- current location = highlighted node
- directly reachable locations = clickable nodes

World locations can optionally persist canonical `position: { x, y }` values in the 0–100 range. Existing saves without positions remain valid and receive a deterministic visual fallback. Newly AI-authored worlds get positions compiled from route topology and then persisted in the World Package.

## After applying the overlay

Run once on Windows from the project directory:

```powershell
npm run build
```

Then start with your chosen adapter, for example DeepSeek:

```powershell
$env:AI_ADAPTER="deepseek"
$env:DEEPSEEK_API_KEY="your-key"
npm start
```
