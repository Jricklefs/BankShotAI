# BankShotAI

AR-assisted pool bank shot calculator. Point your phone at the table, detect balls, and see optimal shot paths with difficulty ratings.

## Quick Start

```bash
# Install dependencies
npm install

# Serve locally
npm start
# → Open http://localhost:8100 on your phone (same network)
```

No build step needed — vanilla JS with ES modules.

## Usage

1. **SETUP** — Tap the 4 corners of the table playing surface (bottom-left first, clockwise)
2. **DETECT** — Tap "Detect Balls" to find balls via camera, or "Demo" for test data
3. **AIM** — Tap the cue ball, then tap the target ball
4. **SHOTS** — View calculated shot paths color-coded by difficulty

## Capacitor (Mobile)

```bash
npm run cap:init
npm run cap:add:ios      # or cap:add:android
npm run cap:sync
npm run cap:open:ios     # opens in Xcode
```

## Tech

- Vanilla JS, no frameworks
- OpenCV.js for ball detection (loaded from CDN)
- Mirror-reflection geometry for bank shot physics
- Mobile-first, works in any modern browser with camera access
