/**
 * Post-signup flow for NEW users only, decided here (never by a device-local
 * flag): a user is new when their Firebase Auth account was created at or after
 * RELEASE_AT (ISO date, env on Render = the day the app version goes live on
 * Play). RELEASE_AT unset/invalid → nobody is new, so existing users are never
 * pushed into onboarding or the hard paywall by a misconfiguration.
 *
 * The two answers are independent:
 *  - showOnboarding: new user without profile.onboardingCompletedAt. That
 *    field is client-writable, so it only controls the intro pages.
 *  - showPaywall: new user without an active server entitlement
 *    (users/{uid}.entitlement, server-only). Skipping onboarding does not
 *    skip the paywall.
 */
const { getDb, getAdmin } = require('../utils/firestoreAdmin');
const entitlement = require('./entitlement');

function releaseAtMillis(raw = process.env.RELEASE_AT) {
  const ms = Date.parse(String(raw || '').trim());
  return Number.isFinite(ms) ? ms : null;
}

/** Pure decision, exported for tests. */
function decide({ createdAtMillis, releaseAt, profile, entitled }) {
  const newUser = releaseAt != null && Number.isFinite(createdAtMillis) && createdAtMillis >= releaseAt;
  const completed = !!(profile && profile.onboardingCompletedAt);
  return { newUser, showOnboarding: newUser && !completed, showPaywall: newUser && !entitled };
}

async function getStatus(uid) {
  const [authUser, snap] = await Promise.all([
    getAdmin().auth().getUser(uid),
    getDb().collection('users').doc(uid).get(),
  ]);
  const doc = snap.exists ? snap.data() || {} : {};
  const createdAtMillis = Date.parse(authUser.metadata.creationTime);
  const releaseAt = releaseAtMillis();
  const base = decide({ createdAtMillis, releaseAt, profile: doc.profile, entitled: false });
  // Existing users never reach the paywall check (and never cost a Play call).
  const ent = base.newUser ? await entitlement.resolveActive(uid, doc) : { active: false, expiresAtMillis: null };
  return {
    ...decide({ createdAtMillis, releaseAt, profile: doc.profile, entitled: ent.active }),
    // Lets the app trust an active entitlement offline until it expires.
    entitlementExpiresAt: ent.active ? ent.expiresAtMillis : null,
  };
}

module.exports = { decide, getStatus, releaseAtMillis };
