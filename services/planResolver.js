/**
 * Central plan resolver. Single source of truth for planType.
 * Do NOT trust stored planType; resolve from dates only.
 *
 * Priority:
 * 1. premium: premiumExpiry != null && premiumExpiry > now
 * 2. trial: trialEndDate != null && trialEndDate > now
 * 3. free
 */

function toDate(v) {
  if (v == null) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v._seconds === 'number') return new Date(v._seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {object} user - User doc (from Firestore)
 * @returns {'premium'|'trial'|'free'}
 */
function resolvePlan(user) {
  if (!user) return 'free';
  const now = new Date();

  const premiumExpiry = toDate(user.premiumExpiry ?? user.premium_expiry);
  if (premiumExpiry != null && premiumExpiry > now) {
    return 'premium';
  }

  const trialEndDate = toDate(user.trialEndDate ?? user.trialEnd ?? user.trial_end);
  if (trialEndDate != null && trialEndDate > now) {
    return 'trial';
  }

  return 'free';
}

module.exports = { resolvePlan, toDate };
