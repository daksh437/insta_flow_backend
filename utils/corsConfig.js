function parseCorsOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function buildCorsOptions(corsOrigins, isProd) {
  const allowAnyInDev = !isProd && corsOrigins.length === 0;
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowAnyInDev) return callback(null, true);
      if (corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('CORS_ORIGIN_NOT_ALLOWED'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-User-Id', 'x-user-uid', 'X-User-UID', 'X-Request-Time', 'X-Idempotency-Key', 'Cache-Control', 'Pragma', 'Expires'],
  };
}

module.exports = {
  parseCorsOrigins,
  buildCorsOptions,
};
