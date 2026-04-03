/**
 * Runtime enforcement audit: verify every POST /ai/* route has requireAiAccess AND wrapAiHandler.
 * Call at server startup (inside app.listen callback). Throws if any POST /ai/* is unprotected.
 *
 * Uses Express 4 app._router.stack. Scans for the /ai router and checks:
 * 1. Middleware layer with _aiAuditTag === 'REQUIRE_AI_ACCESS' registered before each POST route.
 * 2. Each POST route handler has _aiHandlerWrapped === 'AI_HANDLER_WRAPPED' (wrapAiHandler).
 */

const AI_AUDIT_TAG = 'REQUIRE_AI_ACCESS';
const WRAP_AUDIT_TAG = 'AI_HANDLER_WRAPPED';

function auditAiRoutes(app) {
  const router = app._router;
  if (!router || !Array.isArray(router.stack)) {
    throw new Error('[AI Audit] app._router.stack not found — cannot verify AI route protection');
  }

  let aiRouter = null;
  let basePath = '/ai';

  for (const layer of router.stack) {
    if (!layer.handle || typeof layer.handle.stack !== 'object') continue;
    const path = layer.path || '';
    const re = layer.regexp && layer.regexp.toString();
    const isAiMount = path === '/ai' || (re && /\/ai/.test(re));
    if (isAiMount) {
      aiRouter = layer.handle;
      basePath = '/ai';
      break;
    }
  }

  if (!aiRouter) {
    throw new Error('[AI Audit] POST /ai/* router not found in app stack');
  }

  let seenRequireAiAccess = false;
  const postRoutes = [];
  const unprotected = [];
  const unwrapped = [];

  for (const layer of aiRouter.stack) {
    if (layer.route) {
      const methods = layer.route.methods || {};
      if (methods.post) {
        const path = (basePath + (layer.route.path === '/' ? '' : layer.route.path)).replace(/\/+/g, '/');
        const hasMiddleware = seenRequireAiAccess;
        const stack = layer.route.stack || [];
        const hasWrapped = stack.some((l) => l.handle && l.handle._aiHandlerWrapped === WRAP_AUDIT_TAG);
        postRoutes.push({ path, protected: hasMiddleware, wrapped: hasWrapped });
        if (!hasMiddleware) unprotected.push(path);
        if (!hasWrapped) unwrapped.push(path);
      }
      continue;
    }
    const handle = layer.handle;
    if (handle && handle._aiAuditTag === AI_AUDIT_TAG) {
      seenRequireAiAccess = true;
    }
  }

  // Log: route registration order and protection status
  console.log('\n[AI Audit] Route registration order (POST /ai/*):');
  for (const { path, protected: hasMiddleware, wrapped: hasWrapped } of postRoutes) {
    const mw = hasMiddleware ? 'requireAiAccess ✓' : 'requireAiAccess ✗ MISSING';
    const wr = hasWrapped ? 'wrapAiHandler ✓' : 'wrapAiHandler ✗ MISSING';
    console.log(`  POST ${path} → ${mw} | ${wr}`);
  }

  if (unprotected.length > 0) {
    const msg = `[AI Audit] FATAL: ${unprotected.length} POST /ai/* route(s) do not have requireAiAccess: ${unprotected.join(', ')}. Stop server.`;
    console.error('\n' + msg);
    throw new Error(msg);
  }
  if (unwrapped.length > 0) {
    const msg = `[AI Audit] FATAL: ${unwrapped.length} POST /ai/* route(s) do not have wrapAiHandler: ${unwrapped.join(', ')}. Stop server.`;
    console.error('\n' + msg);
    throw new Error(msg);
  }

  console.log('[AI Audit] All POST /ai/* routes have requireAiAccess + wrapAiHandler. ✓\n');
}

module.exports = { auditAiRoutes, AI_AUDIT_TAG };
