const mongoose = require('mongoose');

const DEFAULT_CODES = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

class HttpError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code || DEFAULT_CODES[status] || 'ERROR';
    this.details = details;
  }
}

/** Every error in the system (gateway and services) uses this JSON shape. */
function errorBody(status, code, message, details, requestId) {
  const error = { status, code, message };
  if (details !== undefined) error.details = details;
  if (requestId) error.requestId = requestId;
  return { error };
}

function notFoundHandler(req, res) {
  res
    .status(404)
    .json(
      errorBody(
        404,
        'ROUTE_NOT_FOUND',
        `Route ${req.method} ${req.originalUrl} not found`,
        undefined,
        req.get('x-request-id')
      )
    );
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Internal server error';
  let details;

  if (err instanceof HttpError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof mongoose.Error.ValidationError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Request validation failed';
    details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    code = 'INVALID_ID';
    message = `Invalid value '${err.value}' for ${err.path}`;
  } else if (err && err.code === 11000) {
    status = 409;
    code = 'DUPLICATE_RESOURCE';
    const fields = Object.keys(err.keyValue || {});
    message = `A resource with the same ${fields.join(', ') || 'key'} already exists`;
    details = err.keyValue;
  } else if (err && err.type === 'entity.parse.failed') {
    status = 400;
    code = 'MALFORMED_JSON';
    message = 'Request body is not valid JSON';
  } else if (err && err.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'Request body is too large';
  }

  if (status >= 500 && process.env.NODE_ENV !== 'test') {
    console.error(err);
  }

  res.status(status).json(errorBody(status, code, message, details, req.get('x-request-id')));
}

module.exports = { HttpError, errorBody, errorHandler, notFoundHandler };
