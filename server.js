'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '10m' }));

function pgConfig(overrideUrl) {
  const raw = overrideUrl || process.env.DATABASE_URL || '';
  const needsSsl = /sslmode=require|sslmode=verify/i.test(raw) || process.env.PGSSL === '1';
  const connectionString = /sslmode=/.test(raw) ? raw : raw + (raw ? (raw.indexOf('?') === -1 ? '?' : '&') + 'sslmode=require' : '');
  return {
    connectionString,
    ssl: needsSsl || !/localhost|127\.0\.0\.1/.test(raw) ? { rejectUnauthorized: false } : false,
    max: 5,
    options: '-c search_path=public'
  };
}

const pool = new Pool(pgConfig());
pool.on('error', (err) => console.error('pg pool error', err.message));

const PEER_TIMEOUT_MS = 2200; // poll-only fallback: polls run every 700ms; silent peers clear in ~2.2s
const STREAM_CLOSE_GRACE_MS = 300; // SSE stream disconnect clears peer almost immediately unless reconnected
const STREAM_HEARTBEAT_MS = 15000;
const ROOM_TTL_HOURS = 12;
const IDLE_EXPIRY_MS = 10 * 60 * 1000;

// In-memory signaling state. Rooms themselves are persisted in Postgres.
// roomId -> { peers: Map(peerId -> {name, joinedAt, lastSeen, nextSeq, inbox: [], streams: Set, closeTimer}) }
const rooms = new Map();

function roomState(roomId) {
  let r = rooms.get(roomId);
  if (!r) {
    r = { peers: new Map(), emptySince: Date.now() };
    rooms.set(roomId, r);
  }
  return r;
}

// Mark when a room last became empty; cleared as soon as someone is present.
function touchEmpty(state) {
  if (state.peers.size === 0) {
    if (!state.emptySince) state.emptySince = Date.now();
  } else {
    state.emptySince = null;
  }
}

function sanitize(text, max) {
  const s = String(text == null ? '' : text).replace(/[\r\n\t]+/g, ' ').trim();
  return s.slice(0, max);
}

function hashPasscode(code) {
  return crypto.createHash('sha256').update('linkup:v1:' + String(code)).digest('hex');
}

function newRoomId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let id = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i += 1) id += alphabet[bytes[i] % alphabet.length];
  return id;
}

function makePeer(name) {
  return { name, joinedAt: Date.now(), lastSeen: Date.now(), nextSeq: 1, inbox: [], streams: new Set(), closeTimer: null };
}

function clearPeerCloseTimer(peer) {
  if (peer && peer.closeTimer) {
    clearTimeout(peer.closeTimer);
    peer.closeTimer = null;
  }
}

function sendSse(res, event, data) {
  try {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  } catch (e) { /* socket closing */ }
}

function broadcastPeers(state) {
  const list = publicPeers(state);
  for (const peer of state.peers.values()) {
    for (const res of peer.streams) {
      sendSse(res, 'peers', { peers: list });
    }
  }
}

function removePeer(state, peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return false;
  clearPeerCloseTimer(peer);
  for (const res of peer.streams) {
    try { res.end(); } catch (e) { /* ignore */ }
  }
  peer.streams.clear();
  state.peers.delete(peerId);
  touchEmpty(state);
  broadcastPeers(state);
  return true;
}

function prunePeers(state) {
  const now = Date.now();
  let removed = false;
  for (const [peerId, peer] of state.peers) {
    if (peer.streams.size > 0) {
      peer.lastSeen = now;
      continue;
    }
    if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
      clearPeerCloseTimer(peer);
      state.peers.delete(peerId);
      removed = true;
    }
  }
  if (removed) {
    touchEmpty(state);
    broadcastPeers(state);
  }
  return removed;
}

function publicPeers(state) {
  return Array.from(state.peers.entries())
    .map(([id, p]) => ({ id, name: p.name, joinedAt: p.joinedAt }))
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

// Schema changes run with the migrator role when one is provided, then the
// runtime role is granted access. This keeps the runtime role read/write only.
async function initDb() {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL || '';
  const migrator = migrationUrl ? new Pool(pgConfig(migrationUrl)) : pool;
  try {
    await migrator.query(`CREATE TABLE IF NOT EXISTS rooms (
      id text PRIMARY KEY,
      title text NOT NULL,
      host_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await migrator.query(`CREATE TABLE IF NOT EXISTS room_visits (
      id bigserial PRIMARY KEY,
      room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      visitor_name text NOT NULL,
      joined_at timestamptz NOT NULL DEFAULT now()
    )`);
    await migrator.query('CREATE INDEX IF NOT EXISTS room_visits_room_idx ON room_visits(room_id)');
    await migrator.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS passcode_hash text');
    await migrator.query('ALTER TABLE rooms ADD COLUMN IF NOT EXISTS listed boolean NOT NULL DEFAULT false');
    if (migrator !== pool) {
      const roleRes = await pool.query('SELECT current_user AS cu');
      const runtimeRole = roleRes.rows[0].cu;
      const ident = '"' + String(runtimeRole).replace(/"/g, '""') + '"';
      await migrator.query('GRANT USAGE ON SCHEMA public TO ' + ident);
      await migrator.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ' + ident);
      await migrator.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ' + ident);
    }
  } finally {
    if (migrator !== pool) await migrator.end().catch(() => {});
  }
}

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    dbReady = true;
    res.json({ ok: true, db: true, rooms: rooms.size });
  } catch (e) {
    res.json({ ok: true, db: false, error: e.message, rooms: rooms.size });
  }
});

app.post('/api/rooms', async (req, res) => {
  try {
    const title = sanitize(req.body && req.body.title, 80) || 'Untitled meeting';
    const hostName = sanitize(req.body && req.body.hostName, 40) || 'Host';
    const passcode = sanitize(req.body && req.body.passcode, 40);
    const passcodeHash = passcode ? hashPasscode(passcode) : null;
    let id = newRoomId();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const exists = await pool.query('SELECT 1 FROM rooms WHERE id = $1', [id]);
      if (exists.rowCount === 0) break;
      id = newRoomId();
    }
    const listed = Boolean(req.body && req.body.listed === true) && !passcodeHash;
    await pool.query('INSERT INTO rooms (id, title, host_name, passcode_hash, listed) VALUES ($1, $2, $3, $4, $5)', [id, title, hostName, passcodeHash, listed]);
    res.json({ roomId: id, title, hostName });
  } catch (e) {
    console.error('create room failed', e.message);
    res.status(500).json({ error: 'Could not create room' });
  }
});

app.get('/api/rooms/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, title, host_name, created_at, passcode_hash FROM rooms WHERE id = $1', [req.params.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'Room not found' });
    const row = r.rows[0];
    const visits = await pool.query('SELECT count(*)::int AS n FROM room_visits WHERE room_id = $1', [row.id]);
    res.json({ id: row.id, title: row.title, hostName: row.host_name, createdAt: row.created_at, visits: visits.rows[0].n, locked: Boolean(row.passcode_hash) });
  } catch (e) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

app.get('/api/recent', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, title, host_name, created_at FROM rooms
       WHERE listed = true AND passcode_hash IS NULL AND created_at > now() - interval '12 hours'
       ORDER BY created_at DESC LIMIT 12`
    );
    res.json({ rooms: r.rows.map((row) => ({ id: row.id, title: row.title, hostName: row.host_name, createdAt: row.created_at })) });
  } catch (e) {
    res.json({ rooms: [] });
  }
});

app.post('/api/rooms/:id/join', async (req, res) => {
  try {
    const roomId = req.params.id;
    const found = await pool.query('SELECT id FROM rooms WHERE id = $1', [roomId]);
    if (found.rowCount === 0) return res.status(404).json({ error: 'Room not found' });
    const lockedRow = await pool.query('SELECT passcode_hash FROM rooms WHERE id = $1', [roomId]);
    const expectedHash = lockedRow.rows[0] && lockedRow.rows[0].passcode_hash;
    if (expectedHash) {
      const given = sanitize(req.body && req.body.passcode, 40);
      const givenHash = given ? hashPasscode(given) : '';
      const a = Buffer.from(givenHash);
      const b = Buffer.from(String(expectedHash));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(403).json({ error: 'passcode', locked: true });
      }
    }
    const name = sanitize(req.body && req.body.name, 40) || 'Guest';
    const state = roomState(roomId);
    prunePeers(state);
    const peerId = crypto.randomUUID();
    state.peers.set(peerId, makePeer(name));
    state.emptySince = null;
    broadcastPeers(state);
    pool.query('INSERT INTO room_visits (room_id, visitor_name) VALUES ($1, $2)', [roomId, name]).catch(() => {});
    res.json({ peerId, name, peers: publicPeers(state) });
  } catch (e) {
    res.status(500).json({ error: 'Join failed' });
  }
});

app.post('/api/rooms/:id/signal', (req, res) => {
  const state = roomState(req.params.id);
  const from = sanitize(req.body && req.body.from, 80);
  const to = sanitize(req.body && req.body.to, 80);
  const payload = req.body && req.body.payload;
  const sender = state.peers.get(from);
  const target = state.peers.get(to);
  if (!sender || !target || !payload) return res.status(204).end();
  sender.lastSeen = Date.now();
  const msg = { seq: target.nextSeq++, from, payload };
  if (target.streams.size > 0) {
    for (const streamRes of target.streams) {
      sendSse(streamRes, 'signal', msg);
    }
  }
  target.inbox.push(msg);
  if (target.inbox.length > 200) target.inbox.splice(0, target.inbox.length - 200);
  res.json({ ok: true });
});

app.get('/api/rooms/:id/stream', (req, res) => {
  const state = roomState(req.params.id);
  prunePeers(state);
  const peerId = sanitize(req.query.peerId, 80);
  const peer = state.peers.get(peerId);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (!peer) {
    sendSse(res, 'gone', { gone: true, peers: publicPeers(state) });
    return res.end();
  }
  clearPeerCloseTimer(peer);
  peer.lastSeen = Date.now();
  peer.streams.add(res);
  sendSse(res, 'peers', { peers: publicPeers(state) });
  if (peer.inbox.length > 0) {
    const pending = peer.inbox;
    peer.inbox = [];
    for (const msg of pending) sendSse(res, 'signal', msg);
  }
  const hb = setInterval(() => {
    if (!state.peers.has(peerId)) {
      clearInterval(hb);
      try { res.end(); } catch (e) { /* ignore */ }
      return;
    }
    peer.lastSeen = Date.now();
    try { res.write(': keepalive\n\n'); } catch (e) { /* ignore */ }
  }, STREAM_HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(hb);
    const current = state.peers.get(peerId);
    if (!current) return;
    current.streams.delete(res);
    if (current.streams.size === 0) {
      const closedAt = Date.now();
      clearPeerCloseTimer(current);
      current.closeTimer = setTimeout(() => {
        const latest = state.peers.get(peerId);
        if (!latest || latest.streams.size > 0) return;
        if (latest.lastSeen > closedAt) return;
        removePeer(state, peerId);
      }, STREAM_CLOSE_GRACE_MS);
    }
  });
});

app.get('/api/rooms/:id/poll', (req, res) => {
  const state = roomState(req.params.id);
  prunePeers(state);
  const peerId = sanitize(req.query.peerId, 80);
  const peer = state.peers.get(peerId);
  if (!peer) return res.json({ gone: true, peers: publicPeers(state), messages: [] });
  peer.lastSeen = Date.now();
  clearPeerCloseTimer(peer);
  const messages = peer.inbox;
  peer.inbox = [];
  res.json({ gone: false, peers: publicPeers(state), messages });
});

app.post('/api/rooms/:id/leave', (req, res) => {
  const state = rooms.get(req.params.id);
  const peerId = sanitize(req.body && req.body.peerId, 80);
  if (state) removePeer(state, peerId);
  res.json({ ok: true });
});

app.get('/r/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = Number(process.env.PORT || 8080);

let dbReady = false;
let dbAttempts = 0;

function boot() {
  dbAttempts += 1;
  return initDb()
    .then(() => {
      dbReady = true;
      console.log('database ready (attempt ' + dbAttempts + ')');
    })
    .catch((err) => {
      console.error('db init failed attempt ' + dbAttempts + ': ' + err.message);
      if (dbAttempts < 15) return new Promise((r) => setTimeout(r, 2000)).then(boot);
      console.error('database unavailable; serving with in-memory signaling only');
      return null;
    });
}

app.listen(port, '0.0.0.0', () => console.log('LinkUp listening on ' + port));
boot();

// Auto-expire rooms that have stayed empty for IDLE_EXPIRY_MS: drop the
// in-memory signaling state and the stored room (passcode and visit log).
function expireIdleRooms() {
  const now = Date.now();
  for (const [roomId, state] of rooms) {
    prunePeers(state);
    touchEmpty(state);
    if (state.peers.size === 0 && state.emptySince && now - state.emptySince > IDLE_EXPIRY_MS) {
      rooms.delete(roomId);
      pool.query('DELETE FROM rooms WHERE id = $1', [roomId]).catch(() => {});
    }
  }
}

setInterval(() => {
  for (const state of rooms.values()) prunePeers(state);
}, 1000);

setInterval(expireIdleRooms, 30000);

setInterval(() => {
  pool.query('DELETE FROM rooms WHERE created_at < now() - interval \'24 hours\'').catch(() => {});
}, 3600000);
