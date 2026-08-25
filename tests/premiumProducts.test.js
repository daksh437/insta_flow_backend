/**
 * Only the credit plans/packs in config/credits.js are sellable. The old
 * premium_* subscription family must not grant unlimited premium any more.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); fail++; }
}

const APPROVED = [
  'instaflow_starter_299', 'instaflow_pro_599', 'instaflow_business_999',
  'credits_79', 'credits_149',
];

const src = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'aiAccess.js'), 'utf8');
const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'aiAccess.js'), 'utf8');
const { PLAN_CREDITS, PACK_CREDITS } = require('../config/credits');

console.log('Premium product allowlist');

t('config/credits.js sells exactly the five approved products', () => {
  const sold = [...Object.keys(PLAN_CREDITS), ...Object.keys(PACK_CREDITS)].sort();
  assert.deepStrictEqual(sold, [...APPROVED].sort());
});

t('PRODUCT_DAYS is empty — no product grants premium status', () => {
  const m = /const PRODUCT_DAYS = \{([^}]*)\}/.exec(src);
  assert.ok(m, 'PRODUCT_DAYS not found');
  assert.strictEqual(m[1].trim(), '', `PRODUCT_DAYS should be empty, got: ${m[1]}`);
});

t('no premium_* product id remains in the access middleware', () => {
  const hits = src.match(/premium_(monthly|3month|6month|12month)/g) || [];
  const outsideComments = hits.filter((_, i) => {
    // crude: only fail if one appears outside a comment line
    return src.split('\n').some((l) => l.includes(hits[i]) && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  });
  assert.strictEqual(outsideComments.length, 0, `found live refs: ${outsideComments.join(', ')}`);
});

t('premium is granted by allowlist lookup, not a startsWith prefix', () => {
  // Ignore comment lines — the prefix match is named in the comment that
  // explains why it was replaced.
  const codeLines = src
    .split('\n')
    .filter((l) => {
      const s = l.trim();
      return s && !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
    })
    .join('\n');
  assert.ok(!/startsWith\('premium'\)/.test(codeLines), "startsWith('premium') must not gate premium");
  assert.ok(/hasOwnProperty\.call\(PRODUCT_DAYS, productId\)/.test(codeLines), 'expected PRODUCT_DAYS allowlist check');
});

t('/activate-premium has no default productId and rejects unknown ones', () => {
  assert.ok(!/req\.body\?\.productId \|\| 'premium_monthly'/.test(routeSrc), 'default productId must be gone');
  assert.ok(/UNKNOWN_PRODUCT/.test(routeSrc), 'expected an unknown-product rejection');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
