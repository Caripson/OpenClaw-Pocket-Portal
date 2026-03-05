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

(You can override `dataFile`.)

## Routes
- UI: `/` and `/rooms/:id`
- Static: `/static/*`
- API: `/api/*`
- Health: `/api/health`

## License
MIT
