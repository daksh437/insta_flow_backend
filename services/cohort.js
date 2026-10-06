/**
 * Who gets the hard-paywall experience (onboarding, ₹5 trial paywall, no free
 * credits, no legacy trial). A user is in the "hard" cohort only when BOTH:
 *   1. their Firebase Auth account was created at/after RELEASE_AT
 *      (or their uid is in TEST_NEW_USER_UIDS, for pre-release E2E tests), and
 *   2. their FIRST app session was on the new app (X-App-Version-Code ≥
 *      HARD_PAYWALL_MIN_VERSION_CODE). Stored as entitlement.cohort
 *      ('hard' | 'legacy', server-only); an account first seen on build 48
 *      stays 'legacy' for good, even after updating.
 * Old clients (build 48 sends no version header) keep the legacy behaviour,
 * so a post-release signup on the old build is never stuck with 0 credits.
 * RELEASE_AT or HARD_PAYWALL_MIN_VERSION_CODE unset → nobody is "hard".
 */
const { getDb, getAdmin } = require('../utils/firestoreAdmin');

const createdAtCache = new Map(); // uid → creation millis (never changes)
const MAX_CACHE = 20000;
const HARD = 'hard';
const LEGACY = 'legacy';

function releaseAtMillis(raw = process.env.RELEASE_AT) {
  const ms = Date.parse(String(raw || '').trim());
  return Number.isFinite(ms) ? ms : null;
}

function minVersionCode(raw = process.env.HARD_PAYWALL_MIN_VERSION_CODE) {
  const n = parseInt(String(raw || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function testUids(raw = process.env.TEST_NEW_USER_UIDS) {
  return new Set(String(raw || '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** App build number from the X-App-Version-Code header (null for old clients). */
function versionFromReq(req) {
  const n = parseInt(String((req && req.headers && req.headers['x-app-version-code']) || ''), 10);
  return Number.isFinite(n) ? n : null;
}

async function createdAtMillis(uid) {
  if (createdAtCache.has(uid)) return createdAtCache.get(uid);
  const user = await getAdmin().auth().getUser(uid);
  const ms = Date.parse(user.metadata.creationTime);
  if (createdAtCache.size >= MAX_CACHE) createdAtCache.clear();
  createdAtCache.set(uid, ms);
  return ms;
}

function isNewByCreation(createdMs, releaseAt = releaseAtMillis()) {
  return releaseAt != null && Number.isFinite(createdMs) && createdMs >= releaseAt;
}

/** Account created after RELEASE_AT, or an allowlisted test account. */
async function isCreatedAfterRelease(uid) {
  if (!uid) return false;
  if (testUids().has(uid)) return true;
  const releaseAt = releaseAtMillis();
  if (releaseAt == null) return false;
  try {
    return isNewByCreation(await createdAtMillis(uid), releaseAt);
  } catch (e) {
    // Unknown creation time: treat as existing (legacy behaviour), never lock out.
    console.warn('[cohort] creation time lookup failed, treating as existing:', uid, e.message);
    return false;
  }
}

async function stampCohort(uid, value) {
  await getDb().collection('users').doc(uid).set({ entitlement: { cohort: value, cohortAt: new Date() } }, { merge: true });
}

/**
 * Is [uid] in the hard-paywall cohort? Decided by the account's FIRST app
 * session and then stored for good (entitlement.cohort, server-only):
 *   - first seen on the new app (version ≥ HARD_PAYWALL_MIN_VERSION_CODE) → 'hard'
 *   - first seen on an old app (build 48: no/low version), or already given the
 *     legacy 3-day trial label → 'legacy', permanently, even after updating
 * [fromClient] = this is an app request carrying [versionCode] (absent header =
 * old app). Background checks (fromClient false) only read the stored value.
 * [userDoc] avoids a re-read when the caller already has it.
 */
async function isHardPaywallUser(uid, { versionCode = null, userDoc, fromClient = false } = {}) {
  if (!uid || !(await isCreatedAfterRelease(uid))) return false;
  let doc = userDoc;
  if (doc === undefined) {
    const snap = await getDb().collection('users').doc(uid).get();
    doc = snap.exists ? snap.data() : null;
  }
  const stored = doc && doc.entitlement && doc.entitlement.cohort;
  if (stored === HARD) return true;
  if (stored === LEGACY) return false;
  const min = minVersionCode();
  if (min == null || !fromClient) return false; // no rollout yet / no client to judge by
  const legacyTrialSeen = !!(doc && (doc.trialStartDate || doc.trialEndDate || doc.trialStart || doc.trialEnd));
  if (legacyTrialSeen || versionCode == null || versionCode < min) {
    await stampCohort(uid, LEGACY);
    return false;
  }
  await stampCohort(uid, HARD);
  return true;
}

module.exports = {
  releaseAtMillis,
  minVersionCode,
  testUids,
  versionFromReq,
  createdAtMillis,
  isNewByCreation,
  isCreatedAfterRelease,
  isHardPaywallUser,
  _cache: createdAtCache,
};
