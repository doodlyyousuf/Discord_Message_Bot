import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { encryptSecret, decryptSecret, isEncrypted } from './secrets.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');
const JSON_FILE = path.join(DATA_DIR, 'store.json');
const MAX_LOGS = 500;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    guild_id TEXT,
    channel_id TEXT,
    channel_name TEXT,
    start_time TEXT,
    end_time TEXT,
    min_delay INTEGER,
    max_delay INTEGER,
    max_per_run INTEGER DEFAULT 0,
    run_mode TEXT DEFAULT 'scheduled',
    status TEXT DEFAULT 'idle',
    cursor INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    last_message_id INTEGER,
    last_sent_at TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT,
    message TEXT,
    task_id INTEGER,
    at TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT,
    expires_at INTEGER
  );
`);

const now = () => new Date().toISOString();

/* ------------------------------------------------------------- migration */

function migrateFromJson() {
  try {
    if (!fs.existsSync(JSON_FILE)) return;
    const already = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
    const configRows = db.prepare('SELECT COUNT(*) AS c FROM config').get().c;
    if (already > 0 || configRows > 0) return;

    const data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
    for (const [key, value] of Object.entries(data.config || {})) {
      if (value === null || value === undefined) continue;
      setConfigValue(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    for (const m of data.messages || []) {
      db.prepare('INSERT INTO messages (content, uses, created_at) VALUES (?, ?, ?)').run(
        m.content,
        m.uses || 0,
        m.createdAt || now()
      );
    }
    for (const t of data.tasks || []) {
      db.prepare(
        `INSERT INTO tasks (name, guild_id, channel_id, channel_name, start_time, end_time,
          min_delay, max_delay, max_per_run, run_mode, status, cursor, sent_count, last_sent_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        t.name, t.guildId, t.channelId, t.channelName, t.startTime, t.endTime,
        t.minDelay, t.maxDelay, t.maxPerRun || 0, t.runMode || 'scheduled',
        'idle', t.cursor || 0, t.sentCount || 0, t.lastSentAt || null, t.createdAt || now()
      );
    }
    for (const l of data.logs || []) {
      db.prepare('INSERT INTO logs (level, message, task_id, at) VALUES (?,?,?,?)').run(
        l.level, l.message, l.taskId, l.at || now()
      );
    }
    setConfigValue('_migrated', 'true');
    console.log('[store] migrated existing data/store.json into SQLite');
  } catch (err) {
    console.error('[store] JSON migration failed:', err.message);
  }
}

/* ------------------------------------------------------------------ config */

function setConfigValue(key, value) {
  db.prepare(
    'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

function getConfigValue(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function getConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const cfg = { token: null, guildId: null, channelId: null, connected: false, user: null };
  for (const { key, value } of rows) {
    if (key.startsWith('_')) continue;
    if (key === 'connected') cfg.connected = value === 'true';
    else if (key === 'user') cfg.user = value ? JSON.parse(value) : null;
    else cfg[key] = value;
  }
  return cfg;
}

export function getToken() {
  const raw = getConfigValue('token');
  if (!raw) return null;
  try {
    return decryptSecret(raw);
  } catch (err) {
    console.error('[store] failed to decrypt stored token:', err.message);
    return null;
  }
}

export function setConfig(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) {
      db.prepare('DELETE FROM config WHERE key = ?').run(key);
    } else if (key === 'token') {
      setConfigValue(key, encryptSecret(String(value)));
    } else if (key === 'connected') {
      setConfigValue(key, value ? 'true' : 'false');
    } else if (typeof value === 'object') {
      setConfigValue(key, JSON.stringify(value));
    } else {
      setConfigValue(key, String(value));
    }
  }
  return getConfig();
}

export function publicConfig() {
  const cfg = getConfig();
  const { token, ...rest } = cfg;
  return { ...rest, hasToken: Boolean(token), connected: Boolean(token) && rest.connected };
}

/* ---------------------------------------------------------------- messages */

export function messageCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
}

function mapMessage(row) {
  return {
    id: row.id,
    content: row.content,
    uses: row.uses,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listMessages({ search = '', limit = 50, offset = 0 } = {}) {
  const q = String(search || '').trim();
  let rows;
  let total;
  if (q) {
    const like = `%${q}%`;
    total = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE content LIKE ?').get(like).c;
    rows = db
      .prepare('SELECT * FROM messages WHERE content LIKE ? ORDER BY id LIMIT ? OFFSET ?')
      .all(like, limit, offset);
  } else {
    total = messageCount();
    rows = db.prepare('SELECT * FROM messages ORDER BY id LIMIT ? OFFSET ?').all(limit, offset);
  }
  return { items: rows.map(mapMessage), total, limit, offset };
}

export function getMessage(id) {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id));
  return row ? mapMessage(row) : null;
}

export function addMessage(content) {
  const res = db
    .prepare('INSERT INTO messages (content, uses, created_at) VALUES (?, 0, ?)')
    .run(String(content).trim(), now());
  return getMessage(res.lastInsertRowid);
}

export function addMessages(contents) {
  const insert = db.prepare('INSERT INTO messages (content, uses, created_at) VALUES (?, 0, ?)');
  let count = 0;
  db.exec('BEGIN');
  try {
    for (const c of contents) {
      const text = String(c).trim();
      if (!text) continue;
      insert.run(text, now());
      count += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return count;
}

export function updateMessage(id, content) {
  const res = db
    .prepare('UPDATE messages SET content = ?, updated_at = ? WHERE id = ?')
    .run(String(content).trim(), now(), Number(id));
  return res.changes ? getMessage(id) : null;
}

export function deleteMessage(id) {
  return db.prepare('DELETE FROM messages WHERE id = ?').run(Number(id)).changes > 0;
}

export function clearMessages() {
  const total = messageCount();
  db.exec('DELETE FROM messages; DELETE FROM sqlite_sequence WHERE name = "messages";');
  return total;
}

export function nextMessageForTask(taskId) {
  const total = messageCount();
  if (!total) return null;
  const task = db.prepare('SELECT cursor FROM tasks WHERE id = ?').get(Number(taskId));
  const cursor = task ? Number(task.cursor) || 0 : 0;
  const row = db.prepare('SELECT * FROM messages ORDER BY id LIMIT 1 OFFSET ?').get(cursor % total);
  if (!row) return null;
  if (task) {
    db.prepare('UPDATE tasks SET cursor = ?, last_message_id = ? WHERE id = ?').run(
      (cursor + 1) % total,
      row.id,
      Number(taskId)
    );
  }
  db.prepare('UPDATE messages SET uses = uses + 1 WHERE id = ?').run(row.id);
  return { ...mapMessage(row), uses: row.uses + 1 };
}

/* ------------------------------------------------------------------- tasks */

function mapTask(row) {
  return {
    id: row.id,
    name: row.name,
    guildId: row.guild_id,
    channelId: row.channel_id,
    channelName: row.channel_name,
    startTime: row.start_time,
    endTime: row.end_time,
    minDelay: row.min_delay,
    maxDelay: row.max_delay,
    maxPerRun: row.max_per_run,
    runMode: row.run_mode || 'scheduled',
    status: row.status,
    cursor: row.cursor,
    sentCount: row.sent_count,
    lastMessageId: row.last_message_id,
    lastSentAt: row.last_sent_at,
    createdAt: row.created_at,
  };
}

export function listTasks() {
  return db.prepare('SELECT * FROM tasks ORDER BY id').all().map(mapTask);
}

export function getTask(id) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
  return row ? mapTask(row) : null;
}

export function createTask(data) {
  const minDelay = Math.max(1, Number(data.minDelay) || 30);
  const maxDelay = Math.max(minDelay, Number(data.maxDelay) || 120);
  const res = db
    .prepare(
      `INSERT INTO tasks (name, guild_id, channel_id, channel_name, start_time, end_time,
        min_delay, max_delay, max_per_run, run_mode, status, cursor, sent_count, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      String(data.name || 'Untitled task').trim(),
      data.guildId || null,
      data.channelId || null,
      data.channelName || null,
      data.startTime || '09:00',
      data.endTime || '21:00',
      minDelay,
      maxDelay,
      Number(data.maxPerRun) > 0 ? Number(data.maxPerRun) : 0,
      data.runMode === 'continuous' ? 'continuous' : 'scheduled',
      'idle',
      0,
      0,
      now()
    );
  return getTask(res.lastInsertRowid);
}

export function updateTask(id, patch) {
  const task = getTask(id);
  if (!task) return null;
  const merged = { ...task, ...patch };
  const minDelay = Math.max(1, Number(merged.minDelay) || 30);
  const maxDelay = Math.max(minDelay, Number(merged.maxDelay) || 120);
  db.prepare(
    `UPDATE tasks SET name=?, guild_id=?, channel_id=?, channel_name=?, start_time=?, end_time=?,
      min_delay=?, max_delay=?, max_per_run=?, run_mode=?, status=?, cursor=?, sent_count=?,
      last_sent_at=? WHERE id=?`
  ).run(
    merged.name,
    merged.guildId,
    merged.channelId,
    merged.channelName,
    merged.startTime,
    merged.endTime,
    minDelay,
    maxDelay,
    Number(merged.maxPerRun) > 0 ? Number(merged.maxPerRun) : 0,
    merged.runMode === 'continuous' ? 'continuous' : 'scheduled',
    merged.status || 'idle',
    Number(merged.cursor) || 0,
    Number(merged.sentCount) || 0,
    merged.lastSentAt || null,
    Number(id)
  );
  return getTask(id);
}

export function deleteTask(id) {
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(id)).changes > 0;
}

export function normalizeTasks() {
  db.prepare("UPDATE tasks SET status = 'stopped' WHERE status IN ('running','paused')").run();
}

/* -------------------------------------------------------------------- logs */

export function addLog(level, message, taskId = null) {
  db.prepare('INSERT INTO logs (level, message, task_id, at) VALUES (?,?,?,?)').run(
    level,
    message,
    taskId === null ? null : Number(taskId),
    now()
  );
  db.prepare(
    `DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)`
  ).run(MAX_LOGS);
}

function mapLog(row) {
  return { id: row.id, level: row.level, message: row.message, taskId: row.task_id, at: row.at };
}

export function listLogs(limit = 50) {
  return db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit).map(mapLog);
}

export function clearLogs() {
  db.exec('DELETE FROM logs; DELETE FROM sqlite_sequence WHERE name = "logs";');
}

/* ------------------------------------------------------------------- stats */

export function stats() {
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = db
    .prepare("SELECT COUNT(*) AS c FROM logs WHERE level = 'success' AND substr(at, 1, 10) = ?")
    .get(today).c;
  const totalSent = db.prepare('SELECT COALESCE(SUM(sent_count), 0) AS s FROM tasks').get().s;
  return {
    totalMessages: messageCount(),
    totalTasks: db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c,
    activeTasks: db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'running'").get().c,
    pausedTasks: db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status = 'paused'").get().c,
    sentToday,
    totalSent,
    recentActivity: listLogs(20),
  };
}

/* -------------------------------------------------------------------- auth */

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function hashCode(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function createUser(username, password) {
  const name = String(username || '').trim();
  if (!name || !password) throw new Error('Username and password are required');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashCode(password, salt);
  const res = db
    .prepare('INSERT INTO users (username, password_hash, salt, created_at) VALUES (?,?,?,?)')
    .run(name, hash, salt, now());
  return { id: res.lastInsertRowid, username: name };
}

export function verifyUser(username, password) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!row) return null;
  const candidate = Buffer.from(hashCode(String(password), row.salt), 'hex');
  const expected = Buffer.from(row.password_hash, 'hex');
  if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
    return null;
  }
  return { id: row.id, username: row.username };
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
    token,
    Number(userId),
    now(),
    Date.now() + SESSION_TTL_MS
  );
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return token;
}

export function getSessionUser(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(String(token));
  if (!row) return null;
  if (Number(row.expires_at) < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { id: row.id, username: row.username };
}

export function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(String(token));
}

/* ------------------------------------------------- token encryption at rest */

function encryptStoredToken() {
  const raw = getConfigValue('token');
  if (!raw || isEncrypted(raw)) return;
  const enc = encryptSecret(raw);
  if (enc !== raw) {
    setConfigValue('token', enc);
    console.log('[store] encrypted stored token at rest');
  }
}

migrateFromJson();
encryptStoredToken();
