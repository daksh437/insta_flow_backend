/**
 * AI usage control: load user from Firestore, enforce plan (trial / free / premium).
 * - New user: 7-day trial = UNLIMITED AI (planType 'trial', allowed always until trialEnd).
 * - After trial ends: free plan = 2 AI uses per day (DAILY_CREDITS_FREE). Resets at midnight UTC.
 * - Premium: unlimited, no decrement.
 * Server date only. Atomic increment on success. Never trust frontend counters.
 * DEV_SKIP_LIMITS=true bypasses all checks for testing.
 * Idempotency: X-Idempotency-Key for sync AI routes; keys stored in ai_request_keys with 48h TTL.
 */

const crypto = require('crypto');
const { getDb } = require('../utils/firestoreAdmin');
const { ensureUserAiFields } = require('../utils/ensureUserAiFields');
const { resolvePlan } = require('../services/planResolver');
const { buildAiFallback } = require('../utils/aiFallback');
const { verifySubscription } = require('../utils/playVerify');

const USERS = 'users';
const AI_REQUEST_KEYS = 'ai_request_keys';
const DAILY_CREDITS_FREE = 2;
const DEV_SKIP_LIMITS = process.env.DEV_SKIP_LIMITS === 'true' || process.env.DEV_SKIP_LIMITS === '1';

if (DEV_SKIP_LIMITS) {
  console.warn('[aiAccess] ⚠️ DEV_SKIP_LIMITS is enabled — AI usage limits are bypassed. Do not use in production.');
}
const IDEMPOTENCY_TTL_MS = 48 * 60 * 60 * 1000;

function hashIdempotencyKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

/**
 * Get or generate idempotency key for request. Call from middleware for AI POST routes.
 * Uses X-Idempotency-Key header if present; otherwise fallback hash(uid + path + bodyDigest).
 */
function getIdempotencyKey(req) {
  const header = (req.headers['x-idempotency-key'] || req.headers['X-Idempotency-Key'] || '').trim();
  if (header && header.length > 0 && header.length <= 512) return header;
  const uid = (req.uid || req.headers['x-user-uid'] || req.body?.uid || '').trim() || 'anon';
  const path = req._aiEndpoint || req.path || req.url || '';
  const bodyDigest = req.body && typeof req.body === 'object'
    ? crypto.createHash('sha256').update(JSON.stringify(req.body), 'utf8').digest('hex').slice(0, 32)
    : '';
  return hashIdempotencyKey(`${uid}:${path}:${bodyDigest}`);
}

function todayDateStr() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Next midnight UTC as ISO string for frontend countdown. */
function getNextMidnightUtc() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.toISOString();
}

/** Safe date parsing: Firestore Timestamp, Date, or number (ms). */
function toDate(v) {
  if (v == null) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v._seconds === 'number') return new Date(v._seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Analytics event names for usage control. */
const EVENTS = {
  AI_ACCESS: 'ai_access',
  AI_ALLOWED: 'ai_allowed',
  AI_BLOCKED_LIMIT: 'ai_blocked_limit',
  AI_TRIAL_ACTIVE: 'ai_trial_active',
  AI_TRIAL_EXPIRED_AUTO_CONVERT: 'ai_trial_expired_auto_convert',
  AI_USAGE_RECORDED: 'ai_usage_recorded',
};

function logAiAccess(level, payload) {
  const event = payload.event || EVENTS.AI_ACCESS;
  const msg = JSON.stringify({ event, ...payload });
  if (level === 'warn') console.warn(msg);
  else console.log(msg);
}

/**
 * Load user doc from Firestore.
 * Returns { user, firestoreOk }. firestoreOk false = Firestore unavailable (degraded mode).
 */
async function loadUser(uid) {
  const firestore = getDb();
  if (!firestore) {
    console.warn('[aiAccess] Firestore unavailable — allowing through (degraded mode)');
    return { user: null, firestoreOk: false };
  }
  try {
    const snap = await firestore.collection(USERS).doc(uid).get();
    if (!snap.exists) return { user: null, firestoreOk: true };
    return { user: { id: snap.id, ...snap.data() }, firestoreOk: true };
  } catch (e) {
    console.warn('[aiAccess] loadUser error:', e.message, '— allowing through (degraded mode)');
    return { user: null, firestoreOk: false };
  }
}

// Duration (days) for each product / base plan. Monthly = 30 (weekly intro is
// still part of the monthly subscription, so 30 days is correct).
const PRODUCT_DAYS = { premium_monthly: 30, premium_3month: 90, premium_6month: 180, premium_12month: 365 };

const PURCHASE_TOKENS = 'purchase_tokens';
function tokenDocId(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
/**
 * Bind a Play purchase token to the FIRST app account that presents it.
 * A Google Play subscription is tied to the device's Play account, so
 * restorePurchases() can surface the same purchase under a DIFFERENT Firebase
 * account. To ensure "premium only for the account that bought it", the first
 * account to claim a token owns it; any other account presenting the same token
 * is denied premium.
 * Returns { owned: true } if [uid] owns (or just claimed) the token,
 * or { owned: false, ownerUid } if another account already owns it.
 */
async function resolveTokenOwner(db, token, uid) {
  if (!token) return { owned: true }; // no token to bind
  const ref = db.collection(PURCHASE_TOKENS).doc(tokenDocId(token));
  try {
    const ownerUid = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        tx.set(ref, { uid, claimedAt: new Date() });
        return uid;
      }
      return snap.data().uid;
    });
    return ownerUid === uid ? { owned: true } : { owned: false, ownerUid };
  } catch (e) {
    // Fail-open: never block a legitimate paying user on a transient error.
    console.warn('[aiAccess] resolveTokenOwner error:', e.message);
    return { owned: true };
  }
}

/**
 * Self-healing premium activation. The client saves the Play purchase receipt
 * (`subscription.{purchaseToken,productId}`) reliably, but its follow-up write
 * of `premiumExpiry` can fail — leaving a paid user without premium. Here the
 * SERVER activates premium from that receipt when it's missing/expired, so a
 * completed payment always results in premium (source of truth = premiumExpiry).
 * Mutates [user] in place. Returns true if it activated.
 */
async function activatePremiumFromReceiptIfNeeded(ref, user, now) {
  const sub = user.subscription;
  if (!sub || typeof sub !== 'object' || !sub.productId) return false;
  const productId = String(sub.productId);
  if (!productId.startsWith('premium')) return false;

  const currentExpiry = toDate(user.premiumExpiry || user.premium_expiry);
  const hasActivePremium = currentExpiry && currentExpiry > now;

  const premiumFields = (expiry) => ({
    isPremium: true,
    planType: 'premium',
    subscriptionPlan: 'pro',
    premiumPlan: 'pro',
    premiumProductId: productId,
    premiumExpiry: expiry,
    premiumStartDate: now,
    premiumExpiryNotified: false,
    isTrialActive: false,
    lastPurchaseStatus: 'purchased',
    lastUpdated: new Date(),
  });
  const applyPremium = async (expiry) => {
    await ref.update(premiumFields(expiry));
    user.isPremium = true;
    user.planType = 'premium';
    user.premiumExpiry = expiry;
  };
  const revoke = async () => {
    await ref.update({
      isPremium: false,
      planType: 'free',
      subscriptionPlan: 'free',
      premiumExpiry: null,
      lastPurchaseStatus: 'expired',
      lastUpdated: new Date(),
    });
    user.isPremium = false;
    user.planType = 'free';
    user.premiumExpiry = null;
  };

  // Ownership binding: premium is ONLY for the account that bought this
  // subscription. If a different account restored the same Play purchase, deny.
  const ownership = await resolveTokenOwner(getDb(), sub.purchaseToken, ref.id);
  if (!ownership.owned) {
    if (hasActivePremium || user.isPremium === true) {
      try { await revoke(); } catch (_) { /* best-effort */ }
    }
    console.log(`[aiAccess] purchase token owned by ${ownership.ownerUid} — denying premium uid=${ref.id}`);
    return false;
  }

  // Ask Google Play for the REAL status of this purchase token.
  const v = await verifySubscription(productId, sub.purchaseToken);

  if (v.verified) {
    if (v.active) {
      const realExpiry = new Date(v.expiryMillis);
      // Only write when it actually changes (avoid churn on every call).
      if (!hasActivePremium || Math.abs(realExpiry.getTime() - currentExpiry.getTime()) > 60000) {
        try {
          await applyPremium(realExpiry);
          console.log(`[aiAccess] Play-verified premium uid=${ref.id} exp=${realExpiry.toISOString()}`);
          return true;
        } catch (e) {
          console.warn('[aiAccess] applyPremium error:', e.message);
        }
      }
      return false;
    }
    // Play says NOT active (cancelled / renewal failed / expired) — revoke any
    // stale premium so a lapsed subscriber loses access.
    if (hasActivePremium || user.isPremium === true) {
      try {
        await revoke();
        console.log(`[aiAccess] Play says inactive — revoked premium uid=${ref.id}`);
      } catch (e) {
        console.warn('[aiAccess] revoke error:', e.message);
      }
    }
    return false;
  }

  // Play API unavailable (not configured yet / transient) — fall back to the
  // receipt so a paid user still gets premium. Grant `days` from now.
  if (hasActivePremium) return false;
  const days = PRODUCT_DAYS[productId] || 30;
  const expiry = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  try {
    await applyPremium(expiry);
    console.log(`[aiAccess] receipt-based premium (Play unverified) uid=${ref.id} exp=${expiry.toISOString()}`);
    return true;
  } catch (e) {
    console.warn('[aiAccess] activatePremiumFromReceipt error:', e.message);
    return false;
  }
}

/**
 * Get AI access: load user, resolve plan from dates (planResolver), persist if changed.
 * Reset dailyAiUsed only when planType === 'free' (and date rollover).
 * Returns exact response shape: no fallback planType, no dailyLimit ?? 2.
 */
async function getAiAccess(uid) {
  const resetAtUtc = getNextMidnightUtc();
  const { user, firestoreOk } = await loadUser(uid);

  if (!firestoreOk) {
    logAiAccess('info', { userId: uid, planType: 'free', allowed: true, reason: 'firestore_unavailable' });
    return { allowed: true, planType: 'free', dailyUsed: 0, dailyLimit: 2, trialEndDate: null, resetAtUtc, user: null };
  }
  if (!user) {
    logAiAccess('warn', { userId: uid, planType: 'free', dailyUsed: 0, allowed: false, error: 'USER_NOT_FOUND' });
    return { allowed: false, error: 'USER_NOT_FOUND', planType: 'free', dailyUsed: 0, dailyLimit: 2, trialEndDate: null, resetAtUtc };
  }

  const firestore = getDb();
  const today = todayDateStr();
  const ref = firestore.collection(USERS).doc(uid);
  const healed = await ensureUserAiFields(ref, user);
  Object.assign(user, healed);

  const now = new Date();
  // Payment safety net: if a purchase receipt exists but premium wasn't set
  // (client write failed), activate premium here before resolving the plan.
  await activatePremiumFromReceiptIfNeeded(ref, user, now);
  let planType = resolvePlan(user);

  const trialEnd = toDate(user.trialEndDate) || toDate(user.trialEnd);
  const trialStart = toDate(user.trialStartDate) || toDate(user.trialStart);

  if (planType === 'trial' && !trialEnd) {
    const trialEndNew = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    try {
      await ref.update({ planType: 'trial', trialEndDate: trialEndNew, trialStartDate: trialStart || now });
      user.trialEndDate = trialEndNew;
      user.trialStartDate = trialStart || now;
    } catch (e) {
      console.warn('[aiAccess] recreate trial window error:', e.message);
    }
  }

  const storedPlan = (user.planType || user.plan_type || '').toLowerCase();
  if (storedPlan !== planType && ['trial', 'free', 'premium'].includes(planType)) {
    try {
      await ref.update({ planType });
      user.planType = planType;
      if (planType === 'free') {
        await ref.update({ dailyAiUsed: 0, dailyAiDate: today });
        user.dailyAiUsed = 0;
        user.dailyAiDate = today;
      }
    } catch (e) {
      console.warn('[aiAccess] update planType error:', e.message);
    }
  }

  if (planType === 'trial') {
    const trialEndDate = toDate(user.trialEndDate) || toDate(user.trialEnd) || trialEnd;
    const daysLeft = trialEndDate ? Math.max(0, Math.ceil((trialEndDate - now) / (24 * 60 * 60 * 1000))) : 0;
    const out = {
      planType: 'trial',
      allowed: true,
      dailyUsed: 0,
      dailyLimit: null,
      trialEndDate: trialEndDate ? trialEndDate.toISOString() : null,
      resetAtUtc: null,
    };
    logAiAccess('info', { event: 'AI_ACCESS_RESPONSE', uid, planType: 'trial', allowed: true, trialDaysLeft: daysLeft });
    return { ...out, trialDaysLeft: daysLeft, user };
  }

  if (planType === 'premium') {
    const premiumExpiry = toDate(user.premiumExpiry || user.premium_expiry);
    const out = {
      planType: 'premium',
      allowed: true,
      dailyUsed: null,
      dailyLimit: null,
      trialEndDate: null,
      premiumExpiry: premiumExpiry ? premiumExpiry.toISOString() : null,
      resetAtUtc: null,
    };
    logAiAccess('info', { event: 'AI_ACCESS_RESPONSE', uid, planType: 'premium', allowed: true });
    return { ...out, user };
  }

  let dailyAiUsed = typeof (user.dailyAiUsed ?? user.daily_ai_used) === 'number' ? (user.dailyAiUsed ?? user.daily_ai_used) : 0;
  let dailyAiDate = user.dailyAiDate ?? user.daily_ai_date ?? '';

  if (dailyAiDate !== today) {
    dailyAiUsed = 0;
    dailyAiDate = today;
    try {
      await ref.update({ dailyAiUsed: 0, dailyAiDate: today });
      user.dailyAiUsed = 0;
      user.dailyAiDate = today;
    } catch (e) {
      console.warn('[aiAccess] daily reset update error:', e.message);
    }
  }

  dailyAiUsed = Math.max(0, Math.min(2, Math.floor(dailyAiUsed)));
  const allowed = dailyAiUsed < 2;

  const out = {
    planType: 'free',
    allowed,
    dailyUsed: dailyAiUsed,
    dailyLimit: 2,
    trialEndDate: null,
    resetAtUtc,
  };
  logAiAccess('info', { event: 'AI_ACCESS_RESPONSE', uid, planType: 'free', dailyUsed: dailyAiUsed, dailyLimit: 2, allowed });
  if (!allowed) logAiAccess('warn', { event: EVENTS.AI_BLOCKED_LIMIT, uid, planType: 'free', dailyUsed: dailyAiUsed, error: 'DAILY_LIMIT_REACHED' });
  return { ...out, error: allowed ? null : 'DAILY_LIMIT_REACHED', user };
}

/**
 * Express middleware: require x-user-uid, load user, enforce access. Sets req.uid, req.aiAccess.
 * Endpoint name is set by caller via req._aiEndpoint (for logging).
 */
async function requireAiAccess(req, res, next) {
  const endpoint = req._aiEndpoint || req.baseUrl + req.path || req.url || '';
  const uid = (req.headers['x-user-uid'] || req.headers['X-User-UID'] || req.body?.uid)?.trim() || '(none)';

  if (DEV_SKIP_LIMITS) {
    req.uid = uid === '(none)' ? 'dev-skip' : uid;
    req.aiAccess = { allowed: true, planType: 'free', trialDaysLeft: 0, creditsLeftToday: null };
    req.aiAccessAllowed = true;
    req.idempotencyKey = getIdempotencyKey(req);
    console.log('AI_ACCESS_MIDDLEWARE_HIT', JSON.stringify({ endpoint, uid: req.uid, planType: 'free', dailyAiUsed: null, reason: 'DEV_SKIP_LIMITS' }));
    logAiAccess('info', { userId: req.uid, planType: 'free', allowed: true, endpoint: req._aiEndpoint || req.path, reason: 'DEV_SKIP_LIMITS' });
    return next();
  }
  const uidTrim = (req.headers['x-user-uid'] || req.headers['X-User-UID'] || req.body?.uid)?.trim();
  if (!uidTrim) {
    return res.status(401).json({ success: false, error: 'UNAUTHORIZED', message: 'Missing x-user-uid' });
  }
  // ORDER: access = getAiAccess() → trial → premium → free (free: check daily limit, then block if >= 2).
  const access = (process.env.NODE_ENV === 'test' && req._mockAiAccess != null)
    ? await Promise.resolve(req._mockAiAccess)
    : await getAiAccess(uidTrim);
  req.uid = uidTrim;
  req.aiAccess = access;
  const planType = access.planType || 'free';

  // Trial and premium: unlimited — do NOT check daily limits
  if (planType === 'trial' || planType === 'premium') {
    req.aiAccessAllowed = true;
    req.idempotencyKey = getIdempotencyKey(req);
    if (planType === 'trial') logAiAccess('info', { event: 'AI_TRIAL_BYPASS', uid: uidTrim });
    return next();
  }

  // Free only: block when daily limit reached
  const endpointFinal = req._aiEndpoint || req.baseUrl + req.path;
  const dailyAiUsed = typeof access.dailyUsed === 'number' ? access.dailyUsed : (access.user && typeof (access.user.dailyAiUsed ?? access.user.daily_ai_used) === 'number' ? (access.user.dailyAiUsed ?? access.user.daily_ai_used) : 0);

  logAiAccess('info', { event: 'AI_ACCESS_MIDDLEWARE_HIT', uid: uidTrim, planType, dailyAiUsed, endpoint: endpointFinal });

  if (planType === 'free' && dailyAiUsed >= DAILY_CREDITS_FREE) {
    console.warn('AI_LIMIT_BLOCK', uidTrim, dailyAiUsed);
    logAiAccess('warn', {
      event: EVENTS.AI_BLOCKED_LIMIT,
      userId: uidTrim,
      dailyAiUsed,
      limit: DAILY_CREDITS_FREE,
      endpoint: endpointFinal,
      message: 'Free plan daily limit reached (middleware block)',
    });
    return res.status(403).json({
      success: false,
      error: 'DAILY_LIMIT_REACHED',
      code: 'DAILY_LIMIT_REACHED',
      message: 'Daily free limit reached',
    });
  }

  logAiAccess('info', {
    log: 'ai_usage_truth',
    source: 'requireAiAccess',
    uid: uidTrim,
    planType: access.planType,
    dailyUsed: access.dailyUsed ?? (access.user ? (typeof (access.user.dailyAiUsed ?? access.user.daily_ai_used) === 'number' ? (access.user.dailyAiUsed ?? access.user.daily_ai_used) : 0) : null),
    creditsLeftToday: access.creditsLeftToday,
    allowed: true,
    endpoint: endpointFinal,
  });
  req.aiAccessAllowed = true;
  req.idempotencyKey = getIdempotencyKey(req);
  next();
}

/**
 * Safety wrapper for AI controllers. Asserts req.aiAccessAllowed === true before running handler.
 * If false → return 403 DAILY_LIMIT_REACHED. Wrap every AI controller with this.
 */
const WRAP_AUDIT_TAG = 'AI_HANDLER_WRAPPED';

function wrapAiHandler(handler) {
  const fn = function aiHandlerWrapped(req, res, next) {
    if (req.aiAccessAllowed !== true) {
      console.warn('AI_CONTROLLER_BLOCKED', req.uid || req.path, req._aiEndpoint || req.path);
      return res.status(403).json({
        success: false,
        error: 'DAILY_LIMIT_REACHED',
        code: 'DAILY_LIMIT_REACHED',
        message: 'Daily AI limit reached. Upgrade for more.',
      });
    }
    try {
      console.log('[AI Request]', req._aiEndpoint || req.path, req.body || {});
    } catch (_) {}

    return Promise.resolve(handler(req, res, next))
      .then((value) => {
        try {
          if (!res.headersSent && value !== undefined) {
            console.log('[AI Response]', req._aiEndpoint || req.path, value);
            return res.json({ success: true, data: value });
          }
        } catch (_) {}
        return value;
      })
      .catch((error) => {
        if (res.headersSent) return;
        console.error('[AI Controller Error]', req._aiEndpoint || req.path, error?.message || error);
        const fallback = buildAiFallback(req._aiEndpoint || req.path, req.body || {});
        const errorCode = String(error?.code || 'AI_HANDLER_FALLBACK');
        console.log('[AI Fallback Response]', req._aiEndpoint || req.path, fallback);
        return res.json({
          success: true,
          data: fallback,
          fallback: true,
          meta: { errorCode },
          ok: true,
        });
      });
  };
  fn._aiHandlerWrapped = WRAP_AUDIT_TAG;
  return fn;
}

/**
 * After confirmed successful AI response only: atomic increment dailyAiUsed and totalAiUsed.
 * Never call on timeout, partial response, or thrown exception.
 * Premium override: skip ALL limits — no credit decrement ever for premium; we do not update.
 * Async jobs: requestId = jobId, idempotencyKey = undefined (job.usageRecorded prevents double-count).
 * Sync endpoints: pass req.idempotencyKey; idempotency key stored in ai_request_keys, 48h TTL; duplicate key skips increment.
 * options: { endpoint } optional, for truth logging.
 */
async function recordAiUsage(uid, requestId, idempotencyKey, options = {}) {
  if (DEV_SKIP_LIMITS) return;
  const firestore = getDb();
  if (!firestore) return;
  const ref = firestore.collection(USERS).doc(uid);
  const keyRef = idempotencyKey
    ? firestore.collection(AI_REQUEST_KEYS).doc(hashIdempotencyKey(idempotencyKey))
    : null;
  const now = Date.now();
  const endpoint = options.endpoint || null;
  let usageLog = null;
  // Captured inside the transaction so we can log every AI use (all plans) to
  // ai_usage_logs afterwards — that's what the admin panel reads.
  let logEmail = null;
  let logPlan = 'free';
  let didRead = false;
  try {
    await firestore.runTransaction(async (tx) => {
      if (keyRef) {
        const keySnap = await tx.get(keyRef);
        if (keySnap.exists) {
          const keyData = keySnap.data();
          let createdAtMs = keyData.createdAt == null ? 0 : keyData.createdAt;
          if (typeof createdAtMs === 'object' && typeof createdAtMs.toMillis === 'function') createdAtMs = createdAtMs.toMillis();
          else if (createdAtMs instanceof Date) createdAtMs = createdAtMs.getTime();
          else if (typeof createdAtMs !== 'number') createdAtMs = 0;
          if (createdAtMs && now - createdAtMs < IDEMPOTENCY_TTL_MS) return;
        }
      }
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data();
      logEmail = data.email || data.gmail || null;
      const rawPt = data.planType ?? data.plan_type ?? 'free';
      const pt = String(rawPt || '').toLowerCase();
      logPlan = pt || 'free';
      didRead = true;
      if (pt === 'premium' || pt === 'trial') return; // Only increment when planType === 'free'
      const today = todayDateStr();
      const dailyAiDate = data.dailyAiDate ?? data.daily_ai_date ?? '';
      let dailyAiUsed = typeof (data.dailyAiUsed ?? data.daily_ai_used) === 'number' ? (data.dailyAiUsed ?? data.daily_ai_used) : 0;
      const totalAiUsed = typeof (data.totalAiUsed ?? data.total_ai_used) === 'number' ? (data.totalAiUsed ?? data.total_ai_used) : 0;
      dailyAiUsed = Math.max(0, Math.min(DAILY_CREDITS_FREE, Math.floor(dailyAiUsed)));
      const dailyAiUsedBefore = dailyAiUsed;
      const dailyAiUsedAfterIncrement = dailyAiDate !== today ? 1 : dailyAiUsed + 1;
      if (dailyAiDate !== today) {
        tx.update(ref, {
          dailyAiUsed: 1,
          dailyAiDate: today,
          totalAiUsed: (totalAiUsed || 0) + 1,
        });
      } else {
        tx.update(ref, {
          dailyAiUsed: dailyAiUsed + 1,
          totalAiUsed: totalAiUsed + 1,
        });
      }
      if (keyRef) {
        tx.set(keyRef, { uid, createdAt: new Date(now) }, { merge: true });
      }
      usageLog = {
        log: 'ai_usage_truth',
        source: 'recordAiUsage',
        uid,
        dailyAiUsedBefore,
        dailyAiUsedAfterIncrement,
        dailyAiDate: today,
        endpoint: endpoint || undefined,
      };
    });
    // Log this AI use for the admin panel — ALL plans (free/trial/premium), with
    // the user's email and the tool name. Read by AdminAIUsageScreen.
    if (didRead && endpoint) {
      try {
        await firestore.collection('ai_usage_logs').add({
          uid,
          email: logEmail || '',
          toolName: endpoint,
          plan: logPlan,
          usedAt: new Date(),
        });
      } catch (e) {
        console.warn('[aiAccess] ai_usage_log write error:', e.message);
      }
    }
    logAiAccess('info', { event: EVENTS.AI_USAGE_RECORDED, userId: uid, requestId: requestId || undefined, idempotency: !!idempotencyKey });
    if (usageLog) logAiAccess('info', usageLog);
  } catch (e) {
    console.warn('[aiAccess] recordAiUsage error:', e.message);
  }
}

/**
 * TTL cleanup: delete ai_request_keys docs older than 48h. Call from cron or manually.
 */
async function cleanupIdempotencyKeys() {
  const firestore = getDb();
  if (!firestore) return;
  const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL_MS);
  try {
    const snap = await firestore.collection(AI_REQUEST_KEYS).where('createdAt', '<', cutoff).limit(500).get();
    const batch = firestore.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    if (!snap.empty) await batch.commit();
  } catch (e) {
    console.warn('[aiAccess] cleanupIdempotencyKeys error:', e.message);
  }
}

/**
 * Admin: set user to premium (manual upgrade).
 */
async function setPremium(uid, premium = true) {
  const firestore = getDb();
  if (!firestore) return false;
  try {
    if (premium) {
      // Plan is resolved from premiumExpiry (see planResolver.js) — writing only
      // planType does NOT grant premium. Write a real future expiry + the fields
      // the client UI reads, so an admin grant actually unlocks premium.
      const now = new Date();
      const expiry = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 1-year manual grant
      await firestore.collection(USERS).doc(uid).set({
        planType: 'premium',
        isPremium: true,
        subscriptionPlan: 'pro',
        premiumPlan: 'pro',
        premiumStartDate: now,
        premiumExpiry: expiry,
        premiumExpiryNotified: false,
      }, { merge: true });
    } else {
      await firestore.collection(USERS).doc(uid).set({
        planType: 'free',
        isPremium: false,
        subscriptionPlan: 'free',
        premiumPlan: 'none',
        premiumExpiry: null,
      }, { merge: true });
    }
    return true;
  } catch (e) {
    console.warn('[aiAccess] setPremium error:', e.message);
    return false;
  }
}

/**
 * Admin: reset daily AI usage for a user (support/debug).
 * Alias: resetUserAiUsage(uid) === resetCredits(uid).
 */
async function resetCredits(uid) {
  const firestore = getDb();
  if (!firestore) return false;
  try {
    await firestore.collection(USERS).doc(uid).update({
      dailyAiUsed: 0,
      dailyAiDate: todayDateStr(),
    });
    return true;
  } catch (e) {
    console.warn('[aiAccess] resetCredits error:', e.message);
    return false;
  }
}

/** Alias for admin tooling. */
const resetUserAiUsage = resetCredits;

/**
 * Admin: set plan type (support/debug only). planType: "trial" | "free" | "premium".
 */
async function setPlanType(uid, planType) {
  const firestore = getDb();
  if (!firestore) return false;
  const allowed = ['trial', 'free', 'premium'];
  if (!allowed.includes(planType)) return false;
  try {
    // Plan is resolved from dates (premiumExpiry / trialEndDate), not the stored
    // planType field — so write the matching dates or the change has no effect.
    if (planType === 'premium') {
      return await setPremium(uid, true);
    }
    const now = new Date();
    const updates = { planType, isPremium: false, premiumExpiry: null };
    if (planType === 'trial') {
      updates.trialEndDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      updates.subscriptionPlan = 'trial';
    } else {
      updates.subscriptionPlan = 'free';
      updates.premiumPlan = 'none';
    }
    await firestore.collection(USERS).doc(uid).set(updates, { merge: true });
    return true;
  } catch (e) {
    console.warn('[aiAccess] setPlanType error:', e.message);
    return false;
  }
}

module.exports = {
  getAiAccess,
  requireAiAccess,
  wrapAiHandler,
  recordAiUsage,
  logAiAccess,
  getIdempotencyKey,
  cleanupIdempotencyKeys,
  setPremium,
  resetCredits,
  resetUserAiUsage,
  setPlanType,
  todayDateStr,
  getNextMidnightUtc,
  DAILY_CREDITS_FREE,
  DEV_SKIP_LIMITS,
  EVENTS,
  AI_REQUEST_KEYS,
  IDEMPOTENCY_TTL_MS,
};
