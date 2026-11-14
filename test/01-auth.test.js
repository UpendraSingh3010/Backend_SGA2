/**
 * FLOW 1 - User login and JWT token verification
 */
const { expect } = require('chai');
const jwt = require('jsonwebtoken');
const { resetDb, createUser, api, PASSWORD } = require('./support/helpers');

const SECRET = process.env.JWT_SECRET;

describe('Flow 1: User login and JWT verification', () => {
  let driver;

  beforeEach(async () => {
    await resetDb();
    driver = await createUser('driver', { email: 'dev.driver@test.local' });
  });

  describe('POST /api/users/register', () => {
    it('creates a driver account and never lets the caller pick their own role', async () => {
      const res = await api('post', '/api/users/register').send({
        name: 'Sneaky User',
        email: 'sneaky@test.local',
        password: 'Secret@123',
        phone: '+919812345678',
        role: 'admin', // must be ignored
      });
      expect(res.status).to.equal(201);
      expect(res.body.user).to.include({ email: 'sneaky@test.local', role: 'driver' });
      expect(res.body.user).to.not.have.property('passwordHash');
    });

    it('rejects a short password with 400', async () => {
      const res = await api('post', '/api/users/register').send({ name: 'X', email: 'x@test.local', password: '123' });
      expect(res.status).to.equal(400);
      expect(res.body.error.code).to.equal('VALIDATION_ERROR');
    });

    it('rejects a duplicate email with 409', async () => {
      const res = await api('post', '/api/users/register').send({
        name: 'Dup',
        email: 'dev.driver@test.local',
        password: 'Secret@123',
      });
      expect(res.status).to.equal(409);
      expect(res.body.error.code).to.equal('DUPLICATE_RESOURCE');
    });
  });

  describe('POST /api/users/login', () => {
    it('returns a signed JWT containing the user id, role and issuer', async () => {
      const res = await api('post', '/api/users/login').send({ email: 'dev.driver@test.local', password: PASSWORD });

      expect(res.status).to.equal(200);
      expect(res.body).to.include({ tokenType: 'Bearer', expiresIn: '1h' });
      expect(res.body.user).to.include({ email: 'dev.driver@test.local', role: 'driver' });

      const claims = jwt.verify(res.body.token, SECRET);
      expect(claims.sub).to.equal(String(driver._id));
      expect(claims.role).to.equal('driver');
      expect(claims.iss).to.equal('fleet-users-service');
      expect(claims.exp - claims.iat).to.equal(3600);
    });

    it('is case-insensitive on email', async () => {
      const res = await api('post', '/api/users/login').send({ email: 'DEV.Driver@test.local', password: PASSWORD });
      expect(res.status).to.equal(200);
    });

    it('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
      const res = await api('post', '/api/users/login').send({ email: 'dev.driver@test.local', password: 'wrong-password' });
      expect(res.status).to.equal(401);
      expect(res.body.error.code).to.equal('INVALID_CREDENTIALS');
      expect(res.body).to.not.have.property('token');
    });

    it('rejects an unknown email with the same 401 (no user enumeration)', async () => {
      const res = await api('post', '/api/users/login').send({ email: 'nobody@test.local', password: PASSWORD });
      expect(res.status).to.equal(401);
      expect(res.body.error.code).to.equal('INVALID_CREDENTIALS');
    });

    it('rejects missing credentials with 400', async () => {
      const res = await api('post', '/api/users/login').send({ email: 'dev.driver@test.local' });
      expect(res.status).to.equal(400);
    });

    it('rejects a disabled account with 403', async () => {
      await createUser('driver', { email: 'disabled@test.local', active: false });
      const res = await api('post', '/api/users/login').send({ email: 'disabled@test.local', password: PASSWORD });
      expect(res.status).to.equal(403);
      expect(res.body.error.code).to.equal('ACCOUNT_DISABLED');
    });
  });

  describe('JWT verification on protected routes', () => {
    let token;
    beforeEach(async () => {
      const res = await api('post', '/api/users/login').send({ email: 'dev.driver@test.local', password: PASSWORD });
      token = res.body.token;
    });

    it('GET /api/users/verify-token returns the decoded claims for a valid token', async () => {
      const res = await api('get', '/api/users/verify-token', token);
      expect(res.status).to.equal(200);
      expect(res.body.valid).to.equal(true);
      expect(res.body.claims).to.include({ sub: String(driver._id), role: 'driver' });
      expect(new Date(res.body.expiresAt) > new Date()).to.equal(true);
    });

    it('GET /api/users/me returns the logged-in user', async () => {
      const res = await api('get', '/api/users/me', token);
      expect(res.status).to.equal(200);
      expect(res.body.user.id).to.equal(String(driver._id));
    });

    it('the same token is accepted by another service (stateless JWT)', async () => {
      const res = await api('get', '/api/vehicles', token);
      expect(res.status).to.equal(200);
      expect(res.headers['x-served-by']).to.equal('vehicles-service');
    });

    it('rejects a request without a token: 401 TOKEN_MISSING', async () => {
      const res = await api('get', '/api/users/me');
      expect(res.status).to.equal(401);
      expect(res.body.error.code).to.equal('TOKEN_MISSING');
    });

    it('rejects a tampered token: 401 TOKEN_INVALID', async () => {
      const [header, payload, signature] = token.split('.');
      const forgedPayload = Buffer.from(
        JSON.stringify({ ...jwt.decode(token), role: 'admin' })
      ).toString('base64url');
      const res = await api('get', '/api/users/me', `${header}.${forgedPayload}.${signature}`);
      expect(res.status).to.equal(401);
      expect(res.body.error.code).to.equal('TOKEN_INVALID');
    });

    it('rejects a token signed with a different secret: 401 TOKEN_INVALID', async () => {
      const fake = jwt.sign({ sub: String(driver._id), role: 'admin' }, 'attacker-secret', { issuer: 'fleet-users-service' });
      const res = await api('get', '/api/users/me', fake);
      expect(res.status).to.equal(401);
      expect(res.body.error.code).to.equal('TOKEN_INVALID');
    });

    it('rejects an expired token: 401 TOKEN_EXPIRED', async () => {
      const expired = jwt.sign(
        { sub: String(driver._id), role: 'driver', exp: Math.floor(Date.now() / 1000) - 60 },
        SECRET,
        { issuer: 'fleet-users-service' }
      );
      const res = await api('get', '/api/users/verify-token', expired);
      expect(res.status).to.equal(401);
      expect(res.body.error.code).to.equal('TOKEN_EXPIRED');
    });
  });
});
