/**
 * Who may get a marketing push, and when. Pure functions (no I/O) so the
 * rules are easy to test; services/marketingPush.js applies them.
 *
 * Marketing = Daily Drop, "We miss you", the day-1 tip and admin campaigns.
 * Account messages (the ₹5 trial-ending reminder) are NOT marketing: they
 * ignore these rules.
 *
 * Rules (all in IST, the app's audience):
 *  - quiet hours: nothing from 22:00 to 09:00 IST;
 *  - opt-out: users/{uid}.notificationPrefs.{dailyIdeas|reminders} === false;
 *  - weekly cap: at most MAX_PER_WEEK marketing pushes in any 7 days
 *    (users/{uid}.marketingPushLog, epoch ms of each delivered push);
 *  - Daily Drop: only Mon/Wed/Fri/Sun, and not if the app was opened today;
 *  - "We miss you": after 7+ days without opening the app, at most once per
 *    7 days, and at most WINBACK_MAX_PER_STREAK times before the user is back.
 */

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const MAX_PER_WEEK = 4;
const QUIET_START_HOUR = 22; // 10 PM IST
const QUIET_END_HOUR = 9; // 9 AM IST
const DAILY_DROP_WEEKDAYS = [0, 1, 3, 5]; // Sun, Mon, Wed, Fri (IST)
const WINBACK_AFTER_MS = 7 * DAY_MS;
const WINBACK_MAX_PER_STREAK = 3;

/** Notification categories → the user-facing toggle that controls them. */
const CATEGORY_PREF = {
  daily_ideas: 'dailyIdeas',
  reminders: 'reminders',
};

function toDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  if (typeof v === 'number') return new Date(v > 9999999999 ? v : v * 1000);
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Wall-clock parts in IST for an instant. */
function ist(now) {
  const d = new Date(now.getTime() + IST_OFFSET_MS);
  return {
    hour: d.getUTCHours(),
    weekday: d.getUTCDay(),
    dayKey: `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`,
  };
}

function isQuietHour(now) {
  const { hour } = ist(now);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

function isDailyDropDay(now) {
  return DAILY_DROP_WEEKDAYS.includes(ist(now).weekday);
}

function lastActive(user) {
  return toDate(user.lastActiveAt) || toDate(user.lastActive) || toDate(user.lastSeen);
}

function openedToday(user, now) {
  const last = lastActive(user);
  return !!last && ist(last).dayKey === ist(now).dayKey;
}

/** { dailyIdeas, reminders }; both default to on. */
function prefsOf(user) {
  const p = (user && user.notificationPrefs) || {};
  return { dailyIdeas: p.dailyIdeas !== false, reminders: p.reminders !== false };
}

/** Delivered marketing pushes (epoch ms) in the 7 days before [now]. */
function recentLog(user, now) {
  const log = Array.isArray(user && user.marketingPushLog) ? user.marketingPushLog : [];
  const from = now.getTime() - WEEK_MS;
  return log.map(Number).filter((t) => Number.isFinite(t) && t > from && t <= now.getTime());
}

function tokensOf(user) {
  const arr = Array.isArray(user.fcmTokens) ? user.fcmTokens : [];
  const one = typeof user.fcmToken === 'string' ? [user.fcmToken] : [];
  return Array.from(new Set([...arr, ...one].map((t) => String(t || '').trim()).filter(Boolean)));
}

/**
 * The checks every marketing push shares.
 * @returns {{ ok: boolean, reason?: string }}
 */
function canSendMarketing(user, now, category) {
  if (isQuietHour(now)) return { ok: false, reason: 'quiet_hours' };
  const pref = CATEGORY_PREF[category];
  if (!pref) return { ok: false, reason: 'unknown_category' };
  if (!prefsOf(user)[pref]) return { ok: false, reason: 'opted_out' };
  if (recentLog(user, now).length >= MAX_PER_WEEK) return { ok: false, reason: 'weekly_cap' };
  if (tokensOf(user).length === 0) return { ok: false, reason: 'no_tokens' };
  return { ok: true };
}

/** Daily Drop: Mon/Wed/Fri/Sun only, not if the app was opened today. */
function dailyDropDecision(user, now) {
  if (!isDailyDropDay(now)) return { ok: false, reason: 'not_a_drop_day' };
  if (openedToday(user, now)) return { ok: false, reason: 'opened_today' };
  return canSendMarketing(user, now, 'daily_ideas');
}

/** "We miss you": 7+ days inactive, once per 7 days, max 3 per inactive streak. */
function winbackDecision(user, now) {
  const last = lastActive(user);
  if (!last || now.getTime() - last.getTime() < WINBACK_AFTER_MS) return { ok: false, reason: 'active' };
  const wb = user.winback || {};
  const sentAt = toDate(wb.sentAt);
  const sameStreak = sentAt && sentAt > last;
  if (sameStreak) {
    if (now.getTime() - sentAt.getTime() < WEEK_MS) return { ok: false, reason: 'winback_recent' };
    if ((Number(wb.count) || 0) >= WINBACK_MAX_PER_STREAK) return { ok: false, reason: 'winback_limit' };
  }
  return canSendMarketing(user, now, 'reminders');
}

/** Day-1 tip: once, 20–48 h after signup, not if the app was opened today. */
function onboardingTipDecision(user, now) {
  if (user.onboardingTipSentAt) return { ok: false, reason: 'already_sent' };
  const created = toDate(user.createdAt);
  if (!created) return { ok: false, reason: 'no_created_at' };
  const age = now.getTime() - created.getTime();
  if (age < 20 * 60 * 60 * 1000 || age > 48 * 60 * 60 * 1000) return { ok: false, reason: 'not_day_one' };
  if (openedToday(user, now)) return { ok: false, reason: 'opened_today' };
  return canSendMarketing(user, now, 'reminders');
}

module.exports = {
  MAX_PER_WEEK,
  WEEK_MS,
  canSendMarketing,
  dailyDropDecision,
  winbackDecision,
  onboardingTipDecision,
  isQuietHour,
  isDailyDropDay,
  openedToday,
  prefsOf,
  recentLog,
  tokensOf,
  toDate,
};
