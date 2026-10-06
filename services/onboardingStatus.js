/**
 * Post-signup flow for NEW users only (services/cohort.js: Auth account
 * created at/after RELEASE_AT). Existing users never see onboarding or the
 * hard paywall. RELEASE_AT unset/invalid → nobody is new.
 *
 * Independent answers:
 *  - showOnboarding: new user without profile.onboardingCompletedAt (client-
 *    writable, so it only controls the intro pages).
 *  - showPaywall (the hard gate, no X): new user who has NEVER paid
 *    (entitlement.everPaid, server-only) and has no active entitlement.
 *    Users whose trial/subscription ended are not gated: they keep using
 *    their credits and see the normal paywall (with X) when they run out.
 */
const { getDb } = require('../utils/firestoreAdmin');
const entitlement = require('./entitlement');
const cohort = require('./cohort');

/** Pure decision, exported for tests. */
function decide({ createdAtMillis, releaseAt, profile, entitled, everPaid }) {
  const newUser = cohort.isNewByCreation(createdAtMillis, releaseAt);
  const completed = !!(profile && profile.onboardingCompletedAt);
  return {
    newUser,
    showOnboarding: newUser && !completed,
    showPaywall: newUser && !entitled && !everPaid,
  };
}

async function getStatus(uid) {
  const [createdAtMillis, snap] = await Promise.all([
    cohort.createdAtMillis(uid),
    getDb().collection('users').doc(uid).get(),
  ]);
  const doc = snap.exists ? snap.data() || {} : {};
  const releaseAt = cohort.releaseAtMillis();
  const base = decide({ createdAtMillis, releaseAt, profile: doc.profile, entitled: false, everPaid: false });
  // Existing users never reach the entitlement check (and never cost a Play call).
  const ent = base.newUser ? await entitlement.resolveActive(uid, doc) : { active: false, expiresAtMillis: null };
  const everPaid = entitlement.everPaid(doc);
  return {
    ...decide({ createdAtMillis, releaseAt, profile: doc.profile, entitled: ent.active, everPaid }),
    entitled: ent.active,
    everPaid,
    // Lets the app trust an active entitlement offline until it expires.
    entitlementExpiresAt: ent.active ? ent.expiresAtMillis : null,
  };
}

module.exports = { decide, getStatus, releaseAtMillis: cohort.releaseAtMillis };
