const path = require('path');
const express = require('express');
const { nanoid } = require('nanoid');
const { z } = require('zod');
const { openDb } = require('./db');

const PORT = Number(process.env.PORT || 4377);
const HOST = process.env.HOST || '0.0.0.0'; // bind is further restricted via firewall; can set HOST=192.168.0.145

const app = express();
const db = openDb();

app.use(express.json({ limit: '2mb' }));
const STATIC_DIR = path.join(__dirname, '..', 'static');
app.use('/static', express.static(STATIC_DIR));

function now() {
  return new Date().toISOString();
}

// --- API ---

app.get('/api/health', (req, res) => {
  try {
    // DB probe
    const v = db.pragma('user_version', { simple: true });
    res.json({ ok: true, ts: now(), db: { ok: true, user_version: v }, version: '0.1.0' });
  } catch (e) {
    res.status(500).json({ ok: false, ts: now(), error: String(e) });
  }
});

app.get('/api/rooms', (req, res) => {
  const rooms = db.prepare('select id, title, created_at, updated_at from rooms order by updated_at desc').all();
  res.json({ rooms });
});

app.post('/api/rooms', (req, res) => {
  const schema = z.object({ title: z.string().min(1).max(200) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const id = nanoid();
  const ts = now();
  db.prepare('insert into rooms (id, title, created_at, updated_at) values (?, ?, ?, ?)')
    .run(id, parsed.data.title, ts, ts);

  db.prepare('insert or ignore into notes (room_id, markdown, updated_at) values (?, ?, ?)')
    .run(id, '', ts);

  db.prepare('insert into audit (id, room_id, kind, message, created_at) values (?, ?, ?, ?, ?)')
    .run(nanoid(), id, 'system', 'Room created', ts);

  res.json({ id });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = db.prepare('select id, title, created_at, updated_at from rooms where id=?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'not_found' });

  const note = db.prepare('select markdown, updated_at from notes where room_id=?').get(req.params.id) || { markdown: '', updated_at: null };
  const actions = db.prepare('select id, text, done, created_at, updated_at from actions where room_id=? order by created_at desc').all(req.params.id);
  const audit = db.prepare('select id, kind, message, created_at from audit where room_id=? order by created_at desc limit 200').all(req.params.id);
  const artifacts = db.prepare('select id, title, url, created_at from artifacts where room_id=? order by created_at desc').all(req.params.id);

  res.json({ room, note, actions, audit, artifacts });
});

app.post('/api/rooms/:id/title', (req, res) => {
  const schema = z.object({ title: z.string().min(1).max(200) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ts = now();
  const info = db.prepare('update rooms set title=?, updated_at=? where id=?').run(parsed.data.title, ts, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });

  db.prepare('insert into audit (id, room_id, kind, message, created_at) values (?, ?, ?, ?, ?)')
    .run(nanoid(), req.params.id, 'edit', `Title changed to: ${parsed.data.title}`, ts);

  res.json({ ok: true });
});

app.post('/api/rooms/:id/notes', (req, res) => {
  const schema = z.object({ markdown: z.string().max(200000) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ts = now();
  const room = db.prepare('select id from rooms where id=?').get(req.params.id);
  if (!room) return res.status(404).json({ error: 'not_found' });

  db.prepare('insert into notes (room_id, markdown, updated_at) values (?, ?, ?) on conflict(room_id) do update set markdown=excluded.markdown, updated_at=excluded.updated_at')
    .run(req.params.id, parsed.data.markdown, ts);
  db.prepare('update rooms set updated_at=? where id=?').run(ts, req.params.id);
  db.prepare('insert into audit (id, room_id, kind, message, created_at) values (?, ?, ?, ?, ?)')
    .run(nanoid(), req.params.id, 'note', 'Notes updated', ts);

  res.json({ ok: true });
});

app.post('/api/rooms/:id/actions', (req, res) => {
  const schema = z.object({ text: z.string().min(1).max(500) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ts = now();
  const id = nanoid();
  db.prepare('insert into actions (id, room_id, text, done, created_at, updated_at) values (?, ?, ?, 0, ?, ?)')
    .run(id, req.params.id, parsed.data.text, ts, ts);
  db.prepare('update rooms set updated_at=? where id=?').run(ts, req.params.id);
  db.prepare('insert into audit (id, room_id, kind, message, created_at) values (?, ?, ?, ?, ?)')
    .run(nanoid(), req.params.id, 'action', `Action added: ${parsed.data.text}`, ts);

  res.json({ id });
});

app.post('/api/actions/:actionId/toggle', (req, res) => {
  const ts = now();
  const row = db.prepare('select id, room_id, done, text from actions where id=?').get(req.params.actionId);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const newDone = row.done ? 0 : 1;
  db.prepare('update actions set done=?, updated_at=? where id=?').run(newDone, ts, row.id);
  db.prepare('update rooms set updated_at=? where id=?').run(ts, row.room_id);
  db.prepare('insert into audit (id, room_id, kind, message, created_at) values (?, ?, ?, ?, ?)')
    .run(nanoid(), row.room_id, 'action', `Action ${newDone ? 'done' : 'undone'}: ${row.text}`, ts);

  res.json({ ok: true, done: !!newDone });
});

app.post('/api/rooms/:id/audit', (req, res) => {
  const schema = z.object({ kind: z.string().min(1).max(50).default('note'), message: z.string().min(1).max(2000) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ts = now();
  db.prepare('insert into audit (id, room_id, kind, message, created_at) values (?, ?, ?, ?, ?)')
    .run(nanoid(), req.params.id, parsed.data.kind, parsed.data.message, ts);
  db.prepare('update rooms set updated_at=? where id=?').run(ts, req.params.id);

  res.json({ ok: true });
});

app.post('/api/rooms/:id/artifacts', (req, res) => {
  const schema = z.object({ title: z.string().min(1).max(200), url: z.string().min(1).max(2000) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ts = now();
  const id = nanoid();
  db.prepare('insert into artifacts (id, room_id, title, url, created_at) values (?, ?, ?, ?, ?)')
    .run(id, req.params.id, parsed.data.title, parsed.data.url, ts);
  db.prepare('update rooms set updated_at=? where id=?').run(ts, req.params.id);
  db.prepare('insert into audit (id, room_id, kind, message, created_at) values (?, ?, ?, ?, ?)')
    .run(nanoid(), req.params.id, 'artifact', `Artifact added: ${parsed.data.title}`, ts);

  res.json({ id });
});

// --- UI ---
app.get('/', (req, res) => {
  // Use {root} to avoid edge cases with absolute paths under launchd.
  res.sendFile('index.html', { root: STATIC_DIR });
});

app.get('/rooms/:id', (req, res) => {
  res.sendFile('room.html', { root: STATIC_DIR });
});

// Be forgiving: some chat clients copy/paste stray characters (e.g. backticks) into the path.
// Redirect unknown routes back to home (but keep /api/* 404s as-is).
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.redirect('/');
});

app.listen(PORT, HOST, () => {
  console.log(`[pocket-portal] listening on http://${HOST}:${PORT}`);
});
