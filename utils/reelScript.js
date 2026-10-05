// Reel Script Generator — prompt + strict response parsing.
//
// Kept separate from the controller so the parser can be unit-tested without
// Gemini. There is deliberately NO fallback/template script here: if the model
// does not return a usable script, the caller reports a failure and refunds
// the credits instead of showing placeholder content as a real result.

const MIN_TOPIC_LENGTH = 3;
const MAX_TOPIC_LENGTH = 500;

const SYSTEM_PROMPT =
  "You are an expert short-form video scriptwriter for Instagram Reels and YouTube Shorts. " +
  "Write scripts that are specific to the user's topic. " +
  'Never write about promoting an app unless the topic asks for it. ' +
  'Match the language of the topic (English, Hindi or Hinglish).';

/**
 * @param {string} topic        the user's exact topic text
 * @param {object} [opts]
 * @param {string} [opts.forcedLanguage]  language the user explicitly asked for ("in Hindi")
 * @param {string} [opts.creatorContext]  connected-account profile block, tone/niche only
 * @param {boolean} [opts.regenerate]
 */
function buildUserPrompt(topic, opts = {}) {
  const parts = [];
  if (opts.creatorContext) {
    parts.push(
      `${opts.creatorContext}\n\n(Use the creator profile above ONLY to match tone, niche vocabulary and hashtag style. ` +
        'It must never change or replace the topic below.)'
    );
  }
  parts.push(`Topic: ${topic}`);
  parts.push(`Write a 30-45 second Reel script ONLY about this topic. Return strict JSON with no markdown:
{
  "hook": "first line spoken in 0-3s, curiosity-driven, max 12 words",
  "scenes": [ { "time": "0-3s", "say": "...", "show": "what to film / on-screen visual", "text_overlay": "short on-screen text" } ],
  "cta": "closing call to action",
  "caption": "Instagram caption for this reel, 1-3 lines",
  "hashtags": ["10-15 relevant hashtags"],
  "audio_suggestion": "type of trending audio/music that fits"
}
"scenes" must have 4-6 scenes that together cover the full topic and the full 30-45 seconds. "say" is the exact spoken words; "show" is a camera/visual direction and must not repeat "say".`);
  if (opts.forcedLanguage) {
    parts.push(`The user asked for ${opts.forcedLanguage}: write hook, every "say", cta and caption in ${opts.forcedLanguage}.`);
  }
  if (opts.regenerate) {
    parts.push('This is a regenerate request: write a fresh take with a different hook and angle than a typical first draft.');
  }
  return parts.join('\n\n');
}

const str = (v) => (v == null ? '' : String(v).trim());

function normalizeHashtag(tag) {
  const t = str(tag).replace(/\s+/g, '');
  if (!t || t === '#') return '';
  return t.startsWith('#') ? t : `#${t}`;
}

/**
 * Parse and validate the model output. Returns the normalized script, or null
 * if the output is not a complete script (missing hook/cta, no usable scenes,
 * truncated or non-JSON output).
 *
 * The result carries the new fields (scenes[].say/show/text_overlay,
 * audio_suggestion) plus the legacy shape older app builds read
 * (scene_by_scene[].dialogue/visual, fullScript).
 */
function parseReelScript(output) {
  if (!output || typeof output !== 'string') return null;
  const text = output.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const hook = str(parsed.hook);
  const cta = str(parsed.cta);
  const scenes = (Array.isArray(parsed.scenes) ? parsed.scenes : [])
    .filter((s) => s && typeof s === 'object')
    .map((s, i) => ({
      time: str(s.time) || `Scene ${i + 1}`,
      say: str(s.say || s.dialogue || s.voiceover),
      show: str(s.show || s.visual),
      text_overlay: str(s.text_overlay || s.on_screen_text),
    }))
    .filter((s) => s.say);

  if (!hook || !cta || scenes.length === 0) return null;

  const hashtags = [...new Set((Array.isArray(parsed.hashtags) ? parsed.hashtags : []).map(normalizeHashtag).filter(Boolean))].slice(0, 15);
  const fullScript = [hook, ...scenes.map((s) => s.say), cta].join('\n\n');

  return {
    hook,
    scenes,
    cta,
    caption: str(parsed.caption),
    hashtags,
    audio_suggestion: str(parsed.audio_suggestion),
    fullScript,
    scene_by_scene: scenes.map((s) => ({ time: s.time, dialogue: s.say, visual: s.show, text_overlay: s.text_overlay })),
  };
}

/** Returns an error message for an invalid topic, or null if it is usable. */
function validateTopic(topic) {
  const t = str(topic);
  if (t.length < MIN_TOPIC_LENGTH) return 'Please enter a reel topic';
  if (t.length > MAX_TOPIC_LENGTH) return `Please keep the topic under ${MAX_TOPIC_LENGTH} characters`;
  return null;
}

module.exports = {
  SYSTEM_PROMPT,
  MIN_TOPIC_LENGTH,
  buildUserPrompt,
  parseReelScript,
  validateTopic,
};
