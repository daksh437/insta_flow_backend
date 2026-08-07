// InstaFlow credit system — single source of truth (server-authoritative).
// 1 credit ≈ ₹0.14 cost (image). Sell/grant so credits map to real value.

// Credits charged per AI action.
const CREDIT_COSTS = {
  caption: 1,
  hashtag: 1,
  bio: 1,
  post_ideas: 5,
  carousel: 8,
  content_planner: 5,
  reels_script: 5,
  strategy: 5,
  niche_analysis: 5,
  comment_reply: 1,
  rewrite: 1,
  trending: 2,
  content_engine: 8,
  caption_from_media: 3,
  background_remove: 15,
  image: 25, // AI Post Image / Viral Templates
  thumbnail: 30,
  logo: 30,
  image_edit: 35,
};

// Default cost if an endpoint isn't mapped (safe fallback).
const DEFAULT_COST = 2;

// Free credit grants (NO rewarded ad).
const FREE_GRANTS = {
  NEW_USER_BONUS: 50, // one-time on signup
  DAILY_LOGIN: 5, // once per UTC day
  // Referral: the REFERRER gets this once their invited friend actually uses
  // an AI feature (proof of a real, engaged user — not just an install).
  REFERRAL_INVITER: 50,
  // Anti-abuse cap: max AI-use referral rewards a single referrer can earn.
  // Does NOT cap the purchase-bonus reward below — a verified real purchase
  // isn't something worth capping.
  REFERRAL_MAX: 10,
};

// When a referred friend buys a plan or credit pack, the referrer gets this
// fraction of the credits the friend's purchase granted, as an ongoing
// reward — e.g. a 2000-credit plan purchase pays the referrer 10% * 2000 =
// 200 credits. Applies to every purchase the friend makes, not just the first.
const REFERRAL_PURCHASE_BONUS_PCT = 0.1;

// Monthly credits granted by each subscription plan (Google Play product IDs).
const PLAN_CREDITS = {
  'instaflow_starter_299': 1000,
  'instaflow_pro_599': 2000,
  'instaflow_business_999': 3500,
};

// One-time credit packs (Google Play product IDs).
const PACK_CREDITS = {
  'credits_79': 250,
  'credits_149': 600,
};

function costForEndpoint(key) {
  return CREDIT_COSTS[key] ?? DEFAULT_COST;
}

module.exports = {
  CREDIT_COSTS,
  DEFAULT_COST,
  FREE_GRANTS,
  PLAN_CREDITS,
  PACK_CREDITS,
  REFERRAL_PURCHASE_BONUS_PCT,
  costForEndpoint,
};
