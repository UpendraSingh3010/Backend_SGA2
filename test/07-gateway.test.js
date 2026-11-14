/**
 * FLOW 7 - API Gateway: routing, API key verification, rate limiting and
 * service-unavailable / invalid-request handling
 */
const { expect } = require('chai');
const express = require('express');
const request = require('supertest');
const { createGateway, ROUTES } = require('../src/gateway/app');
const ctx = require('./support/context');
const { listen, close, deadUrl } = require('./support/servers');
const { gw, api } = require('./support/helpers');

/** A fake backend that echoes back what the gateway forwarded to it. */
async function startEchoBackend() {
  const app = express();
  app.use(express.json());
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/vehicles/slow', (req, res) => setTimeout(() => res.json({ late: true }), 500));
  app.all('/{*path}', (req, res) => {
    res.status(207).set('x-backend', 'echo').json({
      method: req.method,
      url: req.originalUrl,
      body: req.body,
      headers: req.headers,
    });
  });
  return listen(app);
}

describe('Flow 7: API Gateway', () => {
  describe('API key verification', () => {
    it('rejects a request with no API key: 401 API_KEY_MISSING', async () => {
      const res = await gw().get('/api/vehicles');
      expect(res.status).to.equal(401);
      expect(res.body.error.code).to.equal('API_KEY_MISSING');
      expect(res.headers).to.not.have.property('x-served-by'); // never reached a service
    });

    it('rejects an invalid API key: 403 API_KEY_INVALID', async () => {
      const res = await gw().get('/api/vehicles').set('x-api-key', 'wrong-key');
      expect(res.status).to.equal(403);
      expect(res.body.error.code).to.equal('API_KEY_INVALID');
    });

    it('accepts every configured API key', async () => {
      for (const key of [ctx.API_KEY, ctx.SECOND_API_KEY]) {
        const res = await gw().post('/api/users/login').set('x-api-key', key).send({ email: 'x@y.z', password: 'nope' });
        expect(res.headers['x-served-by']).to.equal('users-service');
      }
    });

    it('serves health, Swagger UI and the OpenAPI spec without an API key', async () => {
      const health = await gw().get('/health');
      expect(health.status).to.equal(200);
      expect(health.body.status).to.equal('healthy');
      expect(Object.keys(health.body.services)).to.have.members(ROUTES.map((r) => r.service));

      const docs = await gw().get('/docs/');
      expect(docs.status).to.equal(200);
      expect(docs.text).to.contain('swagger-ui');

      const spec = await gw().get('/openapi.json');
      expect(spec.body.openapi).to.match(/^3\./);
      expect(spec.body.components.securitySchemes).to.have.keys('ApiKeyAuth', 'BearerAuth');
    });
  });

  describe('routing to backend services', () => {
    const cases = [
      ['/api/users/me', 'users-service'],
      ['/api/vehicles', 'vehicles-service'],
      ['/api/telemetry/events', 'telemetry-service'],
      ['/api/maps/vehicles', 'maps-service'],
      ['/api/notifications', 'notifications-service'],
    ];
    cases.forEach(([path, service]) => {
      it(`routes ${path} -> ${service}`, async () => {
        const res = await api('get', path); // no JWT: the *service* answers 401
        expect(res.headers['x-served-by']).to.equal(service);
        expect(res.status).to.equal(401);
        expect(res.headers['x-request-id']).to.be.a('string');
      });
    });

    it('returns 404 NO_ROUTE for paths no service owns', async () => {
      for (const path of ['/api/unknown', '/api/usersXYZ', '/api']) {
        const res = await api('get', path);
        expect(res.status, path).to.equal(404);
        expect(res.body.error.code).to.equal('NO_ROUTE');
      }
    });

    it('passes malformed JSON to the service, which answers 400 MALFORMED_JSON', async () => {
      const res = await api('post', '/api/users/login').set('content-type', 'application/json').send('{"email": ');
      expect(res.status).to.equal(400);
      expect(res.body.error.code).to.equal('MALFORMED_JSON');
    });
  });

  describe('request/response forwarding (echo backend)', () => {
    let echo;
    let gateway;
    before(async () => {
      echo = await startEchoBackend();
      gateway = createGateway({ apiKeys: ['echo-key'], resolveTarget: () => echo.url, proxyTimeoutMs: 200 });
    });
    after(() => close(echo.server));

    it('forwards method, full path, query and body; returns status, headers and body', async () => {
      const res = await request(gateway)
        .put('/api/vehicles/abc/status?verbose=1')
        .set('x-api-key', 'echo-key')
        .set('x-request-id', 'trace-123')
        .send({ status: 'idle' });

      expect(res.status).to.equal(207);
      expect(res.headers['x-backend']).to.equal('echo');
      expect(res.headers['x-request-id']).to.equal('trace-123');
      expect(res.body).to.include({ method: 'PUT', url: '/api/vehicles/abc/status?verbose=1' });
      expect(res.body.body).to.deep.equal({ status: 'idle' });
    });

    it('strips the client API key and any x-internal-key; adds tracing headers', async () => {
      const res = await request(gateway)
        .get('/api/maps/anything')
        .set('x-api-key', 'echo-key')
        .set('x-internal-key', 'trying-to-impersonate');
      const forwarded = res.body.headers;
      expect(forwarded).to.not.have.property('x-api-key');
      expect(forwarded).to.not.have.property('x-internal-key');
      expect(forwarded['x-forwarded-by']).to.equal('fleet-api-gateway');
      expect(forwarded['x-request-id']).to.equal(res.headers['x-request-id']);
    });

    it('returns 504 GATEWAY_TIMEOUT when a service is too slow', async () => {
      const res = await request(gateway).get('/api/vehicles/slow').set('x-api-key', 'echo-key');
      expect(res.status).to.equal(504);
      expect(res.body.error.code).to.equal('GATEWAY_TIMEOUT');
    });
  });

  describe('service unavailable', () => {
    it('returns 503 SERVICE_UNAVAILABLE with Retry-After when the target service is down', async () => {
      const down = await deadUrl();
      const gateway = createGateway({
        apiKeys: ['k'],
        resolveTarget: (name) => (name === 'telemetry' ? down : ctx.serviceUrls[name]),
      });

      const res = await request(gateway).get('/api/telemetry/events').set('x-api-key', 'k');
      expect(res.status).to.equal(503);
      expect(res.headers['retry-after']).to.equal('30');
      expect(res.body.error).to.include({ code: 'SERVICE_UNAVAILABLE' });
      expect(res.body.error.details.service).to.equal('telemetry');

      // other services keep working
      const ok = await request(gateway).get('/api/vehicles').set('x-api-key', 'k');
      expect(ok.headers['x-served-by']).to.equal('vehicles-service');

      // and /health reports the outage
      const health = await request(gateway).get('/health');
      expect(health.status).to.equal(503);
      expect(health.body.status).to.equal('degraded');
      expect(health.body.services.telemetry.status).to.equal('down');
    });
  });

  describe('rate limiting', () => {
    let echo;
    before(async () => {
      echo = await startEchoBackend();
    });
    after(() => close(echo.server));

    it('allows N requests per window, then returns 429 with rate-limit headers', async () => {
      const gateway = createGateway({
        apiKeys: ['key-a', 'key-b'],
        rateLimit: { windowMs: 60_000, max: 3 },
        resolveTarget: () => echo.url,
      });
      const agent = request(gateway);

      for (let i = 1; i <= 3; i += 1) {
        const res = await agent.get('/api/vehicles').set('x-api-key', 'key-a');
        expect(res.status, `request ${i}`).to.equal(207);
        expect(res.headers.ratelimit).to.contain(`remaining=${3 - i}`);
      }

      const blocked = await agent.get('/api/vehicles').set('x-api-key', 'key-a');
      expect(blocked.status).to.equal(429);
      expect(blocked.body.error.code).to.equal('RATE_LIMIT_EXCEEDED');
      expect(blocked.body.error.details).to.deep.equal({ limit: 3, windowSeconds: 60 });
      expect(blocked.headers['ratelimit-policy']).to.equal('3;w=60');
      expect(blocked.headers['retry-after']).to.be.a('string');

      // limits are tracked per API key
      const otherKey = await agent.get('/api/vehicles').set('x-api-key', 'key-b');
      expect(otherKey.status).to.equal(207);
    });

    it('does not count rejected (invalid key) requests against a valid key', async () => {
      const gateway = createGateway({ apiKeys: ['key-c'], rateLimit: { windowMs: 60_000, max: 1 }, resolveTarget: () => echo.url });
      const agent = request(gateway);
      for (let i = 0; i < 5; i += 1) await agent.get('/api/vehicles').set('x-api-key', 'bad');
      const res = await agent.get('/api/vehicles').set('x-api-key', 'key-c');
      expect(res.status).to.equal(207);
    });
  });
});
