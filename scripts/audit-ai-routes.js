/**
 * Endpoint coverage audit: fail if any AI generation route is unprotected.
 * Run: node scripts/audit-ai-routes.js
 * Excludes read-only job-status. All other /ai POST routes must use requireAiAccess.
 */
const path = require('path');
const fs = require('fs');

const geminiPath = path.join(__dirname, '../routes/gemini.js');
const content = fs.readFileSync(geminiPath, 'utf8');

const AI_POST_ROUTES = [
  '/captions',
  '/image-captions',
  '/caption-from-media',
  '/calendar',
  '/strategy',
  '/analyze',
  '/reels-script',
  '/post-ideas',
  '/hashtags',
  '/bio',
  '/hooks',
  '/comment-reply',
  '/trends',
  '/carousel',
];

const EXCLUDED = ['/job-status'];

let failed = false;

if (!content.includes('requireAiAccess')) {
  console.error('FAIL: routes/gemini.js does not use requireAiAccess');
  failed = true;
}

const useMiddleware = content.includes('router.use(') && content.includes('requireAiAccess(req, res, next)');
if (!useMiddleware) {
  console.error('FAIL: requireAiAccess must be applied via router.use() to all POST /ai routes');
  failed = true;
}

for (const route of AI_POST_ROUTES) {
  const postRoute = `router.post('${route}'`;
  if (!content.includes(postRoute)) {
    console.error(`FAIL: Expected POST ${route} in gemini.js`);
    failed = true;
  }
}

if (!content.includes("router.get('/job-status/:jobId'")) {
  console.error('WARN: GET /job-status/:jobId should remain excluded from requireAiAccess');
}

if (failed) {
  process.exit(1);
}
console.log('OK: All AI POST routes are behind requireAiAccess. Excluded: GET /job-status/:jobId');
process.exit(0);
