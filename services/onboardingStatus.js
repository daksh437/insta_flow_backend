/**
 * Post-signup flow for the hard-paywall cohort only (services/cohort.js:
 * account created after RELEASE_AT — or allowlisted test account — AND the
 * new app version). Existing users and old app versions never see it.
 *
 * Independent answers:
 *  - showOnboarding: no profile.onboardingCompletedAt (client-writable, so it
 *    only controls the intro pages).
 *  - showPaywall (the hard gate, no X): has NEVER paid (entitlement.everPaid,
 *    server-only) and has no active entitlement. Users whose trial or
 *    subscription ended are not gated: they keep using their credits and see
 *    the normal paywall (with X) when they run out.
 */
const { getDb } = require('../utils/firestoreAdmin');
const entitlement = require('./entitlement');
const cohort = require('./cohort');

/** Pure decision, exported for tests. */
function decide({ newUser, profile, entitled, everPaid }) {
  const completed = !!(profile && profile.onboardingCompletedAt);
  return {
    newUser: !!newUser,
    showOnboarding: !!newUser && !completed,
    showPaywall: !!newUser && !entitled && !everPaid,
  };
}

/** [versionCode] = the calling app's build (X-App-Version-Code). */
async function getStatus(uid, { versionCode = null } = {}) {
  const snap = await getDb().collection('users').doc(uid).get();
  const doc = snap.exists ? snap.data() || {} : {};
  const newUser = await cohort.isHardPaywallUser(uid, { versionCode, userDoc: snap.exists ? doc : null, fromClient: true });
  // Others never reach the entitlement check (and never cost a Play call).
  const ent = newUser ? await entitlement.resolveActive(uid, doc) : { active: false, expiresAtMillis: null };
  const everPaid = entitlement.everPaid(doc);
  return {
    ...decide({ newUser, profile: doc.profile, entitled: ent.active, everPaid }),
    entitled: ent.active,
    everPaid,
    // Lets the app trust an active entitlement offline until it expires.
    entitlementExpiresAt: ent.active ? ent.expiresAtMillis : null,
  };
}

module.exports = { decide, getStatus };
