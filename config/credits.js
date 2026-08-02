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
  REFERRAL_INVITER: 100, // when an invited friend is verified
  REFERRAL_FRIEND: 50, // the invited friend
  REFERRAL_MAX: 10, // max rewarded referrals per user
};

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
  costForEndpoint,
};
