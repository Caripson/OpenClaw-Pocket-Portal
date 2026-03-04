# OpenClaw Pocket Portal

Local-first project portal for structured agent ↔ user collaboration.

**LAN-only by default.** No auth. Intended for a trusted home network.

## Features (v0.1)
- “Rooms” (projects/topics) with:
  - Notes (markdown raw text)
  - Actions (checkbox tasks)
  - Audit log (append-only)
  - Artifacts (links to local demos/URLs)
- SQLite storage
- Health endpoint for watchdogs

## Run (dev)

```bash
npm install
HOST=0.0.0.0 PORT=4377 npm run dev
```

Open:
- `http://<your-lan-ip>:4377/`

## Storage
- SQLite at `./data/pocket-portal.db` (created on first run)

## Launchd templates (macOS)
See `launchd/` for example LaunchAgent plists. **Edit paths + HOST/PORT** before installing.

## Non-goals (for now)
- Public internet exposure
- Multi-user / permissions
- Fancy WYSIWYG editor
