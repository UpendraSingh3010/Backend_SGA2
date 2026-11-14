/** Gateway middleware: request ids, API key verification and rate limiting. */
const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const { errorBody } = require('../shared/errors');
const { safeEqual } = require('../shared/auth');

/** Gives every request a correlation id (kept if the client sent one). */
function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  req.headers['x-request-id'] = req.id;
  res.setHeader('X-Request-Id', req.id);
  next();
}

function maskKey(key) {
  return key.length <= 6 ? '***' : `${key.slice(0, 3)}***${key.slice(-3)}`;
}

/**
 * Verifies the `x-api-key` header against the configured keys.
 *  - missing key -> 401 API_KEY_MISSING
 *  - wrong key   -> 403 API_KEY_INVALID
 */
function verifyApiKey(validKeys) {
  return (req, res, next) => {
    const key = req.get('x-api-key');
    if (!key) {
      return res
        .status(401)
        .json(errorBody(401, 'API_KEY_MISSING', 'API key is required. Send it in the x-api-key header.', undefined, req.id));
    }
    const match = validKeys.find((k) => safeEqual(k, key));
    if (!match) {
      return res.status(403).json(errorBody(403, 'API_KEY_INVALID', 'The API key provided is not valid.', undefined, req.id));
    }
    req.apiKey = match;
    req.apiKeyMasked = maskKey(match);
    return next();
  };
}

/**
 * Fixed-window rate limit per API key. Adds standard RateLimit-* headers and
 * returns 429 with Retry-After when the limit is exceeded.
 */
function createRateLimiter({ windowMs, max }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => req.apiKey,
    handler: (req, res, next, options) => {
      const retryAfterSeconds = Math.ceil(options.windowMs / 1000);
      res
        .status(429)
        .json(
          errorBody(
            429,
            'RATE_LIMIT_EXCEEDED',
            `Too many requests: limit is ${options.limit} requests per ${retryAfterSeconds}s for this API key.`,
            { limit: options.limit, windowSeconds: retryAfterSeconds },
            req.id
          )
        );
    },
  });
}

module.exports = { requestId, verifyApiKey, createRateLimiter, maskKey };
