const API_BASE = 'https://discord.com/api/v10';

export class DiscordError extends Error {
  constructor(status, body) {
    super(`Discord API ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

async function request(token, endpoint, options = {}, tokenType = 'bot') {
  const authScheme = tokenType === 'account' ? 'Bearer' : 'Bot';
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `${authScheme} ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'DiscordScheduler (https://localhost, 1.0.0)',
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text */
  }

  if (!res.ok) throw new DiscordError(res.status, body);
  return body;
}

export function getMe(token, tokenType = 'bot') {
  return request(token, '/users/@me', {}, tokenType);
}

export function getGuilds(token, tokenType = 'bot') {
  return request(token, '/users/@me/guilds', {}, tokenType);
}

export async function getTextChannels(token, guildId, tokenType = 'bot') {
  const channels = await request(token, `/guilds/${guildId}/channels`, {}, tokenType);
  return (channels || [])
    .filter((c) => [0, 5, 15].includes(c.type))
    .sort((a, b) => (a.position || 0) - (b.position || 0))
    .map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id || null }));
}

export function sendMessage(token, channelId, content, tokenType = 'bot') {
  return request(token, `/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: String(content).slice(0, 2000) }),
  }, tokenType);
}
