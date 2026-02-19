/**
 * helpers.js — Extracts pure functions DIRECTLY from background.js and
 * popup.js at test time so the tests always run against the REAL code.
 *
 * No stale copies.  If you change background.js or popup.js, the tests
 * automatically pick up the new version on the next run.
 *
 * How it works:
 *   1. Read the source files as strings
 *   2. Extract each pure function by name (brace-matching)
 *   3. Eval them together in a Node VM sandbox
 *   4. Export the resulting functions for the test file to use
 *
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ── Read source files ───────────────────────────────────────── */

const bgSource = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');

/* ── Extract a function body from source by name ─────────────── */

/**
 * Pull a named function out of `src`.  Handles:
 *   function NAME(…) { … }
 *   async function NAME(…) { … }
 * Returns the full text including the "function" keyword.
 */
function extractFunction(src, name) {
  var pattern = new RegExp('((?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{)');
  var m = pattern.exec(src);
  if (!m) throw new Error('Could not find function "' + name + '" in source');

  var start = m.index;
  var braceStart = start + m[1].length - 1;
  var depth = 0;
  for (var i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.substring(start, i + 1); }
  }
  throw new Error('Unmatched braces for function "' + name + '"');
}

/**
 * Pull a var/const/let object literal declaration.
 */
function extractVar(src, name) {
  var pattern = new RegExp('(?:var|let|const)\\s+' + name + '\\s*=\\s*\\{');
  var m = pattern.exec(src);
  if (!m) throw new Error('Could not find var "' + name + '" in source');

  var start = m.index;
  var braceStart = src.indexOf('{', start + m[0].length - 1);
  var depth = 0;
  for (var i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.substring(start, i + 1) + ';'; }
  }
  throw new Error('Unmatched braces for var "' + name + '"');
}

/* ── Build sandbox source from real files ────────────────────── */

var code = 'var DEBUG = false;\n\n';

// background.js — pure functions (no Chrome APIs, no fetch)
var bgFuncs = [
  'normalize', 'fuzzyNorm', 'wordsContain', 'parseArtistTrack', 'tracklistContains',
  'parseDiscogsUrl', 'extractArtistNames', 'makeSellUrl', 'isVGPlusOrBetter',
  'isVinylFormat', 'computeMedian', 'parseFilteredPage',
];
for (var fn of bgFuncs) {
  code += extractFunction(bgSource, fn) + '\n\n';
}

// background.js — object constants
for (var vn of ['GRADE_ABBR', 'GRADE_RANK']) {
  code += extractVar(bgSource, vn) + '\n\n';
}

// background.js — buildFilteredUrl (rename to _bg to avoid collision with popup version)
code += extractFunction(bgSource, 'buildFilteredUrl')
  .replace('function buildFilteredUrl(', 'function buildFilteredUrl_bg(') + '\n\n';

// popup.js — pure functions (skip ones that touch the DOM)
code += extractFunction(popupSource, 'cleanTitle') + '\n\n';
code += extractFunction(popupSource, 'fmtPrice') + '\n\n';

// popup.js — buildFilteredUrl (rename to _popup)
code += extractFunction(popupSource, 'buildFilteredUrl')
  .replace('function buildFilteredUrl(', 'function buildFilteredUrl_popup(') + '\n\n';



/* ── parseSellPageHtml — compatibility wrapper ───────────────
 *
 * The old scrapeSellPage function was removed.  parseFilteredPage(html,
 * false, false) does the same thing (and more).  This wrapper provides
 * the original { numForSale, lowestPrice } return shape so existing
 * tests keep working.
 */
code += `
function parseSellPageHtml(html) {
  var pg = parseFilteredPage(html, false, false);
  return { numForSale: pg.total, lowestPrice: pg.lowest };
}
`;

/* ── Exports ─────────────────────────────────────────────────── */

code += `
module.exports = {
  normalize, fuzzyNorm, parseArtistTrack, tracklistContains,
  parseDiscogsUrl, extractArtistNames, makeSellUrl,
  GRADE_ABBR, GRADE_RANK, isVGPlusOrBetter, isVinylFormat, computeMedian,
  parseFilteredPage, parseSellPageHtml,
  buildFilteredUrl_bg, buildFilteredUrl_popup,
  cleanTitle, fmtPrice,
};
`;

/* ── Run in sandbox ──────────────────────────────────────────── */

var sandbox = {
  module: { exports: {} },
  require: require,
  console: console,
  Math: Math,
  Infinity: Infinity,
  parseInt: parseInt,
  parseFloat: parseFloat,
  isNaN: isNaN,
  Object: Object,
  RegExp: RegExp,
  decodeURIComponent: decodeURIComponent,
  encodeURIComponent: encodeURIComponent,
};
vm.createContext(sandbox);

try {
  vm.runInContext(code, sandbox, { filename: 'extracted-from-source.js' });
} catch (e) {
  // Show helpful context around the error
  console.error('\n=== SANDBOX EVAL ERROR ===');
  console.error('A function extracted from background.js or popup.js failed to eval.');
  console.error('This usually means a new dependency was added (Chrome API, DOM, etc.).');
  console.error('Error:', e.message);
  if (e.stack) {
    var lineMatch = e.stack.match(/extracted-from-source\.js:(\d+)/);
    if (lineMatch) {
      var lines = code.split('\n');
      var errLine = parseInt(lineMatch[1], 10);
      console.error('\nSource context:');
      for (var li = Math.max(0, errLine - 4); li < Math.min(lines.length, errLine + 3); li++) {
        console.error((li + 1 === errLine ? ' >>> ' : '     ') + (li + 1) + ': ' + lines[li]);
      }
    }
  }
  console.error('');
  throw e;
}

// Verify that scrapeFilteredListings + parseFilteredPage use the HTML-scraping
// approach for both condition (VG+) and location (US) filtering
var filteredFn = extractFunction(bgSource, 'scrapeFilteredListings');
var parseFiltFn = extractFunction(bgSource, 'parseFilteredPage');
var filteredSrc = filteredFn + '\n' + parseFiltFn;
var filteredChecks = [
  { pattern: 'isVGPlusOrBetter',      desc: 'direct condition check per listing' },
  { pattern: /Media[\s\S]*Condition/,  desc: 'splits HTML at Media Condition markers' },
  { pattern: 'Ships',               desc: 'parses Ships From per listing' },
  { pattern: 'medianPrice',            desc: 'returns medianPrice from matched prices' },
  { pattern: 'parseFilteredPage',      desc: 'delegates page parsing to parseFilteredPage' },
  { pattern: 'MAX_SCRAPE_PAGES',       desc: 'uses MAX_SCRAPE_PAGES constant for page limit' },
];
for (var vc of filteredChecks) {
  var vFound = typeof vc.pattern === 'string'
    ? filteredSrc.includes(vc.pattern)
    : vc.pattern.test(filteredSrc);
  if (!vFound) {
    console.error(
      '\n⚠️  TEST DRIFT WARNING: scrapeFilteredListings/parseFilteredPage no longer contains "' +
      vc.desc + '".\n' +
      '   The filtering approach may have changed.\n'
    );
  }
}

module.exports = sandbox.module.exports;
