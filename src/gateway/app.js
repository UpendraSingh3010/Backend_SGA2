/**
 * API Gateway - single entry point for all clients.
 *
 *   /api/users/*          -> User Service
 *   /api/vehicles/*       -> Vehicle/Fleet Service
 *   /api/telemetry/*      -> Telemetry Service
 *   /api/maps/*           -> Geolocation Service
 *   /api/notifications/*  -> Notification Service
 *
 * Responsibilities: API key verification, per-key rate limiting, request
 * forwarding (http-proxy-middleware), correlation ids, and consistent errors
 * when a service is unavailable or the route is invalid. Also serves the
 * Swagger UI (/docs) and the Leaflet map page (/map).
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const YAML = require('yaml');
const swaggerUi = require('swagger-ui-express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const config = require('../config');
const registry = require('../shared/registry');
const { errorBody } = require('../shared/errors');
const { requestId, verifyApiKey, createRateLimiter } = require('./middleware');

const ROUTES = [
  { prefix: '/api/users', service: 'users', label: 'User Service' },
  { prefix: '/api/vehicles', service: 'vehicles', label: 'Vehicle/Fleet Service' },
  { prefix: '/api/telemetry', service: 'telemetry', label: 'Telemetry Service' },
  { prefix: '/api/maps', service: 'maps', label: 'Geolocation Service' },
  { prefix: '/api/notifications', service: 'notifications', label: 'Notification Service' },
];

const UNAVAILABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENETUNREACH']);
const TIMEOUT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);

function loadOpenApiSpec() {
  const file = path.join(__dirname, '..', '..', 'docs', 'openapi.yaml');
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

function proxyErrorHandler(route) {
  return (err, req, res) => {
    let status = 502;
    let code = 'BAD_GATEWAY';
    let message = `${route.label} returned an invalid response`;
    if (UNAVAILABLE_CODES.has(err.code)) {
      status = 503;
      code = 'SERVICE_UNAVAILABLE';
      message = `${route.label} is currently unavailable. Please try again later.`;
    } else if (TIMEOUT_CODES.has(err.code)) {
      status = 504;
      code = 'GATEWAY_TIMEOUT';
      message = `${route.label} did not respond in time`;
    }
    if (process.env.NODE_ENV !== 'test') {
      console.error(`[gateway] ${req.method} ${req.originalUrl} -> ${route.service} failed: ${err.code || err.message}`);
    }
    // `res` is a socket for websocket upgrades - nothing useful to send there
    if (!res || typeof res.status !== 'function') return;
    if (res.headersSent) {
      res.end();
      return;
    }
    res.setHeader('Retry-After', '30');
    res.status(status).json(errorBody(status, code, message, { service: route.service }, req.id));
  };
}

function createServiceProxy(route, resolveTarget, proxyTimeoutMs) {
  return createProxyMiddleware({
    // Match '/api/users' and '/api/users/...', but not '/api/usersXYZ'
    pathFilter: (pathname) => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`),
    target: resolveTarget(route.service),
    router: () => resolveTarget(route.service), // resolved per request (registry may change)
    changeOrigin: true,
    xfwd: true,
    proxyTimeout: proxyTimeoutMs,
    on: {
      proxyReq: (proxyReq, req) => {
        req.proxyTarget = route.service;
        proxyReq.removeHeader('x-api-key'); // backend services never see client API keys
        proxyReq.removeHeader('x-internal-key'); // clients cannot impersonate internal services
        proxyReq.setHeader('x-request-id', req.id);
        proxyReq.setHeader('x-forwarded-by', 'fleet-api-gateway');
      },
      proxyRes: (proxyRes) => {
        proxyRes.headers['x-served-by'] = `${route.service}-service`;
      },
      error: proxyErrorHandler(route),
    },
  });
}

/**
 * @param {object} [options]
 * @param {string[]} [options.apiKeys]       valid API keys
 * @param {{windowMs:number,max:number}} [options.rateLimit]
 * @param {(service:string)=>string} [options.resolveTarget] service name -> base URL
 * @param {number} [options.proxyTimeoutMs]
 */
function createGateway(options = {}) {
  const apiKeys = options.apiKeys || config.gateway.apiKeys;
  const rateLimitOptions = { ...config.gateway.rateLimit, ...options.rateLimit };
  const resolveTarget = options.resolveTarget || ((name) => registry.get(name));
  const proxyTimeoutMs = options.proxyTimeoutMs || config.gateway.proxyTimeoutMs;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestId);
  app.use(
    cors({
      exposedHeaders: ['X-Request-Id', 'X-Served-By', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
    })
  );

  if (process.env.NODE_ENV !== 'test') {
    morgan.token('target', (req) => (req.proxyTarget ? `${req.proxyTarget}-service` : 'gateway'));
    morgan.token('key', (req) => req.apiKeyMasked || '-');
    app.use(morgan('[gateway] :method :url -> :target :status :response-time ms key=:key'));
  }

  // ---- Public (no API key) -------------------------------------------------
  app.get('/', (req, res) => {
    res.json({
      name: 'Fleet Management System - API Gateway',
      docs: '/docs',
      openapi: '/openapi.json',
      map: '/map',
      health: '/health',
      routes: ROUTES.map((r) => ({ path: `${r.prefix}/*`, service: r.label })),
    });
  });

  app.get('/health', async (req, res) => {
    const checks = await Promise.all(
      ROUTES.map(async (r) => {
        const url = resolveTarget(r.service);
        const started = Date.now();
        try {
          const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
          return [r.service, { status: resp.ok ? 'up' : 'down', latencyMs: Date.now() - started }];
        } catch {
          return [r.service, { status: 'down' }];
        }
      })
    );
    const healthy = checks.every(([, c]) => c.status === 'up');
    res.status(healthy ? 200 : 503).json({
      gateway: 'up',
      status: healthy ? 'healthy' : 'degraded',
      services: Object.fromEntries(checks),
      timestamp: new Date().toISOString(),
    });
  });

  const spec = loadOpenApiSpec();
  app.get('/openapi.json', (req, res) => res.json(spec));
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'Fleet Management API Docs',
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    })
  );

  app.get('/map', (req, res) => res.sendFile(path.join(__dirname, 'public', 'map.html')));

  // ---- Protected API: API key -> rate limit -> proxy -----------------------
  app.use('/api', verifyApiKey(apiKeys));
  app.use('/api', createRateLimiter(rateLimitOptions));
  for (const route of ROUTES) {
    app.use(createServiceProxy(route, resolveTarget, proxyTimeoutMs));
  }

  // Anything under /api that no service owns
  app.use('/api', (req, res) => {
    res.status(404).json(
      errorBody(
        404,
        'NO_ROUTE',
        `No service is registered for ${req.method} ${req.originalUrl}`,
        { availableRoutes: ROUTES.map((r) => `${r.prefix}/*`) },
        req.id
      )
    );
  });

  app.use((req, res) => {
    res.status(404).json(errorBody(404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`, undefined, req.id));
  });

  return app;
}

module.exports = { createGateway, ROUTES };
