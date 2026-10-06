/**
 * Cohorts. A "new user" is a Firebase Auth account created at or after
 * RELEASE_AT (ISO date, Render env = when the hard-paywall app version went
 * live on Play). New users get no free credits and the hard paywall; existing
 * users keep everything as before. RELEASE_AT unset/invalid → nobody is new.
 */
const { getAdmin } = require('../utils/firestoreAdmin');

const createdAtCache = new Map(); // uid → creation millis (never changes)
const MAX_CACHE = 20000;

function releaseAtMillis(raw = process.env.RELEASE_AT) {
  const ms = Date.parse(String(raw || '').trim());
  return Number.isFinite(ms) ? ms : null;
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

/**
 * Fails closed for rewards (unknown → treated as new = no free credits)
 * only when RELEASE_AT is set; with RELEASE_AT unset nobody is new.
 */
async function isNewUser(uid) {
  const releaseAt = releaseAtMillis();
  if (releaseAt == null || !uid) return false;
  try {
    return isNewByCreation(await createdAtMillis(uid), releaseAt);
  } catch (e) {
    console.warn('[cohort] creation time lookup failed, treating as new:', uid, e.message);
    return true;
  }
}

module.exports = { releaseAtMillis, createdAtMillis, isNewByCreation, isNewUser, _cache: createdAtCache };
