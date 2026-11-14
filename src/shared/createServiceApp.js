/** Builds an Express app with the middleware every backend service shares. */
const express = require('express');
const morgan = require('morgan');
const mongoose = require('mongoose');
const { errorHandler, notFoundHandler } = require('./errors');

function createServiceApp(name, router) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan(`[${name}] :method :url :status :response-time ms`));
  }

  app.get('/health', (req, res) => {
    res.json({
      service: name,
      status: 'ok',
      db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.use(router);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = createServiceApp;
