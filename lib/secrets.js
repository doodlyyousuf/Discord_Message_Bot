/**
 * Encrypts secrets (the Discord bot token) before they touch the database,
 * using AES-256-GCM with a key supplied via the TOKEN_ENC_KEY env var.
 *
 * If no key is configured, values are stored as-is for backwards
 * compatibility, and a warning is logged at startup.
 */
import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';

function getKey() {
  const rawKey = process.env.TOKEN_ENC_KEY || '';
  if (!rawKey) return null;
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) key = Buffer.from(rawKey, 'hex');
  else key = Buffer.from(rawKey, 'base64');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENC_KEY must decode to 32 bytes (use 64 hex chars or base64)');
  }
  return key;
}

export function encryptionEnabled() {
  return Boolean(getKey());
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(plain) {
  const key = getKey();
  if (!key) return String(plain);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${data.toString('base64')}`;
}

export function decryptSecret(value) {
  if (!isEncrypted(value)) return value;
  const key = getKey();
  if (!key) throw new Error('TOKEN_ENC_KEY is required to decrypt the stored token');
  const [ivB64, tagB64, dataB64] = value.slice(PREFIX.length).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
