import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './lib/store.js';
import * as scheduler from './lib/scheduler.js';
import { getMe, getGuilds, getTextChannels, DiscordError } from './lib/discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ helpers */

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionCookie(token) {
  return `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
}

function clearCookie() {
  return 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 25 * 1024 * 1024) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function parseDelimited(line, delim) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

export function parseImport(text, { hasHeader = false } = {}) {
  let raw = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');

  const candidates = [',', '\t', ';'];
  let delim = null;
  for (const d of candidates) {
    if (lines[0] && lines[0].includes(d)) {
      delim = d;
      break;
    }
  }

  let rows = [...lines];
  if (hasHeader && rows.length) rows = rows.slice(1);

  return rows
    .map((line) => {
      if (!delim) return line.trim();
      const fields = parseDelimited(line, delim);
      const first = fields.find((f) => f !== '') ?? '';
      return first;
    })
    .map((s) => s.trim())
    .filter(Boolean);
}

/* -------------------------------------------------------------------- routes */

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const segments = pathname.split('/').filter(Boolean); // ['api', ...]

  /* ---------------------------------------------------------- auth (public) */

  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = store.getSessionUser(parseCookies(req).sid);
    return sendJson(res, 200, {
      authenticated: Boolean(user),
      user: user || null,
      needsSetup: store.userCount() === 0,
    });
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    if (store.userCount() > 0) {
      return sendJson(res, 403, { error: 'An account already exists. Please sign in.' });
    }
    const { username, password } = await readBody(req);
    if (!username || !String(username).trim()) return sendJson(res, 400, { error: 'Username is required' });
    if (!password || String(password).length < 4) {
      return sendJson(res, 400, { error: 'Password must be at least 4 characters' });
    }
    try {
      const user = store.createUser(username, password);
      const token = store.createSession(user.id);
      store.addLog('info', `User "${user.username}" created`);
      return sendJson(res, 200, { ok: true, user }, { 'Set-Cookie': sessionCookie(token) });
    } catch (err) {
      const msg = /UNIQUE/.test(err.message) ? 'That username is taken' : err.message;
      return sendJson(res, 400, { error: msg });
    }
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const { username, password } = await readBody(req);
    const user = store.verifyUser(username, password);
    if (!user) return sendJson(res, 401, { error: 'Invalid username or password' });
    const token = store.createSession(user.id);
    return sendJson(res, 200, { ok: true, user }, { 'Set-Cookie': sessionCookie(token) });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    store.deleteSession(parseCookies(req).sid);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  }

  /* ------------------------------------------------------- auth (protected) */

  const authUser = store.getSessionUser(parseCookies(req).sid);
  if (!authUser) {
    return sendJson(res, 401, { error: 'Not authenticated', unauthorized: true });
  }

  // GET /api/state
  if (method === 'GET' && pathname === '/api/state') {
    return sendJson(res, 200, {
      config: store.publicConfig(),
      stats: store.stats(),
      tasks: store.listTasks(),
      messageCount: store.messageCount(),
    });
  }

  // POST /api/connect
  if (method === 'POST' && pathname === '/api/connect') {
    const { token } = await readBody(req);
    if (!token || !String(token).trim()) {
      return sendJson(res, 400, { error: 'Bot token is required' });
    }
    try {
      const user = await getMe(String(token).trim());
      store.setConfig({ token: String(token).trim(), connected: true, user: { id: user.id, username: user.username } });
      store.addLog('success', `Connected to Discord bot: ${user.username}`);
      return sendJson(res, 200, { ok: true, user: { id: user.id, username: user.username }, config: store.publicConfig() });
    } catch (err) {
      const msg = err instanceof DiscordError ? `Discord rejected the token (${err.status}).` : err.message;
      return sendJson(res, 400, { error: msg });
    }
  }

  // POST /api/disconnect
  if (method === 'POST' && pathname === '/api/disconnect') {
    scheduler.stopAll();
    store.setConfig({ token: null, connected: false, user: null, guildId: null, channelId: null });
    store.addLog('info', 'Disconnected Discord bot');
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/config
  if (method === 'POST' && pathname === '/api/config') {
    const body = await readBody(req);
    const patch = {};
    if ('guildId' in body) patch.guildId = body.guildId || null;
    if ('channelId' in body) patch.channelId = body.channelId || null;
    store.setConfig(patch);
    return sendJson(res, 200, { ok: true, config: store.publicConfig() });
  }

  // GET /api/guilds
  if (method === 'GET' && pathname === '/api/guilds') {
    if (!store.getToken()) return sendJson(res, 400, { error: 'Not connected' });
    try {
      const guilds = await getGuilds(store.getToken());
      return sendJson(res, 200, { guilds: (guilds || []).map((g) => ({ id: g.id, name: g.name })) });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // GET /api/guilds/:id/channels
  if (method === 'GET' && segments[1] === 'guilds' && segments[3] === 'channels') {
    if (!store.getToken()) return sendJson(res, 400, { error: 'Not connected' });
    try {
      const channels = await getTextChannels(store.getToken(), segments[2]);
      return sendJson(res, 200, { channels });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // /api/messages
  if (segments[1] === 'messages') {
    if (method === 'GET' && segments.length === 2) {
      const search = url.searchParams.get('search') || '';
      const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      return sendJson(res, 200, store.listMessages({ search, limit, offset }));
    }

    if (method === 'POST' && segments.length === 2) {
      const body = await readBody(req);
      if (Array.isArray(body.contents)) {
        const added = store.addMessages(body.contents);
        store.addLog('info', `Imported ${added} messages`);
        return sendJson(res, 200, { ok: true, added });
      }
      if (!body.content || !String(body.content).trim()) {
        return sendJson(res, 400, { error: 'Message content is required' });
      }
      const msg = store.addMessage(body.content);
      return sendJson(res, 201, { ok: true, message: msg });
    }

    if (method === 'DELETE' && segments.length === 2) {
      const removed = store.clearMessages();
      store.addLog('warn', `Cleared all messages (${removed})`);
      return sendJson(res, 200, { ok: true, removed });
    }

    if (method === 'POST' && segments[2] === 'import') {
      const body = await readBody(req);
      const contents = parseImport(body.text, { hasHeader: Boolean(body.hasHeader) });
      if (!contents.length) return sendJson(res, 400, { error: 'No messages found in the uploaded file' });
      const added = store.addMessages(contents);
      store.addLog('info', `Imported ${added} messages from ${body.filename || 'file'}`);
      return sendJson(res, 200, { ok: true, added });
    }

    if (method === 'PUT' && segments[2]) {
      const body = await readBody(req);
      if (!body.content || !String(body.content).trim()) {
        return sendJson(res, 400, { error: 'Message content is required' });
      }
      const msg = store.updateMessage(segments[2], body.content);
      if (!msg) return sendJson(res, 404, { error: 'Message not found' });
      return sendJson(res, 200, { ok: true, message: msg });
    }

    if (method === 'DELETE' && segments[2]) {
      const ok = store.deleteMessage(segments[2]);
      if (!ok) return sendJson(res, 404, { error: 'Message not found' });
      return sendJson(res, 200, { ok: true });
    }
  }

  // /api/tasks
  if (segments[1] === 'tasks') {
    if (method === 'GET' && segments.length === 2) {
      return sendJson(res, 200, { tasks: store.listTasks() });
    }

    if (method === 'POST' && segments.length === 2) {
      const body = await readBody(req);
      if (!body.channelId) return sendJson(res, 400, { error: 'Select a server and channel first' });
      const task = store.createTask(body);
      store.addLog('info', `Created task "${task.name}"`);
      return sendJson(res, 201, { ok: true, task });
    }

    if (method === 'PUT' && segments[2] && segments.length === 3) {
      const body = await readBody(req);
      const task = store.updateTask(segments[2], body);
      if (!task) return sendJson(res, 404, { error: 'Task not found' });
      return sendJson(res, 200, { ok: true, task });
    }

    if (method === 'DELETE' && segments[2] && segments.length === 3) {
      const existing = store.getTask(segments[2]);
      if (!existing) return sendJson(res, 404, { error: 'Task not found' });
      scheduler.stopTask(segments[2]);
      store.deleteTask(segments[2]);
      store.addLog('info', `Deleted task "${existing.name}"`);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && segments[3]) {
      const action = segments[3];
      let result;
      if (action === 'start') result = scheduler.startTask(segments[2]);
      else if (action === 'pause') result = scheduler.pauseTask(segments[2]);
      else if (action === 'resume') result = scheduler.resumeTask(segments[2]);
      else if (action === 'stop') result = scheduler.stopTask(segments[2]);
      else return sendJson(res, 404, { error: 'Unknown action' });
      const status = result.ok ? 200 : 400;
      return sendJson(res, status, result);
    }
  }

  // /api/logs
  if (segments[1] === 'logs') {
    if (method === 'GET') {
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 50);
      return sendJson(res, 200, { logs: store.listLogs(limit) });
    }
    if (method === 'DELETE') {
      store.clearLogs();
      return sendJson(res, 200, { ok: true });
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
}

/* -------------------------------------------------------------- static files */

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, index) => {
        if (e2) {
          res.writeHead(404);
          return res.end('Not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store, must-revalidate' });
        res.end(index);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (['.html', '.js', '.css'].includes(ext)) {
      headers['Cache-Control'] = 'no-store, must-revalidate';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

/* --------------------------------------------------------------------- start */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else if (req.method === 'GET') {
      serveStatic(req, res, url);
    } else {
      sendJson(res, 405, { error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message || 'Internal error' });
  }
});

store.normalizeTasks();

server.listen(PORT, HOST, () => {
  console.log(`Discord Scheduler running at http://localhost:${PORT}`);
});
