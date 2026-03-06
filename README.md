# OpenClaw Pocket Portal (plugin)

Local-first project portal for structured agent ↔ user collaboration.

**LAN-only by default** (you choose bind host). No auth. Intended for a trusted home network.

## What it is
A lightweight “room” system:
- Notes
- Actions (checkbox)
- Audit log (append-only)
- Artifacts (links to demos/URLs)

## Runs as an OpenClaw plugin
This is an **in-process plugin** (runs inside the OpenClaw Gateway process), but it starts its **own HTTP server** so you can bind it to a LAN IP without exposing the Gateway UI.

## Install (local development)

### Option A: discovery path (fastest)

Clone into one of OpenClaw’s plugin discovery locations, e.g.:

- `~/.openclaw/extensions/pocket-portal/`

Then restart the gateway.

### Option B: CLI install (recommended when testing install flow)

From a local checkout:

```bash
openclaw plugins install /absolute/path/to/OpenClaw-Pocket-Portal
openclaw gateway restart
```

> Note: OpenClaw treats untracked local plugins as "trusted code". For a strict setup, pin trust with `plugins.allow: ["pocket-portal"]`.

## Configure
In your OpenClaw config:

```json5
{
  plugins: {
    entries: {
      "pocket-portal": {
        enabled: true,
        config: {
          host: "192.168.0.145",
          port: 4377,
          basePath: "/"
        }
      }
    }
  }
}
```

## Data storage
Stored as a single JSON file (atomic writes) under the plugin state directory by default:

- `state:pocket-portal/pocket-portal.json`

**Schema includes:**
- Rooms with tags
- Comments (room-level threads)
- Notes, Actions, Audit, Artifacts (existing)

(You can override `dataFile`.)

## Routes
- UI: `/` and `/rooms/:id`
- Static: `/static/*` (includes i18n: `en.json`, `sv.json`)
- API: `/api/*`
  - `/api/rooms` - GET (list), POST (create)
  - `/api/rooms/:id` - GET (details)
  - `/api/rooms/:id/title` - POST (update title + tags)
  - `/api/rooms/:id/tags` - GET (view), POST (update)
  - `/api/rooms/:id/comments` - GET (list), POST (add)
  - `/api/rooms/:id/actions` - POST (add)
  - `/api/actions/:id/toggle` - POST (toggle done)
  - `/api/rooms/:id/notes` - POST (update)
  - `/api/rooms/:id/artifacts` - POST (add link)
  - `/api/rooms/:id/artifacts/upload` - POST (upload file)
  - `/api/rooms/:id/audit` - POST (add)
  - `/api/search` - GET (search by title/tags)
- Health: `/api/health`


## New Features (MVP)
### Room Tags & Search
- Rooms now support tags (comma-separated)
- Search API: `/api/search?query=...` filters by title or tags
- Tag management: GET/POST `/api/rooms/:id/tags`

### Room-Level Comments
- Threaded comments per room
- API: GET/POST `/api/rooms/:id/comments`
- Comments have optional author, message, and timestamp
- Included in room details API

### i18n Support
- English (en.json) and Swedish (sv.json) translations
- Covers all UI text, labels, and messages
- Static files served from `/static/`

## License
MIT
