/**
 * Minimal in-memory rate limiting / abuse protection.
 *
 * Each limiter keeps a fixed-window counter per key (usually a client IP).
 * State lives in process memory and resets on restart, which is fine for a
 * single-instance app like this one.
 */

export function clientIp(req, { trustProxy = false } = {}) {
  // Only trust X-Forwarded-For when we know a reverse proxy sets it,
  // otherwise a client could spoof the header and bypass every limit.
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      const first = xff.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

export function createRateLimiter({ windowMs, max, name = 'limiter' }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.max(1000, Math.min(windowMs, 60_000)));
  if (typeof sweep.unref === 'function') sweep.unref();

  function check(key) {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    return {
      allowed: entry.count <= max,
      remaining: Math.max(0, max - entry.count),
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      resetAt: entry.resetAt,
    };
  }

  function reset(key) {
    hits.delete(key);
  }

  return { name, windowMs, max, check, reset, size: () => hits.size };
}

/**
 * Enforce a limiter; when the limit is exceeded it writes a 429 and returns
 * false so the caller can stop handling the request.
 */
export function enforceRateLimit(res, limiter, key, sendJson) {
  const result = limiter.check(key);
  res.setHeader('X-RateLimit-Limit', String(limiter.max));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  if (!result.allowed) {
    sendJson(res, 429, { error: 'Too many requests. Please slow down and try again later.' }, {
      'Retry-After': String(result.retryAfter),
      'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
    });
    return false;
  }
  return true;
}
