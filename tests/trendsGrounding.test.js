/**
 * Trending Hashtags must only report trends it can trace to the live Google
 * Trends feed. The old version asked the model to "provide REAL, CURRENT
 * trending topics" and shipped whatever it invented.
 */
const assert = require('assert');
const Module = require('module');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

const LIVE = ['रक्षाबंधन कब है', 'weather gurugram', 'mariners vs phillies', 'monsoon skincare'];
const state = { geminiOut: '', jobs: {}, prompts: {} };

const stubs = {
  '../services/dailyDropGenerator': { fetchTrendKeywords: async () => LIVE },
  '../utils/creatorContext': { loadCreatorContext: async () => null, formatForPrompt: () => '' },
  '../middleware/aiAccess': { recordAiUsage: () => {}, refundAiCharge: () => {} },
  '../utils/geminiClient': {
    // Key by label: processTrends also triggers a buildAdvisor call, so a
    // single lastPrompt would capture the advisor's prompt, not the trend one.
    runGemini: async (prompt, opts) => {
      state.prompts[(opts && opts.label) || 'unlabelled'] = prompt;
      return state.geminiOut;
    },
    runGeminiWithImage: async () => '',
    runGeminiImageGen: async () => ({ base64: '', mimeType: 'image/png' }),
  },
  '../utils/jobStore': {
    createJob: (id, d) => { state.jobs[id] = { id, ...d }; return state.jobs[id]; },
    getJob: (id) => state.jobs[id],
    updateJob: (id, status, data) => { state.jobs[id] = { ...state.jobs[id], status, ...data }; },
    generateJobId: (p) => `${p}-test`,
  },
  '../utils/firestoreAdmin': { getDb: () => null, getAdmin: () => null },
  '../services/instagram_service': { buildCreatorContext: async () => null },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (stubs[req]) return req;
  return origResolve.call(this, req, ...rest);
};
for (const k of Object.keys(stubs)) require.cache[k] = { id: k, exports: stubs[k], loaded: true };

const ctrl = require('../controllers/geminiController');

// processTrends isn't exported; drive it through the public entry point.
function runTrends(niche) {
  return new Promise((resolve) => {
    const req = { body: { niche, category: niche }, uid: 'u1', idempotencyKey: 'k1' };
    const res = { json: () => {} };
    ctrl.generateTrends(req, res);
    // generateTrends kicks processTrends off in the background; poll the job.
    const started = Date.now();
    const poll = setInterval(() => {
      const job = state.jobs['TREND-test'];
      if (job && (job.status === 'done' || job.status === 'failed' || job.data)) {
        clearInterval(poll); resolve(job);
      } else if (Date.now() - started > 4000) {
        clearInterval(poll); resolve(job || null);
      }
    }, 20);
  });
}

(async () => {
  console.log('Trending Hashtags grounding');

  await t('the live keywords are put in the prompt', async () => {
    state.geminiOut = JSON.stringify({ trending: [], evergreen: { topics: [], hashtags: [] } });
    state.jobs = {};
    await runTrends('skincare');
    for (const k of LIVE) {
      assert.ok(state.prompts.trends.includes(k), `prompt should contain live keyword "${k}"`);
    }
  });

  await t('the prompt no longer asks the model to invent trends', async () => {
    assert.ok(!/provide REAL, CURRENT trending topics/i.test(state.prompts.trends),
      'the old invent-it instruction must be gone');
    assert.ok(/TRANSLATION, not invention/i.test(state.prompts.trends));
  });

  await t('entries citing a real keyword are kept', async () => {
    state.jobs = {};
    state.geminiOut = JSON.stringify({
      trending: [{
        topic: 'Monsoon skin barrier routine',
        from: 'monsoon skincare',
        why: 'people are searching it now',
        hashtags: ['#monsoonskincare', '#skinbarrier'],
        idea: 'POV: your skin in humidity — 3 swaps',
      }],
      evergreen: { topics: ['Ingredient myths'], hashtags: ['#skincaretips'] },
    });
    const job = await runTrends('skincare');
    assert.strictEqual(job.data.trending.length, 1, 'grounded entry should survive');
    assert.strictEqual(job.data.source, 'google_trends_in');
  });

  await t('invented "trends" are dropped before they reach the user', async () => {
    state.jobs = {};
    state.geminiOut = JSON.stringify({
      trending: [
        { topic: 'Real one', from: 'weather gurugram', hashtags: ['#a'], idea: 'x' },
        { topic: 'Made up', from: 'ipl 2024 final', hashtags: ['#ipl2024'], idea: 'y' },
        { topic: 'No source at all', hashtags: ['#b'], idea: 'z' },
      ],
      evergreen: { topics: [], hashtags: [] },
    });
    const job = await runTrends('cricket');
    assert.strictEqual(job.data.trending.length, 1, 'only the grounded entry should survive');
    assert.strictEqual(job.data.trending[0].from, 'weather gurugram');
    assert.ok(!JSON.stringify(job.data.hashtags).includes('ipl2024'),
      'a stale invented hashtag must not reach the user');
  });

  await t('hashtags are normalised with a leading #', async () => {
    state.jobs = {};
    state.geminiOut = JSON.stringify({
      trending: [{ topic: 'T', from: 'monsoon skincare', hashtags: ['nohash'], idea: 'i' }],
      evergreen: { topics: [], hashtags: ['alsonohash'] },
    });
    const job = await runTrends('skincare');
    assert.ok(job.data.hashtags.every((h) => h.startsWith('#')), job.data.hashtags.join(','));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
