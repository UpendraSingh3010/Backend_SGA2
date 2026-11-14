/**
 * User Service - registration, login (JWT issuing), token verification and
 * user administration. Routes are mounted at /api/users/*.
 */
const express = require('express');
const createServiceApp = require('../../shared/createServiceApp');
const { User } = require('../../shared/models');
const { HttpError } = require('../../shared/errors');
const { ROLES, signToken, authenticate, authorize } = require('../../shared/auth');
const config = require('../../config');

const PASSWORD_MIN = 8;

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw new HttpError(400, `password must be at least ${PASSWORD_MIN} characters`, {
      code: 'VALIDATION_ERROR',
      details: [{ field: 'password', message: `minimum length is ${PASSWORD_MIN}` }],
    });
  }
}

async function createUser({ name, email, password, phone, role }) {
  validatePassword(password);
  const user = new User({ name, email, phone, role });
  await user.setPassword(password);
  await user.save();
  return user;
}

function createUsersApp() {
  const router = express.Router();

  // Public self-registration. Always creates a 'driver' account; only admins
  // can create admins / fleet managers (POST /api/users).
  router.post('/api/users/register', async (req, res) => {
    const { name, email, password, phone } = req.body || {};
    const user = await createUser({ name, email, password, phone, role: ROLES.DRIVER });
    res.status(201).json({ user });
  });

  router.post('/api/users/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      throw new HttpError(400, 'email and password are required', { code: 'VALIDATION_ERROR' });
    }
    const user = await User.findOne({ email: String(email).toLowerCase() }).select('+passwordHash');
    if (!user || !(await user.checkPassword(password))) {
      throw new HttpError(401, 'Invalid email or password', { code: 'INVALID_CREDENTIALS' });
    }
    if (!user.active) {
      throw new HttpError(403, 'Account is disabled', { code: 'ACCOUNT_DISABLED' });
    }
    res.json({
      token: signToken(user),
      tokenType: 'Bearer',
      expiresIn: config.jwt.expiresIn,
      user,
    });
  });

  // Verifies the bearer token and returns its decoded claims
  router.get('/api/users/verify-token', authenticate, (req, res) => {
    const { sub, role, name, email, iat, exp, iss } = req.tokenClaims;
    res.json({
      valid: true,
      claims: { sub, role, name, email, iss },
      issuedAt: new Date(iat * 1000).toISOString(),
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  });

  router.get('/api/users/me', authenticate, async (req, res) => {
    const user = await User.findById(req.user.id);
    if (!user) throw new HttpError(404, 'User not found');
    res.json({ user });
  });

  router.get(
    '/api/users',
    authenticate,
    authorize(ROLES.ADMIN, ROLES.FLEET_MANAGER),
    async (req, res) => {
      const filter = {};
      if (req.query.role) filter.role = req.query.role;
      const users = await User.find(filter).sort({ createdAt: -1 });
      res.json({ data: users, total: users.length });
    }
  );

  // Admin creates a user with any role
  router.post('/api/users', authenticate, authorize(ROLES.ADMIN), async (req, res) => {
    const { name, email, password, phone, role } = req.body || {};
    const user = await createUser({ name, email, password, phone, role });
    res.status(201).json({ user });
  });

  router.get(
    '/api/users/:id',
    authenticate,
    authorize(ROLES.ADMIN, ROLES.FLEET_MANAGER),
    async (req, res) => {
      const user = await User.findById(req.params.id);
      if (!user) throw new HttpError(404, 'User not found');
      res.json({ user });
    }
  );

  router.patch('/api/users/:id', authenticate, authorize(ROLES.ADMIN), async (req, res) => {
    const allowed = ['name', 'phone', 'role', 'notificationsEnabled', 'active'];
    const user = await User.findById(req.params.id);
    if (!user) throw new HttpError(404, 'User not found');
    for (const key of allowed) {
      if (req.body && req.body[key] !== undefined) user[key] = req.body[key];
    }
    await user.save();
    res.json({ user });
  });

  return createServiceApp('users', router);
}

module.exports = { createUsersApp, createUser };
