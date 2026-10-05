/**
 * Reel Script Generator: the user's topic must reach the prompt, a bad model
 * response is retried once, and a failure is an error + refund — never the old
 * "Show your app interface" placeholder script.
 */
const assert = require('assert');
const Module = require('module');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

const VALID = JSON.stringify({
  hook: 'These 3 morning habits rewired my whole day',
  scenes: [
    { time: '0-3s', say: 'Habit one: no phone for the first hour.', show: 'Phone face-down on nightstand', text_overlay: 'No phone' },
    { time: '3-12s', say: 'Habit two: ten minutes of sunlight.', show: 'Walking out onto the balcony', text_overlay: 'Sunlight' },
    { time: '12-25s', say: 'Habit three: write tomorrow’s top task.', show: 'Close-up of a notebook', text_overlay: '1 task' },
    { time: '25-35s', say: 'Try them for a week and watch.', show: 'Creator talking to camera', text_overlay: '7 days' },
  ],
  cta: 'Save this and start tomorrow.',
  caption: 'Small habits, big mornings ☀️',
  hashtags: ['morningroutine', '#habits', '#productivity'],
  audio_suggestion: 'Calm lo-fi beat',
});

// ── stubs ───────────────────────────────────────────────────────────────
const state = { replies: [], prompts: [], refunds: [], usage: [] };
const stubs = {
  '../utils/geminiClient': {
    runGemini: async (_prompt, opts) => {
      state.prompts.push(opts);
      const next = state.replies.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    runGeminiWithImage: async () => '',
    runGeminiImageGen: async () => ({}),
  },
  '../middleware/aiAccess': {
    recordAiUsage: async (uid) => { state.usage.push(uid); },
    refundAiCharge: async (uid, key) => { state.refunds.push(key); return true; },
  },
  '../utils/creatorContext': { loadCreatorContext: async () => null, formatForPrompt: () => '' },
  '../utils/firestoreAdmin': { getAdmin: () => null, getDb: () => null },
  '../services/dailyDropGenerator': { fetchTrendKeywords: async () => [] },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (stubs[req]) return req;
  return origResolve.call(this, req, ...rest);
};
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

const quiet = console.log; console.log = () => {}; console.warn = () => {}; console.error = () => {};
const { generateReelsScript } = require('../controllers/geminiController');
const { parseReelScript } = require('../utils/reelScript');
console.log = quiet;

function call(body) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headersSent: false,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.headersSent = true; resolve({ status: this.statusCode, body: b }); return this; },
    };
    generateReelsScript({ body, uid: 'u1', idempotencyKey: 'key-1', _aiEndpoint: '/ai/reels-script' }, res);
  });
}
function reset(replies) { state.replies = replies; state.prompts = []; state.refunds = []; state.usage = []; }
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log('Reel script tests\n');

  await t('parser strips ```json fences and maps legacy fields', () => {
    const s = parseReelScript('```json\n' + VALID + '\n```');
    assert.ok(s);
    assert.strictEqual(s.scenes.length, 4);
    assert.strictEqual(s.scene_by_scene[0].dialogue, 'Habit one: no phone for the first hour.');
    assert.strictEqual(s.scene_by_scene[0].visual, 'Phone face-down on nightstand');
    assert.deepStrictEqual(s.hashtags, ['#morningroutine', '#habits', '#productivity']);
    assert.strictEqual(s.audio_suggestion, 'Calm lo-fi beat');
  });

  await t('parser rejects truncated JSON, missing hook/cta and empty scenes', () => {
    assert.strictEqual(parseReelScript(VALID.slice(0, 200)), null);
    assert.strictEqual(parseReelScript(JSON.stringify({ ...JSON.parse(VALID), hook: '' })), null);
    assert.strictEqual(parseReelScript(JSON.stringify({ ...JSON.parse(VALID), cta: '' })), null);
    assert.strictEqual(parseReelScript(JSON.stringify({ ...JSON.parse(VALID), scenes: [] })), null);
    assert.strictEqual(parseReelScript('Sure! Here is your script: HOOK ...'), null);
  });

  await t("the user's exact topic is in the prompt; no app-promotion template", async () => {
    reset([VALID]);
    const out = await call({ userInput: '3 morning habits that changed my life' });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.success, true);
    assert.ok(state.prompts[0].userPrompt.includes('Topic: 3 morning habits that changed my life'));
    assert.ok(/Never write about promoting an app/.test(state.prompts[0].systemPrompt));
    assert.ok(!JSON.stringify(out.body).includes('Show your app interface'));
    assert.strictEqual(out.body.data.hook, 'These 3 morning habits rewired my whole day');
    await tick();
    assert.deepStrictEqual(state.refunds, []);
    assert.deepStrictEqual(state.usage, ['u1']);
  });

  await t('unparseable first response is retried once and then succeeds', async () => {
    reset(['```json\n{"hook": "cut off mid', VALID]);
    const out = await call({ userInput: 'Gym mistakes beginners make' });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(state.prompts.length, 2);
    assert.deepStrictEqual(state.refunds, []);
  });

  await t('two bad responses → 502 error, credits refunded, no placeholder', async () => {
    reset(['not json', '{"hook":"x"}']);
    const out = await call({ userInput: 'Budget travel tips for Goa' });
    assert.strictEqual(out.status, 502);
    assert.strictEqual(out.body.success, false);
    assert.strictEqual(out.body.code, 'AI_GENERATION_FAILED');
    assert.strictEqual(out.body.message, "Couldn't generate script, please try again");
    assert.strictEqual(out.body.refunded, true);
    assert.ok(!('data' in out.body));
    assert.deepStrictEqual(state.refunds, ['key-1']);
    assert.deepStrictEqual(state.usage, []);
  });

  await t('Gemini network/API error twice → 502 + refund', async () => {
    reset([new Error('GEMINI_TIMEOUT: Request timed out'), new Error('GEMINI_API_ERROR: 503')]);
    const out = await call({ userInput: 'Ghar pe paneer tikka kaise banaye' });
    assert.strictEqual(out.status, 502);
    assert.deepStrictEqual(state.refunds, ['key-1']);
  });

  await t('denied API key is not retried', async () => {
    reset([new Error('GEMINI_PERMISSION_DENIED: API key permission denied'), VALID]);
    const out = await call({ userInput: 'Budget travel tips for Goa' });
    assert.strictEqual(out.status, 502);
    assert.strictEqual(state.prompts.length, 1);
  });

  await t('empty / too-short topic → 400, refunded, AI never called', async () => {
    for (const userInput of ['', '  ', 'ab']) {
      reset([VALID]);
      const out = await call({ userInput });
      assert.strictEqual(out.status, 400);
      assert.strictEqual(out.body.code, 'INVALID_INPUT');
      assert.strictEqual(out.body.message, 'Please enter a reel topic');
      assert.strictEqual(state.prompts.length, 0);
      assert.deepStrictEqual(state.refunds, ['key-1']);
    }
  });

  await t('explicit language request is passed to the prompt', async () => {
    reset([VALID]);
    await call({ userInput: 'Gym mistakes beginners make in hindi' });
    assert.ok(/Hindi/.test(state.prompts[0].userPrompt));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
