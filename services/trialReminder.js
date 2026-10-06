/**
 * "Your trial ends tomorrow" push, ~24h before the ₹5 trial converts.
 * subscriptionSync schedules trial_reminders/{uid} { dueAt, expiresAt, orderId }
 * while a trial is active and auto-renewing; this cron sends it once.
 * Amount and currency come from Play (entitlement.renewalPrice), the date is
 * shown in the user's own UTC offset (users/{uid}.utcOffsetMinutes) — never
 * hardcoded. The app shows the same info as an in-app banner from the
 * entitlement fields.
 */
const { getDb } = require('../utils/firestoreAdmin');
const { sendPushToUser } = require('./pushService');
const entitlement = require('./entitlement');
const { TRIAL_REMINDERS } = require('./subscriptionSync');

function formatPrice(price) {
  if (!price || !price.currencyCode) return null;
  const value = Number(price.units || 0) + Number(price.nanos || 0) / 1e9;
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: price.currencyCode,
      maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
    }).format(value);
  } catch (_) {
    return `${price.currencyCode} ${value}`;
  }
}

/** "9 Oct" in the user's local date (offset in minutes; IST when unknown). */
function formatDay(millis, utcOffsetMinutes) {
  const offset = typeof utcOffsetMinutes === 'number' ? utcOffsetMinutes : 330;
  return new Date(millis + offset * 60000).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
}

function reminderText(price, expiresAtMillis, utcOffsetMinutes) {
  const amount = formatPrice(price);
  const day = formatDay(expiresAtMillis, utcOffsetMinutes);
  return {
    title: 'Your InstaFlow trial ends tomorrow',
    body: amount
      ? `On ${day} your plan renews at ${amount}/month. Cancel anytime in Google Play.`
      : `On ${day} your plan renews at the monthly price. Cancel anytime in Google Play.`,
  };
}

async function sendDueTrialReminders(now = Date.now()) {
  const db = getDb();
  if (!db) return { sent: 0 };
  const due = await db.collection(TRIAL_REMINDERS).where('dueAt', '<=', new Date(now)).limit(200).get();
  let sent = 0;
  for (const d of due.docs) {
    const r = d.data();
    try {
      const snap = await db.collection('users').doc(r.uid).get();
      if (!snap.exists) {
        await d.ref.delete(); // account deleted: drop the reminder, write nothing
        continue;
      }
      const user = snap.data();
      const e = user.entitlement || {};
      const expiresAt = entitlement.toMillis(e.expiresAt);
      const stillDue = entitlement.isActive(user, now) && e.isTrial === true && e.autoRenewing === true &&
        e.latestOrderId === r.orderId && e.reminderSentFor !== r.orderId;
      if (stillDue) {
        const msg = reminderText(e.renewalPrice, expiresAt, user.utcOffsetMinutes);
        await sendPushToUser(r.uid, { ...msg, data: { type: 'trial_ending', screen: 'subscription' } });
        await entitlement.write(r.uid, { reminderSentFor: r.orderId });
        sent++;
      }
      await d.ref.delete();
    } catch (err) {
      console.warn('[trialReminder] failed for', r.uid, err.message);
    }
  }
  if (sent) console.log(`[trialReminder] sent ${sent} trial-ending reminder(s)`);
  return { sent };
}

module.exports = { sendDueTrialReminders, reminderText, formatPrice, formatDay };
