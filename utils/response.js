function apiSuccess(res, data = null, meta = {}) {
  const body = {
    success: true,
    ...(meta.message ? { message: String(meta.message) } : {}),
    ...(data !== null ? { data } : {}),
  };
  // Backward compatibility with existing clients that read `ok`
  body.ok = true;
  return res.json(body);
}

function toSafeError(error, fallbackMessage = 'Something went wrong', fallbackCode = 'INTERNAL_ERROR') {
  const status = Number(error?.status || error?.statusCode || 500);
  const code = String(error?.code || fallbackCode);
  const message = String(error?.publicMessage || error?.message || fallbackMessage);
  return {
    status: status >= 400 && status <= 599 ? status : 500,
    code,
    message,
  };
}

function apiError(res, status, code, message, extra = {}) {
  const body = {
    success: false,
    error: String(message || 'Something went wrong'),
    code: String(code || 'INTERNAL_ERROR'),
    message: String(message || 'Something went wrong'),
    ...extra,
  };
  // Backward compatibility with existing clients that read `ok`
  body.ok = false;
  return res.status(Number(status) || 500).json(body);
}

module.exports = {
  apiSuccess,
  apiError,
  toSafeError,
};
