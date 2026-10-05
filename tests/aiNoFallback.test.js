/**
 * Captions + AI Content Engine: a failed or unusable generation is an error
 * with the credits refunded — never template content shown as a real result.
 */
const assert = require('assert');
const Module = require('module');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

const CAPTIONS_OK = JSON.stringify({
  captions: [
    { style: 'funny', text: 'Paneer tikka at home hits different 🔥', hashtags: ['paneertikka', '#homecooking'] },
    { style: 'aesthetic', text: 'Smoky, charred, homemade.', hashtags: ['#foodie'] },
    { style: 'cta', text: 'Save this recipe for the weekend!', hashtags: ['#recipe'] },
  ],
  best_time: '7-9 PM IST',
});
const ENGINE_OK = JSON.stringify({
  idea: 'Before/after of a beginner fixing squat form',
  hook: 'Your squat is hurting your knees, not helping them',
  script: ['Show the wrong squat', 'Explain knee cave', 'Show the fix', 'Save this for leg day'],
  caption: 'Fix this before your next leg day 💪',
  hashtags: ['gymtips', '#legday'],
  best_time: '7:00-9:00 PM IST',
});

// ── stubs ───────────────────────────────────────────────────────────────
// Replies are queued per Gemini "label" so the captions advisor call (its own
// label) never eats a reply meant for the main generation.
const state = { replies: {}, calls: {}, refunds: [], usage: [] };
const stubs = {
  '../utils/geminiClient': {
    runGemini: async (_prompt, opts) => {
      const label = String(opts.label || '');
      state.calls[label] = (state.calls[label] || 0) + 1;
      const q = state.replies[label] || [];
      const next = q.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error('GEMINI_API_ERROR: no stubbed reply');
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
const { generateCaptions, contentEngine, getJobStatus } = require('../controllers/geminiController');
console.log = quiet;

function mockRes(resolve) {
  return {
    statusCode: 200, headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.headersSent = true; resolve({ status: this.statusCode, body: b }); return this; },
  };
}
const req = (body) => ({ body, uid: 'u1', idempotencyKey: 'key-1', _aiEndpoint: '/ai/x', path: '/x' });
function reset(replies) { state.replies = replies; state.calls = {}; state.refunds = []; state.usage = []; }

async function captionsJob(body) {
  const created = await new Promise((r) => generateCaptions(req(body), mockRes(r)));
  if (created.status !== 200) return { created };
  for (let i = 0; i < 200; i++) {
    const st = await new Promise((r) => getJobStatus({ params: { jobId: created.body.jobId } }, mockRes(r)));
    if (st.body.status !== 'pending') return { created, final: st.body };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job never finished');
}

// contentEngine runs inside wrapAiHandler in production: a returned value is
// sent as { success, data }, an error is sent by the handler itself.
async function engine(body) {
  return new Promise((resolve) => {
    const res = mockRes(resolve);
    Promise.resolve(contentEngine(req(body), res)).then((value) => {
      if (!res.headersSent) res.json({ success: true, data: value });
    });
  });
}

(async () => {
  console.log('No-fallback tests (captions, content engine)\n');

  // ── Captions ──
  await t('captions: real result is returned and charged (no refund)', async () => {
    reset({ captions: [CAPTIONS_OK] });
    const { final } = await captionsJob({ userInput: 'Ghar pe paneer tikka kaise banaye' });
    assert.strictEqual(final.status, 'completed');
    assert.strictEqual(final.data.length, 3);
    assert.strictEqual(final.data[0].text, 'Paneer tikka at home hits different 🔥');
    assert.deepStrictEqual(state.refunds, []);
    assert.deepStrictEqual(state.usage, ['u1']);
  });

  await t('captions: Gemini fails twice → job failed, refunded, no template captions', async () => {
    reset({ captions: [new Error('GEMINI_TIMEOUT'), new Error('GEMINI_API_ERROR: 503')] });
    const { final } = await captionsJob({ userInput: 'Budget travel tips for Goa' });
    assert.strictEqual(final.status, 'failed');
    assert.strictEqual(final.data, null);
    assert.strictEqual(final.error, "Couldn't generate captions, please try again");
    assert.deepStrictEqual(state.refunds, ['key-1']);
    assert.deepStrictEqual(state.usage, []);
  });

  await t('captions: truncated JSON is not split into fake captions; retry succeeds', async () => {
    reset({ captions: ['```json\n{"captions": [\n  {"style": "funny", "text": "Paneer tikka at ho', CAPTIONS_OK] });
    const { final } = await captionsJob({ userInput: 'Ghar pe paneer tikka kaise banaye' });
    assert.strictEqual(final.status, 'completed');
    assert.strictEqual(state.calls.captions, 2);
    assert.ok(final.data.every((c) => !c.text.includes('{')));
  });

  await t('captions: a short real result is not topped up with templates', async () => {
    const one = JSON.stringify({ captions: [{ style: 'funny', text: 'Only one real caption here', hashtags: [] }] });
    reset({ captions: [one, one] });
    const { final } = await captionsJob({ userInput: 'Gym mistakes beginners make' });
    assert.strictEqual(final.status, 'completed');
    assert.strictEqual(final.data.length, 1);
  });

  await t('captions: empty input → 400, refunded, no job', async () => {
    reset({});
    const { created } = await captionsJob({ userInput: '  ' });
    assert.strictEqual(created.status, 400);
    assert.strictEqual(created.body.code, 'INVALID_INPUT');
    assert.deepStrictEqual(state.refunds, ['key-1']);
    assert.strictEqual(state.calls.captions, undefined);
  });

  // ── Content engine ──
  await t('content engine: real result returned and recorded', async () => {
    reset({ 'content-engine': [ENGINE_OK] });
    const out = await engine({ niche: 'Gym mistakes beginners make' });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(out.body.data.hook, 'Your squat is hurting your knees, not helping them');
    assert.deepStrictEqual(out.body.data.hashtags, ['#gymtips', '#legday']);
    assert.deepStrictEqual(state.refunds, []);
    assert.deepStrictEqual(state.usage, ['u1']);
  });

  await t('content engine: missing script is retried, not filled with template', async () => {
    reset({ 'content-engine': [JSON.stringify({ ...JSON.parse(ENGINE_OK), script: [] }), ENGINE_OK] });
    const out = await engine({ niche: 'Budget travel tips for Goa' });
    assert.strictEqual(out.status, 200);
    assert.strictEqual(state.calls['content-engine'], 2);
    assert.strictEqual(out.body.data.script.length, 4);
  });

  await t('content engine: two failures → 502 + refund, no fallback content', async () => {
    reset({ 'content-engine': ['not json at all', new Error('GEMINI_TIMEOUT')] });
    const out = await engine({ niche: '3 morning habits that changed my life' });
    assert.strictEqual(out.status, 502);
    assert.strictEqual(out.body.success, false);
    assert.strictEqual(out.body.message, "Couldn't generate content, please try again");
    assert.ok(!('data' in out.body));
    assert.deepStrictEqual(state.refunds, ['key-1']);
    assert.deepStrictEqual(state.usage, []);
  });

  await t('content engine: empty niche → 400 + refund, AI never called', async () => {
    reset({ 'content-engine': [ENGINE_OK] });
    const out = await engine({ niche: '' });
    assert.strictEqual(out.status, 400);
    assert.strictEqual(out.body.code, 'INVALID_INPUT');
    assert.deepStrictEqual(state.refunds, ['key-1']);
    assert.strictEqual(state.calls['content-engine'], undefined);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
