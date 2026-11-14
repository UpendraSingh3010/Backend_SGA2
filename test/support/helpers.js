/** Test helpers: DB reset, fixtures and authenticated requests through the gateway. */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const ctx = require('./context');
const { User, Vehicle, Telemetry, Notification } = require('../../src/shared/models');
const { signToken } = require('../../src/shared/auth');
const { toPoint } = require('../../src/shared/geo');

const PASSWORD = 'Password@123';
let passwordHash; // hashed once - bcrypt is deliberately slow

async function resetDb() {
  await Promise.all([
    User.deleteMany({}),
    Vehicle.deleteMany({}),
    Telemetry.deleteMany({}),
    Notification.deleteMany({}),
  ]);
}

async function createUser(role, overrides = {}) {
  passwordHash = passwordHash || (await bcrypt.hash(PASSWORD, 4));
  const n = Math.random().toString(36).slice(2, 8);
  return User.create({
    name: `${role} ${n}`,
    email: `${role}.${n}@test.local`,
    role,
    phone: `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '1')}`.replace(/0000$/, '1111'),
    passwordHash,
    ...overrides,
  });
}

/**
 * Standard cast of users:
 *  admin, failingAdmin (phone ends in 0000 -> SMS stub always fails),
 *  manager, driver, otherDriver - plus a JWT for each.
 */
async function createFleetUsers() {
  const users = {
    admin: await createUser('admin', { name: 'Admin One', phone: '+919811111111' }),
    failingAdmin: await createUser('admin', { name: 'Admin Unreachable', phone: '+919800000000' }),
    manager: await createUser('fleet_manager', { name: 'Fleet Manager', phone: '+919822222222' }),
    driver: await createUser('driver', { name: 'Assigned Driver', phone: '+919833333333' }),
    otherDriver: await createUser('driver', { name: 'Other Driver', phone: '+919844444444' }),
  };
  const tokens = Object.fromEntries(Object.entries(users).map(([k, u]) => [k, signToken(u)]));
  return { users, tokens };
}

async function createVehicle(overrides = {}) {
  const n = Math.random().toString(36).slice(2, 7).toUpperCase();
  const { lat = 28.6139, lng = 77.209, ...rest } = overrides;
  return Vehicle.create({
    registrationNumber: `TS${n}`,
    make: 'Tata',
    model: 'Ace',
    year: 2022,
    type: 'truck',
    status: 'active',
    location: lat === null ? undefined : toPoint(lat, lng),
    locationSource: lat === null ? undefined : 'gps',
    ...rest,
  });
}

/** supertest agent for the gateway */
const gw = () => request(ctx.gateway);

/** Request through the gateway with the API key and (optionally) a JWT. */
function api(method, path, token) {
  const req = gw()[method](path).set('x-api-key', ctx.API_KEY);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
}

module.exports = { PASSWORD, resetDb, createUser, createFleetUsers, createVehicle, gw, api };
