import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { nanoid } from "nanoid";
import Busboy from "busboy";
import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";

type PortalConfig = {
  enabled: boolean;
  host: string;
  port: number;
  basePath: string;
  allowLan: boolean;
  dataFile: string;
};

const ConfigSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(4377),
  basePath: z.string().default("/"),
  allowLan: z.boolean().default(true),
  dataFile: z.string().default("state:pocket-portal/pocket-portal.json"),
});

type Room = { id: string; title: string; created_at: string; updated_at: string; tags: string[] };

type Action = { id: string; room_id: string; text: string; done: boolean; created_at: string; updated_at: string };

type Comment = { id: string; room_id: string; author?: string; message: string; created_at: string };

type Audit = { id: string; room_id: string; kind: string; message: string; created_at: string };

type Artifact = { id: string; room_id: string; title: string; url: string; created_at: string };

type PortalDb = {
  version: 1;
  rooms: Room[];
  comments: Record<string, Comment[]>;
  notes: Record<string, { markdown: string; updated_at: string }>;
  actions: Action[];
  audit: Audit[];
  artifacts: Artifact[];
};

function now(): string {
  return new Date().toISOString();
}

function normalizeBasePath(p: string): string {
  const s = (p || "/").trim();
  if (s === "/") return "/";
  return "/" + s.replace(/^\/+/, "").replace(/\/+$/, "");
}

function sendJson(res: http.ServerResponse, code: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 2_000_000) {
        reject(new Error("payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

function safeDecodePathname(url: string | undefined, host = "http://local"): string {
  try {
    return new URL(url || "/", host).pathname;
  } catch {
    return "/";
  }
}

function isLoopbackAddr(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

function resolveDataPath(ctx: OpenClawPluginServiceContext, api: OpenClawPluginApi, cfg: PortalConfig): string {
  const raw = cfg.dataFile;
  if (raw.startsWith("state:")) {
    const rel = raw.slice("state:".length).replace(/^\/+/, "");
    return path.join(ctx.stateDir, rel);
  }
  return api.resolvePath(raw);
}

function loadDb(filePath: string): PortalDb {
  try {
    const txt = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(txt);
    if (!parsed || typeof parsed !== "object") throw new Error("bad_db");

    return {
      version: 1,
      rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [],
      comments: parsed.comments && typeof parsed.comments === "object" ? parsed.comments : {},
      notes: parsed.notes && typeof parsed.notes === "object" ? parsed.notes : {},
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      audit: Array.isArray(parsed.audit) ? parsed.audit : [],
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
    };
  } catch {
    return { version: 1, rooms: [], comments: {}, notes: {}, actions: [], audit: [], artifacts: [] };
  }
}

function saveDb(filePath: string, db: PortalDb) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function getStaticDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "static");
}

function contentTypeFor(p: string): string {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function sendFile(res: http.ServerResponse, filePath: string) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) throw new Error("not_file");
    res.statusCode = 200;
    res.setHeader("content-type", contentTypeFor(filePath));
    res.setHeader("cache-control", "no-store");
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.statusCode = 404;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Not Found");
  }
}

function withBase(basePath: string, p: string): string {
  if (basePath === "/") return p;
  if (!p.startsWith("/")) p = "/" + p;
  return basePath + p;
}

function stripBase(basePath: string, pathname: string): string | null {
  if (basePath === "/") return pathname;
  if (pathname === basePath) return "/";
  if (!pathname.startsWith(basePath + "/")) return null;
  return pathname.slice(basePath.length) || "/";
}

function roomById(db: PortalDb, id: string): Room | undefined {
  return db.rooms.find((r) => r.id === id);
}

function parseQuery(req: http.IncomingMessage): URLSearchParams {
  try {
    const u = new URL(req.url || "/", `http://${req.headers.host || "local"}`);
    return u.searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name || "upload");
  return base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "upload";
}

async function handleMultipartUpload(req: http.IncomingMessage): Promise<{ fields: Record<string, string>; file?: { filename: string; mimeType: string; buf: Buffer } }> {
  const bb = Busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 10 } });
  const fields: Record<string, string> = {};
  let file: { filename: string; mimeType: string; buf: Buffer } | undefined;

  await new Promise<void>((resolve, reject) => {
    bb.on("field", (name, val) => {
      fields[name] = String(val ?? "");
    });

    bb.on("file", (_name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on("data", (d: Buffer) => chunks.push(d));
      stream.on("limit", () => reject(new Error("file_too_large")));
      stream.on("end", () => {
        file = {
          filename: sanitizeFilename(info.filename || "upload"),
          mimeType: info.mimeType || "application/octet-stream",
          buf: Buffer.concat(chunks),
        };
      });
      stream.on("error", reject);
    });

    bb.on("finish", () => resolve());
    bb.on("error", reject);

    req.pipe(bb);
  });

  return { fields, file };
}

export default function (api: OpenClawPluginApi) {
  api.registerService({
    id: "pocket-portal",

    async start(ctx) {
      const cfg = ConfigSchema.parse(api.pluginConfig ?? {}) as PortalConfig;
      if (!cfg.enabled) {
        api.logger.info("[pocket-portal] disabled");
        return;
      }

      const basePath = normalizeBasePath(cfg.basePath);
      const dataPath = resolveDataPath(ctx, api, cfg);
      const staticDir = getStaticDir();

      const server = http.createServer(async (req, res) => {
        try {
          if (!cfg.allowLan && !isLoopbackAddr(req.socket.remoteAddress)) {
            res.statusCode = 403;
            res.end("Forbidden");
            return;
          }

          const pathnameFull = safeDecodePathname(req.url, `http://${req.headers.host || "local"}`);
          const pathname = stripBase(basePath, pathnameFull);
          if (pathname == null) {
            res.statusCode = 404;
            res.end("Not Found");
            return;
          }

          // Static
          if (pathname.startsWith("/static/")) {
            const rel = pathname.slice("/static/".length);
            const fp = path.join(staticDir, rel);
            if (!fp.startsWith(staticDir)) {
              res.statusCode = 400;
              res.end("Bad Request");
              return;
            }
            sendFile(res, fp);
            return;
          }

          // UI
          if (req.method === "GET" && pathname === "/") {
            sendFile(res, path.join(staticDir, "index.html"));
            return;
          }
          if (req.method === "GET" && pathname.startsWith("/rooms/")) {
            sendFile(res, path.join(staticDir, "room.html"));
            return;
          }

          // Uploaded files (stored under state dir)
          if (req.method === "GET" && pathname.startsWith("/uploads/")) {
            const rel = pathname.slice("/uploads/".length);
            const uploadsDir = path.join(ctx.stateDir, "pocket-portal", "uploads");
            const fp = path.resolve(uploadsDir, rel);
            if (!fp.startsWith(path.resolve(uploadsDir) + path.sep) && fp !== path.resolve(uploadsDir)) {
              res.statusCode = 400;
              res.end("Bad Request");
              return;
            }
            sendFile(res, fp);
            return;
          }

          // API
          if (pathname === "/api/health") {
            const db = loadDb(dataPath);
            sendJson(res, 200, { ok: true, ts: now(), version: "0.1.0", db: { ok: true, rooms: db.rooms.length } });
            return;
          }

          if (pathname === "/api/rooms" && req.method === "GET") {
            const db = loadDb(dataPath);
            const rooms = [...db.rooms].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
            sendJson(res, 200, { rooms });
            return;
          }

          if (pathname === "/api/rooms" && req.method === "POST") {
            const body = await readBody(req);
            const parsed = z.object({ title: z.string().min(1).max(200) }).safeParse(JSON.parse(body || "{}"));
            if (!parsed.success) return sendJson(res, 400, { error: parsed.error.flatten() });

            const db = loadDb(dataPath);
            const id = nanoid();
            const ts = now();
            db.rooms.push({ id, title: parsed.data.title, created_at: ts, updated_at: ts, tags: [] });
            db.notes[id] = { markdown: "", updated_at: ts };
            db.comments[id] = [];
            db.audit.push({ id: nanoid(), room_id: id, kind: "system", message: "Room created", created_at: ts });
            saveDb(dataPath, db);
            sendJson(res, 200, { id });
            return;
          }

          const roomIdMatch = pathname.match(/^\/api\/rooms\/([^/]+)$/);
          if (roomIdMatch && req.method === "GET") {
            const roomId = roomIdMatch[1];
            const db = loadDb(dataPath);
            const room = roomById(db, roomId);
            if (!room) return sendJson(res, 404, { error: "not_found" });

            const note = db.notes[roomId] ?? { markdown: "", updated_at: null };
            const actions = db.actions.filter((a) => a.room_id === roomId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            const audit = db.audit
              .filter((e) => e.room_id === roomId)
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
              .slice(0, 200);
            const artifacts = db.artifacts.filter((a) => a.room_id === roomId).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            const comments = (db.comments[roomId] || []).slice(-200);

            sendJson(res, 200, { room, note, actions, audit, artifacts, comments });
            return;
          }

          const titleMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/title$/);
          if (titleMatch && req.method === "POST") {
            const roomId = titleMatch[1];
            const body = await readBody(req);
            const parsed = z
              .object({ title: z.string().min(1).max(200), tags: z.array(z.string()).optional() })
              .safeParse(JSON.parse(body || "{}"));
            if (!parsed.success) return sendJson(res, 400, { error: parsed.error.flatten() });

            const db = loadDb(dataPath);
            const room = roomById(db, roomId);
            if (!room) return sendJson(res, 404, { error: "not_found" });

            room.title = parsed.data.title;
            if (parsed.data.tags) room.tags = parsed.data.tags;
            room.updated_at = now();
            db.audit.push({ id: nanoid(), room_id: roomId, kind: "edit", message: `Title changed to: ${parsed.data.title}`, created_at: room.updated_at });
            saveDb(dataPath, db);
            sendJson(res, 200, { ok: true });
            return;
          }

          const tagsMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/tags$/);
          if (tagsMatch && req.method === "GET") {
            const roomId = tagsMatch[1];
            const db = loadDb(dataPath);
            const room = roomById(db, roomId);
            if (!room) return sendJson(res, 404, { error: "not_found" });
            sendJson(res, 200, { tags: room.tags });
            return;
          }

          if (tagsMatch && req.method === "POST") {
            const roomId = tagsMatch[1];
            const body = await readBody(req);
            const parsed = z.object({ tags: z.array(z.string()).min(0).max(25) }).safeParse(JSON.parse(body || "{}"));
            if (!parsed.success) return sendJson(res, 400, { error: parsed.error.flatten() });

            const db = loadDb(dataPath);
            const room = roomById(db, roomId);
            if (!room) return sendJson(res, 404, { error: "not_found" });

            room.tags = parsed.data.tags;
            room.updated_at = now();
            db.audit.push({ id: nanoid(), room_id: roomId, kind: "edit", message: `Tags updated: ${parsed.data.tags.join(", ")}`, created_at: room.updated_at });
            saveDb(dataPath, db);
            sendJson(res, 200, { ok: true });
            return;
          }

          if (pathname === "/api/search" && req.method === "GET") {
            const q = (parseQuery(req).get("query") || "").trim().toLowerCase();
            const db = loadDb(dataPath);
            const rooms = db.rooms
              .filter((room) => {
                if (!q) return true;
                if (room.title.toLowerCase().includes(q)) return true;
                return (room.tags || []).some((tag) => tag.toLowerCase().includes(q));
              })
              .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
            sendJson(res, 200, { rooms });
            return;
          }

          const notesMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/notes$/);
          if (notesMatch && req.method === "POST") {
            const roomId = notesMatch[1];
            const body = await readBody(req);
            const parsed = z.object({ markdown: z.string().max(200_000) }).safeParse(JSON.parse(body || "{}"));
            if (!parsed.success) return sendJson(res, 400, { error: parsed.error.flatten() });

            const db = loadDb(dataPath);
            const room = roomById(db, roomId);
            if (!room) return sendJson(res, 404, { error: "not_found" });

            const ts = now();
            db.notes[roomId] = { markdown: parsed.data.markdown, updated_at: ts };
            room.updated_at = ts;
            db.audit.push({ id: nanoid(), room_id: roomId, kind: "note", message: "Notes updated", created_at: ts });
            saveDb(dataPath, db);
            sendJson(res, 200, { ok: true });
            return;
          }

          const actionsMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/actions$/);
          if (actionsMatch && req.method === "POST") {
            const roomId = actionsMatch[1];
            const body = await readBody(req);
            const parsed = z.object({ text: z.string().min(1).max(500) }).safeParse(JSON.parse(body || "{}"));
            if (!parsed.success) return sendJson(res, 400, { error: parsed.error.flatten() });

            const db = loadDb(dataPath);
            const room = roomById(db, roomId);
            if (!room) return sendJson(res, 404, { error: "not_found" });

            const ts = now();
            const id = nanoid();
            db.actions.push({ id, room_id: roomId, text: parsed.data.text, done: false, created_at: ts, updated_at: ts });
            room.updated_at = ts;
            db.audit.push({ id: nanoid(), room_id: roomId, kind: "action", message: `Action added: ${parsed.data.text}`, created_at: ts });
            saveDb(dataPath, db);
            sendJson(res, 200, { id });
            return;
          }

          const toggleMatch = pathname.match(/^\/api\/actions\/([^/]+)\/toggle$/);
          if (toggleMatch && req.method === "POST") {
            const actionId = toggleMatch[1];
            const db = loadDb(dataPath);
            const action = db.actions.find((a) => a.id === actionId);
            if (!action) return sendJson(res, 404, { error: "not_found" });

            const ts = now();
            action.done = !action.done;
            action.updated_at = ts;
            const room = roomById(db, action.room_id);
            if (room) room.updated_at = ts;

            db.audit.push({
              id: nanoid(),
              room_id: action.room_id,
              kind: "action",
              message: `Action ${action.done ? "done" : "undone"}: ${action.text}`,
              created_at: ts,
            });

            saveDb(dataPath, db);
            sendJson(res, 200, { ok: true, done: action.done });
            return;
          }

          const artifactUploadMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/artifacts\/upload$/);
          if (artifactUploadMatch && req.method === "POST") {
            const roomId = artifactUploadMatch[1];
            const db = loadDb(dataPath);
            const room = roomById(db, roomId);
            if (!room) return sendJson(res, 404, { error: "not_found" });

            const { fields, file } = await handleMultipartUpload(req);
            if (!file) return sendJson(res, 400, { error: "no_file" });

            const title = String(fields.title || file.filename).trim().slice(0, 200);
            const ts = now();
            const id = nanoid();

            const uploadsDir = path.join(ctx.stateDir, "pocket-portal", "uploads", roomId);
            fs.mkdirSync(uploadsDir, { recursive: true });
            const diskName = `${id}-${file.filename}`;
            const diskPath = path.join(uploadsDir, diskName);
            fs.writeFileSync(diskPath, file.buf);

            const url = withBase(basePath, `/uploads/${encodeURIComponent(roomId)}/${encodeURIComponent(diskName)}`);

            db.artifacts.push({ id, room_id: roomId, title, url, created_at: ts });
            room.updated_at = ts;
            db.audit.push({ id: nanoid(), room_id: roomId, kind: "artifact", message: `Artifact uploaded: ${title}`, created_at: ts });
            saveDb(dataPath, db);

            sendJson(res, 200, { id, url });
            return;
          }

          const artifactsMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/artifacts$/);
          if (artifactsMatch && req.method === "POST") {
            const roomId = artifactsMatch[1];
            const body = await readBody(req);
            const parsed = z.object({ title: z.string().min(1).max(200), url: z.string().min(1).max(2000) }).safeParse(JSON.parse(body || "{}"));
            if (!parsed.success) return sendJson(res, 400, { error: parsed.error.flatten() });

            const db = loadDb(dataPath);
            const room = roomById(db, roomId);
            if (!room) return sendJson(res, 404, { error: "not_found" });

            const ts = now();
            const id = nanoid();
            db.artifacts.push({ id, room_id: roomId, title: parsed.data.title, url: parsed.data.url, created_at: ts });
            room.updated_at = ts;
            db.audit.push({ id: nanoid(), room_id: roomId, kind: "artifact", message: `Artifact added: ${parsed.data.title}`, created_at: ts });
            saveDb(dataPath, db);
            sendJson(res, 200, { id });
            return;
          }

          const auditMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/audit$/);
          if (auditMatch && req.method === "POST") {
            const roomId = auditMatch[1];
            const body = await readBody(req);
            const parsed = z
              .object({ kind: z.string().min(1).max(50).default("note"), message: z.string().min(1).max(2000) })
              .safeParse(JSON.parse(body || "{}"));
            if (!parsed.success) return sendJson(res, 400, { error: parsed.error.flatten() });

            const db = loadDb(dataPath);
            const room = roomById(db, roomId);
            if (!room) return sendJson(res, 404, { error: "not_found" });

            const ts = now();
            db.audit.push({ id: nanoid(), room_id: roomId, kind: parsed.data.kind, message: parsed.data.message, created_at: ts });
            room.updated_at = ts;
            saveDb(dataPath, db);
            sendJson(res, 200, { ok: true });
            return;
          }

          const commentsMatch = pathname.match(/^\/api\/rooms\/([^/]+)\/comments$/);
          if (commentsMatch && req.method === "GET") {
            const roomId = commentsMatch[1];
            const db = loadDb(dataPath);
            const room = roomById(db, roomId);
            if (!room) return sendJson(res, 404, { error: "not_found" });
            sendJson(res, 200, { comments: (db.comments[roomId] || []).slice(-200) });
            return;
          }

          if (commentsMatch && req.method === "POST") {
            const roomId = commentsMatch[1];
            const body = await readBody(req);
            const parsed = z
              .object({ author: z.string().max(80).optional(), message: z.string().min(1).max(2000) })
              .safeParse(JSON.parse(body || "{}"));
            if (!parsed.success) return sendJson(res, 400, { error: parsed.error.flatten() });

            const db = loadDb(dataPath);
            const room = roomById(db, roomId);
            if (!room) return sendJson(res, 404, { error: "not_found" });

            const ts = now();
            const id = nanoid();
            const comment: Comment = { id, room_id: roomId, author: parsed.data.author, message: parsed.data.message, created_at: ts };
            if (!db.comments[roomId]) db.comments[roomId] = [];
            db.comments[roomId].push(comment);
            room.updated_at = ts;
            db.audit.push({ id: nanoid(), room_id: roomId, kind: "comment", message: `Comment added: ${parsed.data.message.substring(0, 80)}`, created_at: ts });
            saveDb(dataPath, db);
            sendJson(res, 200, { id });
            return;
          }

          // forgiving fallback
          if (req.method === "GET") {
            res.statusCode = 302;
            res.setHeader("location", withBase(basePath, "/"));
            res.end();
            return;
          }

          res.statusCode = 404;
          res.end("Not Found");
        } catch (err) {
          api.logger.error(`[pocket-portal] request failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(cfg.port, cfg.host, () => resolve());
      });

      (ctx as any)._pocketPortalServer = server;
      api.logger.info(`[pocket-portal] listening on http://${cfg.host}:${cfg.port}${basePath === "/" ? "" : basePath}`);
    },

    async stop(ctx) {
      const server: http.Server | undefined = (ctx as any)._pocketPortalServer;
      if (!server) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      (ctx as any)._pocketPortalServer = undefined;
    },
  });
}
