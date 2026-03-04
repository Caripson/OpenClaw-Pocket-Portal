const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function openDb() {
  const dataDir = path.join(__dirname, '..', 'data');
  ensureDir(dataDir);
  const dbPath = path.join(dataDir, 'pocket-portal.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    create table if not exists rooms (
      id text primary key,
      title text not null,
      created_at text not null,
      updated_at text not null
    );

    create table if not exists notes (
      room_id text primary key,
      markdown text not null,
      updated_at text not null,
      foreign key(room_id) references rooms(id) on delete cascade
    );

    create table if not exists actions (
      id text primary key,
      room_id text not null,
      text text not null,
      done integer not null default 0,
      created_at text not null,
      updated_at text not null,
      foreign key(room_id) references rooms(id) on delete cascade
    );

    create table if not exists audit (
      id text primary key,
      room_id text not null,
      kind text not null,
      message text not null,
      created_at text not null,
      foreign key(room_id) references rooms(id) on delete cascade
    );

    create table if not exists artifacts (
      id text primary key,
      room_id text not null,
      title text not null,
      url text not null,
      created_at text not null,
      foreign key(room_id) references rooms(id) on delete cascade
    );
  `);

  return db;
}

module.exports = { openDb };
