/**
 * JWT authentication + role-based access control (RBAC) middleware shared by
 * all services. Tokens are issued by the User Service and verified locally by
 * every service using the shared JWT secret (stateless auth).
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { HttpError } = require('./errors');

const ROLES = Object.freeze({
  ADMIN: 'admin',
  FLEET_MANAGER: 'fleet_manager',
  DRIVER: 'driver',
});

function signToken(user, options = {}) {
  return jwt.sign(
    {
      sub: String(user._id || user.id),
      role: user.role,
      name: user.name,
      email: user.email,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn, issuer: config.jwt.issuer, ...options }
  );
}

function verifyToken(token) {
  return jwt.verify(token, config.jwt.secret, { issuer: config.jwt.issuer });
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/** Requires a valid `Authorization: Bearer <jwt>` header. Sets req.user. */
function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(
      new HttpError(401, 'Missing or malformed Authorization header. Expected: Bearer <token>', {
        code: 'TOKEN_MISSING',
      })
    );
  }
  try {
    const claims = verifyToken(token);
    req.user = { id: claims.sub, role: claims.role, name: claims.name, email: claims.email };
    req.tokenClaims = claims;
    return next();
  } catch (err) {
    const expired = err.name === 'TokenExpiredError';
    return next(
      new HttpError(401, expired ? 'Token has expired' : 'Invalid token', {
        code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
      })
    );
  }
}

/** Allows the request only if req.user.role is one of `roles`. */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new HttpError(401, 'Authentication required', { code: 'TOKEN_MISSING' }));
    }
    if (!roles.includes(req.user.role)) {
      return next(
        new HttpError(
          403,
          `Role '${req.user.role}' is not allowed to perform this action. Allowed roles: ${roles.join(', ')}`,
          { code: 'INSUFFICIENT_ROLE' }
        )
      );
    }
    return next();
  };
}

function isInternalRequest(req) {
  const key = req.get('x-internal-key');
  return Boolean(key) && safeEqual(key, config.internalKey);
}

/**
 * Accepts either a trusted internal service call (x-internal-key) or a user JWT
 * with one of the given roles (any role if none are given).
 */
function authenticateOrInternal(...roles) {
  return (req, res, next) => {
    if (isInternalRequest(req)) {
      req.internal = true;
      req.user = { id: null, role: 'system', name: 'internal-service' };
      return next();
    }
    return authenticate(req, res, (err) => {
      if (err) return next(err);
      if (roles.length === 0) return next();
      return authorize(...roles)(req, res, next);
    });
  };
}

module.exports = {
  ROLES,
  signToken,
  verifyToken,
  safeEqual,
  authenticate,
  authorize,
  authenticateOrInternal,
  isInternalRequest,
};
