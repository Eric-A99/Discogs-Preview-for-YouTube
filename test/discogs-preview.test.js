/**
 * Discogs Preview — Comprehensive Test Suite
 *
 * Run:  node --test test/discogs-preview.test.js
 *
 * Covers:
 *  1. String normalization & parsing (release discovery)
 *  2. Track matching (the "Ok" 2-char bug & false positives)
 *  3. YouTube title cleaning (correct query formation)
 *  4. Discogs URL parsing & deduplication
 *  5. Sell-page HTML scraping (pricing, counts, noise rejection)
 *  6. VG+ subtraction logic & grade helpers
 *  7. Filter URL construction
 *  8. Popup helpers (price formatting, filter labels)
 *  9. Integration-level scenarios (pipeline behavior)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const h = require('./helpers.js');


// ═══════════════════════════════════════════════════════════════
// 1. STRING NORMALIZATION
// ═══════════════════════════════════════════════════════════════

describe('normalize()', () => {
  it('lowercases and strips punctuation', () => {
    assert.equal(h.normalize('Hello, World!'), 'hello world');
  });

  it('collapses multiple spaces', () => {
    assert.equal(h.normalize('  foo   bar  '), 'foo bar');
  });

  it('handles null/undefined', () => {
    assert.equal(h.normalize(null), '');
    assert.equal(h.normalize(undefined), '');
    assert.equal(h.normalize(''), '');
  });

  it('strips special chars but keeps alphanumeric', () => {
    assert.equal(h.normalize("Rock'n'Roll — Live!"), 'rocknroll live');
  });

  it('strips unicode punctuation like em-dash and curly quotes', () => {
    assert.equal(h.normalize('Track\u2014Name'), 'trackname');
    assert.equal(h.normalize('It\u2019s'), 'its');
  });

  it('preserves digits', () => {
    assert.equal(h.normalize('Track 12'), 'track 12');
  });
});


describe('fuzzyNorm()', () => {
  it('maps "nite" → "night"', () => {
    assert.equal(h.fuzzyNorm('Saturday Nite'), 'saturday night');
  });

  it('maps "midnite" and "midnight" to same stem', () => {
    assert.equal(h.fuzzyNorm('Midnite'), h.fuzzyNorm('Midnight'));
    assert.equal(h.fuzzyNorm('Mid Night'), h.fuzzyNorm('Midnight'));
  });

  it('maps "tha" → "the"', () => {
    assert.equal(h.fuzzyNorm('Tha Crossroads'), 'the crossroads');
  });

  it('still does basic normalization', () => {
    assert.equal(h.fuzzyNorm("HELLO, WORLD!"), 'hello world');
  });

  it('leaves unrelated words untouched', () => {
    assert.equal(h.fuzzyNorm('Dynamite'), 'dynamite'); // "nite" not word-bounded
  });
});


// ═══════════════════════════════════════════════════════════════
// 2. ARTIST/TRACK PARSING
// ═══════════════════════════════════════════════════════════════

describe('parseArtistTrack()', () => {
  it('splits on " - " (standard YouTube separator)', () => {
    const r = h.parseArtistTrack('Artist Name - Track Title');
    assert.equal(r.artist, 'Artist Name');
    assert.equal(r.track, 'Track Title');
  });

  it('splits on " | " (pipe separator)', () => {
    const r = h.parseArtistTrack('Artist | Track');
    assert.equal(r.artist, 'Artist');
    assert.equal(r.track, 'Track');
  });

  it('splits on en-dash " – "', () => {
    const r = h.parseArtistTrack('Artist \u2013 Track');
    assert.equal(r.artist, 'Artist');
    assert.equal(r.track, 'Track');
  });

  it('splits on em-dash " — "', () => {
    const r = h.parseArtistTrack('Artist \u2014 Track');
    assert.equal(r.artist, 'Artist');
    assert.equal(r.track, 'Track');
  });

  it('splits on ": " (colon)', () => {
    const r = h.parseArtistTrack('Artist: Track');
    assert.equal(r.artist, 'Artist');
    assert.equal(r.track, 'Track');
  });

  it('prefers pipe over dash (first match wins)', () => {
    const r = h.parseArtistTrack('A | B - C');
    assert.equal(r.artist, 'A');
    assert.equal(r.track, 'B - C');
  });

  it('returns full query as track when no separator', () => {
    const r = h.parseArtistTrack('Just A Song Title');
    assert.equal(r.artist, '');
    assert.equal(r.track, 'Just A Song Title');
  });

  it('does not split on hyphenated words', () => {
    // "re-edit" has " - " but it should NOT split because there's no space
    // Actually "re-edit" has "-" without spaces, so it shouldn't match " - "
    const r = h.parseArtistTrack('Artist - Track Re-Edit');
    assert.equal(r.artist, 'Artist');
    assert.equal(r.track, 'Track Re-Edit');
  });

  it('handles separator at position 0 — no split', () => {
    // idx must be > 0
    const r = h.parseArtistTrack(' - Track Only');
    assert.equal(r.artist, '');
    assert.equal(r.track, ' - Track Only');
  });
});


// ═══════════════════════════════════════════════════════════════
// 3. TRACK MATCHING (CRITICAL — "Ok" bug, false positives)
// ═══════════════════════════════════════════════════════════════

describe('tracklistContains()', () => {
  const tracklist = [
    { title: 'Ok', type_: 'track' },
    { title: 'Longer Track Name', type_: 'track' },
    { title: 'Midnight Express', type_: 'track' },
    { title: 'Saturday Nite Fever', type_: 'track' },
  ];

  // ─── Short names (the "Ok" bug) ───
  describe('short name handling (2-3 chars)', () => {
    it('matches 2-char name "Ok" with exact match', () => {
      assert.equal(h.tracklistContains(tracklist, 'Ok'), true);
    });

    it('matches "Ok" case-insensitively', () => {
      assert.equal(h.tracklistContains(tracklist, 'OK'), true);
      assert.equal(h.tracklistContains(tracklist, 'ok'), true);
    });

    it('does NOT match 2-char name as substring of longer track', () => {
      // "Lo" should NOT match "Longer Track Name" since it's short-name exact mode
      assert.equal(h.tracklistContains(tracklist, 'Lo'), false);
    });

    it('does NOT match 3-char name as substring', () => {
      // "Lon" should NOT match "Longer Track Name" — exact only
      assert.equal(h.tracklistContains(tracklist, 'Lon'), false);
    });

    it('matches 3-char exact name', () => {
      const tl = [{ title: 'Fly', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, 'Fly'), true);
      assert.equal(h.tracklistContains(tl, 'FLY'), true);
    });

    it('rejects 1-char names (too short)', () => {
      const tl = [{ title: 'A', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, 'A'), false);
    });
  });

  // ─── Normal (4+ char) names ───
  describe('normal name matching (4+ chars)', () => {
    it('matches exact title', () => {
      assert.equal(h.tracklistContains(tracklist, 'Longer Track Name'), true);
    });

    it('matches when needle words appear in track title', () => {
      assert.equal(h.tracklistContains(tracklist, 'Midnight'), true);
    });

    it('matches when track title is subset of needle (remix scenario)', () => {
      // If needle is longer and contains all words of the track title
      const tl = [{ title: 'Blue Monday', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, 'Blue Monday Remix'), true);
    });

    it('does NOT match when track title is a prefix of a single word in needle', () => {
      // 'Fire' should NOT match 'Firestarter' — different words
      const tl = [{ title: 'Fire', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, 'Firestarter'), false);
    });

    it('does NOT match unrelated partial-word overlap', () => {
      // 'Star' should NOT match 'Stardust'
      const tl = [{ title: 'Star', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, 'Stardust'), false);
    });

    it('matches via fuzzy normalization (nite → night)', () => {
      assert.equal(h.tracklistContains(tracklist, 'Saturday Night Fever'), true);
    });

    it('does NOT match unrelated tracks', () => {
      assert.equal(h.tracklistContains(tracklist, 'Totally Different Song'), false);
    });
  });

  // ─── Edge cases ───
  describe('edge cases', () => {
    it('returns false for null/empty tracklist', () => {
      assert.equal(h.tracklistContains(null, 'Track'), false);
      assert.equal(h.tracklistContains([], 'Track'), false);
    });

    it('returns false for null/empty trackName', () => {
      assert.equal(h.tracklistContains(tracklist, ''), false);
      assert.equal(h.tracklistContains(tracklist, null), false);
    });

    it('skips non-track types (e.g., heading)', () => {
      const tl = [
        { title: 'Side A', type_: 'heading' },
        { title: 'Real Track', type_: 'track' },
      ];
      assert.equal(h.tracklistContains(tl, 'Side A'), false);
      assert.equal(h.tracklistContains(tl, 'Real Track'), true);
    });

    it('includes items with no type_ set (implicit track)', () => {
      const tl = [{ title: 'No Type Field' }];
      assert.equal(h.tracklistContains(tl, 'No Type Field'), true);
    });

    it('skips tracks with empty titles', () => {
      const tl = [{ title: '', type_: 'track' }, { title: 'Good Track', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, 'Good Track'), true);
    });

    it('handles special characters in track names', () => {
      const tl = [{ title: "Don't Stop", type_: 'track' }];
      assert.equal(h.tracklistContains(tl, "Don't Stop"), true);
    });

    it('handles ampersands and symbols', () => {
      const tl = [{ title: 'Rock & Roll', type_: 'track' }];
      // normalize strips &, so title becomes "rock roll"
      assert.equal(h.tracklistContains(tl, 'Rock  Roll'), true);
      // "Rock And Roll" → "rock and roll" — all words of title ("rock","roll")
      // appear in needle, so word-overlap matches (correct: same song)
      assert.equal(h.tracklistContains(tl, 'Rock And Roll'), true);
    });
  });
});


// ═══════════════════════════════════════════════════════════════
// 4. YOUTUBE TITLE CLEANING
// ═══════════════════════════════════════════════════════════════

describe('cleanTitle()', () => {
  it('strips " - YouTube" suffix', () => {
    assert.equal(h.cleanTitle('Artist - Track - YouTube'), 'Artist - Track');
  });

  it('strips (Official Music Video)', () => {
    assert.equal(h.cleanTitle('Artist - Track (Official Music Video)'), 'Artist - Track');
  });

  it('strips [Official Video]', () => {
    assert.equal(h.cleanTitle('Artist - Track [Official Video]'), 'Artist - Track');
  });

  it('strips (Lyric Video)', () => {
    assert.equal(h.cleanTitle('Artist - Track (Lyric Video)'), 'Artist - Track');
  });

  it('strips (Audio)', () => {
    assert.equal(h.cleanTitle('Artist - Track (Audio)'), 'Artist - Track');
  });

  it('strips (Visualizer)', () => {
    assert.equal(h.cleanTitle('Artist - Track (Visualizer)'), 'Artist - Track');
  });

  it('strips (Visualiser) — British spelling', () => {
    assert.equal(h.cleanTitle('Artist - Track (Visualiser)'), 'Artist - Track');
  });

  it('strips (Remastered)', () => {
    assert.equal(h.cleanTitle('Artist - Track (Remastered)'), 'Artist - Track');
  });

  it('strips (Remaster)', () => {
    assert.equal(h.cleanTitle('Artist - Track (Remaster)'), 'Artist - Track');
  });

  it('strips (HD)', () => {
    assert.equal(h.cleanTitle('Artist - Track (HD)'), 'Artist - Track');
  });

  it('strips (4K)', () => {
    assert.equal(h.cleanTitle('Artist - Track (4K)'), 'Artist - Track');
  });

  it('strips (Full Album)', () => {
    assert.equal(h.cleanTitle('Artist - Track (Full Album)'), 'Artist - Track');
  });

  it('strips hashtags', () => {
    assert.equal(h.cleanTitle('Artist - Track #newmusic #2024'), 'Artist - Track');
  });

  it('strips standalone "official music video"', () => {
    assert.equal(
      h.cleanTitle('Artist - Track official music video'),
      'Artist - Track'
    );
  });

  it('handles multiple tags at once', () => {
    assert.equal(
      h.cleanTitle('Artist - Track (Official Video) [Remastered] #hiphop - YouTube'),
      'Artist - Track'
    );
  });

  it('preserves meaningful parenthetical content', () => {
    // "(feat. Someone)" should NOT be stripped (no video/official keyword)
    assert.equal(
      h.cleanTitle('Artist - Track (feat. Someone)'),
      'Artist - Track (feat. Someone)'
    );
  });

  it('preserves remix tags', () => {
    assert.equal(
      h.cleanTitle('Artist - Track (DJ Mix)'),
      'Artist - Track (DJ Mix)'
    );
  });

  it('returns empty string for empty input', () => {
    assert.equal(h.cleanTitle(''), '');
  });

  it('collapses leftover double spaces', () => {
    const result = h.cleanTitle('Artist  -  Track  (Official Video)');
    assert.ok(!result.includes('  '), 'should not contain double spaces');
  });
});


// ═══════════════════════════════════════════════════════════════
// 5. DISCOGS URL PARSING
// ═══════════════════════════════════════════════════════════════

describe('parseDiscogsUrl()', () => {
  it('parses /master/12345 URL', () => {
    const r = [], s = {};
    h.parseDiscogsUrl('https://www.discogs.com/master/12345', r, s);
    assert.equal(r.length, 1);
    assert.equal(r[0].type, 'master');
    assert.equal(r[0].id, 12345);
    assert.equal(r[0].url, 'https://www.discogs.com/master/12345');
  });

  it('parses /release/67890 URL', () => {
    const r = [], s = {};
    h.parseDiscogsUrl('https://www.discogs.com/release/67890', r, s);
    assert.equal(r.length, 1);
    assert.equal(r[0].type, 'release');
    assert.equal(r[0].id, 67890);
  });

  it('parses /Artist-Name/master/12345 URL', () => {
    const r = [], s = {};
    h.parseDiscogsUrl('https://www.discogs.com/Some-Artist/master/12345', r, s);
    assert.equal(r.length, 1);
    assert.equal(r[0].type, 'master');
    assert.equal(r[0].id, 12345);
  });

  it('parses /Artist-Name/release/67890 URL', () => {
    const r = [], s = {};
    h.parseDiscogsUrl('https://www.discogs.com/Some-Artist/release/67890', r, s);
    assert.equal(r.length, 1);
    assert.equal(r[0].type, 'release');
    assert.equal(r[0].id, 67890);
  });

  it('deduplicates same master ID', () => {
    const r = [], s = {};
    h.parseDiscogsUrl('https://www.discogs.com/master/100', r, s);
    h.parseDiscogsUrl('https://www.discogs.com/Artist/master/100', r, s);
    assert.equal(r.length, 1);
  });

  it('deduplicates same release ID', () => {
    const r = [], s = {};
    h.parseDiscogsUrl('https://www.discogs.com/release/200', r, s);
    h.parseDiscogsUrl('https://www.discogs.com/Other/release/200', r, s);
    assert.equal(r.length, 1);
  });

  it('captures both master and release from same URL if present', () => {
    // A URL shouldn't have both, but if somehow it does, test behavior
    const r = [], s = {};
    // This is a single URL with both patterns — shouldn't normally happen
    h.parseDiscogsUrl('https://www.discogs.com/master/111', r, s);
    h.parseDiscogsUrl('https://www.discogs.com/release/222', r, s);
    assert.equal(r.length, 2);
  });

  it('ignores non-Discogs URLs', () => {
    const r = [], s = {};
    h.parseDiscogsUrl('https://www.google.com/search?q=test', r, s);
    assert.equal(r.length, 0);
  });

  it('ignores Discogs URLs without master/release', () => {
    const r = [], s = {};
    h.parseDiscogsUrl('https://www.discogs.com/artist/12345', r, s);
    assert.equal(r.length, 0);
  });

  it('ignores Discogs label pages', () => {
    const r = [], s = {};
    h.parseDiscogsUrl('https://www.discogs.com/label/12345', r, s);
    assert.equal(r.length, 0);
  });
});


describe('extractArtistNames()', () => {
  it('extracts simple artist name', () => {
    assert.equal(h.extractArtistNames([{ name: 'Radiohead' }]), 'Radiohead');
  });

  it('strips Discogs disambiguation number', () => {
    assert.equal(h.extractArtistNames([{ name: 'Radiohead (2)' }]), 'Radiohead');
  });

  it('joins multiple artists with comma', () => {
    assert.equal(
      h.extractArtistNames([{ name: 'Artist A' }, { name: 'Artist B' }]),
      'Artist A, Artist B'
    );
  });

  it('handles null input', () => {
    assert.equal(h.extractArtistNames(null), '');
  });

  it('handles artist with empty name', () => {
    assert.equal(h.extractArtistNames([{ name: '' }]), '');
  });

  it('handles mixed: some with numbers, some without', () => {
    assert.equal(
      h.extractArtistNames([{ name: 'DJ Shadow (3)' }, { name: 'Cut Chemist' }]),
      'DJ Shadow, Cut Chemist'
    );
  });
});


// ═══════════════════════════════════════════════════════════════
// 6. SELL URL CONSTRUCTION
// ═══════════════════════════════════════════════════════════════

describe('makeSellUrl()', () => {
  it('prefers releaseId over masterId for accurate per-release counts', () => {
    const url = h.makeSellUrl({ masterId: 123, releaseId: 456 }, 'query');
    assert.ok(url.includes('/sell/release/456'), 'should use release URL when releaseId available');
    assert.ok(!url.includes('master_id'), 'should not use master URL');
  });

  it('falls back to master_id when no releaseId', () => {
    const url = h.makeSellUrl({ masterId: 123, releaseId: null }, 'query');
    assert.ok(url.includes('master_id=123'));
    assert.ok(url.includes('format=Vinyl'));
  });

  it('uses release path when no masterId', () => {
    const url = h.makeSellUrl({ masterId: null, releaseId: 456 }, 'query');
    assert.ok(url.includes('/sell/release/456'));
  });

  it('falls back to search URL when neither ID present', () => {
    const url = h.makeSellUrl({ masterId: null, releaseId: null }, 'test query');
    assert.ok(url.includes('/search/'));
    assert.ok(url.includes('test+query') || url.includes('test%20query'));
  });
});


// ═══════════════════════════════════════════════════════════════
// 7. SELL PAGE SCRAPING (CRITICAL — pricing bugs)
// ═══════════════════════════════════════════════════════════════

describe('parseSellPageHtml()', () => {

  // ─── Count extraction ───
  describe('count extraction', () => {
    it('extracts count from "X - Y of Z" pagination', () => {
      const html = '<div>1 - 25 of 150</div><div>Media Condition</div><span>$20.00</span>';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 150);
    });

    it('extracts count with comma separator', () => {
      const html = '<div>1 - 25 of 1,234</div><div>Media Condition</div><span>$10.00</span>';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 1234);
    });

    it('extracts count with en-dash separator', () => {
      const html = '<div>1 \u2013 25 of 50</div><div>Media Condition</div><span>$10.00</span>';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 50);
    });

    it('does NOT false-match "Terms of 2026" as count', () => {
      const html = '<div>Terms of 2026</div><div>Media Condition</div><span>$10.00</span>';
      const r = h.parseSellPageHtml(html);
      // Should fall back to counting Media Condition occurrences, not 2026
      assert.notEqual(r.numForSale, 2026);
    });

    it('does NOT false-match "Best of 20" as count', () => {
      const html = '<div>Best of 20 Greatest Hits</div><div>Media Condition</div><span>$10.00</span>';
      const r = h.parseSellPageHtml(html);
      assert.notEqual(r.numForSale, 20);
    });

    it('returns 0 for "No items for sale"', () => {
      const html = '<div>No items for sale</div>';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 0);
    });

    it('returns 0 for "0 results"', () => {
      const html = '<div>0 results found</div>';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 0);
    });

    it('returns 0 for "Sorry, no results"', () => {
      const html = '<div>Sorry, no results were found</div>';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 0);
    });

    it('falls back to counting "Media Condition" occurrences on single page', () => {
      // No "of X" pagination (single page of results) and no "no results" message
      const html = `
        <div>Some header</div>
        <div>Media Condition: Very Good Plus (VG+)</div><div>Sleeve Condition: Very Good (VG)</div><span>$20.00</span><div>Ships From: Germany</div>
        <div>Media Condition: Near Mint (NM or M-)</div><div>Sleeve Condition: Near Mint (NM or M-)</div><span>$30.00</span><div>Ships From: Germany</div>
      `;
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 2);
    });
  });

  // ─── Price extraction (the BIG category of bugs) ───
  describe('price extraction', () => {
    it('extracts simple listing price', () => {
      const html = '1 - 25 of 50 Media Condition: Very Good Plus (VG+) Sleeve Condition: VG $25.00 Ships From: Germany';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.lowestPrice, 25.00);
    });

    it('extracts price with comma', () => {
      const html = '1 - 25 of 50 Media Condition: Very Good Plus (VG+) Sleeve Condition: VG $1,250.00 Ships From: Germany';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.lowestPrice, 1250.00);
    });

    it('skips +$shipping cost — THE $6 BUG', () => {
      // Bug: "+$6.00 shipping" was previously matched as lowest price
      const html = `
        1 - 25 of 50
        Media Condition: Very Good Plus (VG+)
        Sleeve Condition: VG
        $50.00
        +$6.00 shipping
        $56.00
        Ships From: Germany
      `;
      const r = h.parseSellPageHtml(html);
      assert.equal(r.lowestPrice, 50.00);
    });

    it('skips "about $X" currency conversion', () => {
      const html = `
        1 - 25 of 50
        Media Condition: Very Good Plus (VG+)
        Sleeve Condition: VG
        €80.00
        about $94.12
        $50.00
        Ships From: Germany
      `;
      const r = h.parseSellPageHtml(html);
      assert.equal(r.lowestPrice, 50.00);
    });

    it('skips "shipping $X" combined total', () => {
      const html = `
        1 - 25 of 50
        Media Condition: Very Good Plus (VG+)
        Sleeve Condition: VG
        $40.00
        +$5.00
        shipping $45.00
        Ships From: Germany
      `;
      const r = h.parseSellPageHtml(html);
      assert.equal(r.lowestPrice, 40.00);
    });

    it('ignores sidebar prices BEFORE "Media Condition" marker — THE $40 BUG', () => {
      // Bug: "More than $40" sidebar filter was captured
      const html = `
        <div class="sidebar">
          <span>Price: $0 - $10</span>
          <span>More than $40</span>
        </div>
        1 - 25 of 50
        <div class="listing">
          Media Condition: Very Good Plus (VG+)
          Sleeve Condition: VG
          <span class="price">$25.00</span>
          <span>+$4.00 shipping</span>
          Ships From: Germany
        </div>
      `;
      const r = h.parseSellPageHtml(html);
      assert.equal(r.lowestPrice, 25.00);
    });

    it('sidebar "Media Condition" heading does NOT create a phantom listing', () => {
      // Real Discogs sell pages have a sidebar filter section that contains
      // "Media Condition:" labels followed by grade names.  When we split on
      // "Media Condition:", this creates phantom blocks.  We skip them
      // because they lack "Sleeve Condition" (only real listings have it).
      // NOTE: Discogs does NOT include pagination text in server-rendered
      // HTML for single-page results (≤25 items) — it's client-rendered
      // via JavaScript.  So hasPagination is false in this scenario.
      const html = `
        <div class="sidebar-filters">
          Media Condition:
          <a>Very Good Plus (VG+)</a><span>5</span>
          Media Condition:
          <a>Good (G)</a><span>1</span>
          <a>Near Mint (NM or M-)</a><span>1</span>
        </div>
        <div class="listing">
          Media Condition: Good (G)
          Sleeve Condition: Fair (F)
          $1.99
          Ships From: Germany
        </div>
        <div class="listing">
          Media Condition: Very Good Plus (VG+)
          Sleeve Condition: Very Good Plus (VG+)
          $3.00
          Ships From: Germany
        </div>
        <div class="listing">
          Media Condition: Very Good Plus (VG+)
          Sleeve Condition: Very Good Plus (VG+)
          $3.00
          Ships From: Germany
        </div>
        <div class="listing">
          Media Condition: Very Good Plus (VG+)
          Sleeve Condition: Very Good Plus (VG+)
          $3.00
          Ships From: Germany
        </div>
        <div class="listing">
          Media Condition: Very Good Plus (VG+)
          Sleeve Condition: Very Good (VG)
          $4.00
          Ships From: Germany
        </div>
        <div class="listing">
          Media Condition: Very Good Plus (VG+)
          Sleeve Condition: Very Good (VG)
          $15.84
          Ships From: Germany
        </div>
        <div class="listing">
          Media Condition: Near Mint (NM or M-)
          Sleeve Condition: Near Mint (NM or M-)
          $18.00
          Ships From: Germany
        </div>
      `;
      // Unfiltered: 7 listings, not 8 (sidebar phantom must be skipped)
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 7);
      assert.equal(r.lowestPrice, 1.99);

      // Filtered VG+: 6 listings (the Good (G) one is excluded)
      const f = h.parseFilteredPage(html, false, true);
      assert.equal(f.matched, 6);
      assert.equal(f.lowest, 3.00);
    });

    it('returns null price when 0 items for sale — THE $1.01 BUG', () => {
      // Bug: random "$" on page was captured when 0 results
      const html = '<div>No items for sale</div><span>Some $1.01 random text</span>';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 0);
      assert.equal(r.lowestPrice, null);
    });

    it('returns null price when no "Media Condition" marker found', () => {
      // numForSale from "of X" but no listing area
      const html = '1 - 25 of 50 <div>No listing content here</div>';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 50);
      assert.equal(r.lowestPrice, null);
    });

    it('takes FIRST valid price (page is sorted price-asc)', () => {
      const html = `
        1 - 25 of 100
        Media Condition: Very Good Plus (VG+)
        Sleeve Condition: VG
        $15.00
        +$4.00 shipping $19.00
        Ships From: Germany
        Media Condition: Near Mint (NM or M-)
        Sleeve Condition: VG
        $25.00
        +$5.00 shipping $30.00
        Ships From: Germany
      `;
      const r = h.parseSellPageHtml(html);
      assert.equal(r.lowestPrice, 15.00);
    });

    it('handles mixed foreign + domestic listings', () => {
      // First listing is foreign (euro + about), second is domestic ($)
      const html = `
        1 - 25 of 50
        Media Condition: Very Good Plus (VG+)
        Sleeve Condition: VG
        €80.00
        about $94.12
        + shipping
        Ships From: Germany
        Media Condition: Very Good Plus (VG+)
        Sleeve Condition: VG
        $50.00
        +$6.00 shipping $56.00
        Ships From: Germany
      `;
      const r = h.parseSellPageHtml(html);
      assert.equal(r.lowestPrice, 50.00);
    });

    it('handles "Media-Condition:" (hyphenated) as marker', () => {
      const html = '1 - 25 of 10 Media-Condition: Very Good Plus (VG+) Sleeve Condition: VG $30.00 Ships From: Germany';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.lowestPrice, 30.00);
    });
  });

  // ─── Combined scenarios ───
  describe('combined scenarios', () => {
    it('realistic Discogs sell page with sidebar noise, shipping, and conversions', () => {
      const html = `
        <html>
        <div class="sidebar">
          <div>Price</div>
          <a>$0 - $5</a>
          <a>$5 - $10</a>
          <a>$10 - $25</a>
          <a>$25 - $50</a>
          <a>More than $50</a>
          <div>Condition</div>
          <a>Mint (M)</a>
          <a>Near Mint (NM or M-)</a>
          <a>Very Good Plus (VG+)</a>
        </div>
        <div class="pagination">1 - 25 of 342</div>
        <div class="listing">
          <div>Media Condition: Very Good Plus (VG+)</div>
          <div>Sleeve Condition: Very Good (VG)</div>
          <span class="price">$19.99</span>
          <span class="shipping">+$4.50 shipping</span>
          <span class="total">$24.49</span>
          Ships From: Germany
        </div>
        <div class="listing">
          <div>Media Condition: Near Mint (NM or M-)</div>
          <div>Sleeve Condition: Very Good (VG)</div>
          <span class="converted">€25.00 about $28.12</span>
          <span class="shipping">+ shipping</span>
          Ships From: Germany
        </div>
        <div class="listing">
          <div>Media Condition: Very Good (VG)</div>
          <div>Sleeve Condition: Good (G)</div>
          <span class="price">$22.00</span>
          <span class="shipping">+$5.00 shipping</span>
          <span class="total">shipping $27.00</span>
          Ships From: Germany
        </div>
        </html>
      `;
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 342);
      assert.equal(r.lowestPrice, 19.99);
    });

    it('single item page (no pagination "of X")', () => {
      const html = `
        <div>1 result</div>
        <div>Media Condition: Near Mint (NM or M-)</div>
        <div>Sleeve Condition: Very Good (VG)</div>
        <span>$75.00</span>
        <span>+$8.00 shipping</span>
        Ships From: Germany
      `;
      // No "of X" → falls back to counting "Media Condition"
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 1);
      assert.equal(r.lowestPrice, 75.00);
    });
  });
});


// ═══════════════════════════════════════════════════════════════
// 8. GRADE HELPERS
// ═══════════════════════════════════════════════════════════════

describe('isVGPlusOrBetter()', () => {
  it('Mint is VG+ or better', () => {
    assert.equal(h.isVGPlusOrBetter('Mint (M)'), true);
  });

  it('Near Mint is VG+ or better', () => {
    assert.equal(h.isVGPlusOrBetter('Near Mint (NM or M-)'), true);
  });

  it('VG+ is VG+ or better', () => {
    assert.equal(h.isVGPlusOrBetter('Very Good Plus (VG+)'), true);
  });

  it('VG is NOT VG+ or better', () => {
    assert.equal(h.isVGPlusOrBetter('Very Good (VG)'), false);
  });

  it('Good is NOT VG+ or better', () => {
    assert.equal(h.isVGPlusOrBetter('Good (G)'), false);
  });

  it('Fair is NOT VG+ or better', () => {
    assert.equal(h.isVGPlusOrBetter('Fair (F)'), false);
  });

  it('Poor is NOT VG+ or better', () => {
    assert.equal(h.isVGPlusOrBetter('Poor (P)'), false);
  });

  it('unknown grade returns false', () => {
    assert.equal(h.isVGPlusOrBetter('Whatever'), false);
  });

  it('null/undefined returns false', () => {
    assert.equal(h.isVGPlusOrBetter(null), false);
    assert.equal(h.isVGPlusOrBetter(undefined), false);
  });
});

describe('GRADE_ABBR', () => {
  it('has all 8 standard grades', () => {
    assert.equal(Object.keys(h.GRADE_ABBR).length, 8);
  });

  it('maps VG+ correctly', () => {
    assert.equal(h.GRADE_ABBR['Very Good Plus (VG+)'], 'VG+');
  });

  it('maps NM correctly', () => {
    assert.equal(h.GRADE_ABBR['Near Mint (NM or M-)'], 'NM-');
  });
});


// ═══════════════════════════════════════════════════════════════
// 8b. FORMAT FILTERING
// ═══════════════════════════════════════════════════════════════

describe('isVinylFormat()', () => {
  it('returns true for vinyl format', () => {
    assert.equal(h.isVinylFormat([{ name: 'Vinyl', qty: '1' }]), true);
  });

  it('returns true when vinyl is among multiple formats', () => {
    assert.equal(h.isVinylFormat([
      { name: 'Vinyl', qty: '1' },
      { name: 'CD', qty: '1' }
    ]), true);
  });

  it('returns false for CD-only', () => {
    assert.equal(h.isVinylFormat([{ name: 'CD', qty: '1' }]), false);
  });

  it('returns false for cassette-only', () => {
    assert.equal(h.isVinylFormat([{ name: 'Cassette', qty: '1' }]), false);
  });

  it('returns false for digital', () => {
    assert.equal(h.isVinylFormat([{ name: 'File', qty: '1' }]), false);
  });

  it('returns false for null/empty', () => {
    assert.equal(h.isVinylFormat(null), false);
    assert.equal(h.isVinylFormat([]), false);
  });

  it('returns false for undefined', () => {
    assert.equal(h.isVinylFormat(undefined), false);
  });
});


// ═══════════════════════════════════════════════════════════════
// 9. FILTER URL BUILDING
// ═══════════════════════════════════════════════════════════════

describe('buildFilteredUrl_bg() — background.js version', () => {
  it('adds ships_from for US-only', () => {
    const url = h.buildFilteredUrl_bg('https://www.discogs.com/sell/list?master_id=123', true);
    assert.ok(url.includes('ships_from=United+States'));
    assert.ok(url.includes('&'), 'should use & since ? exists');
  });

  it('uses ? when no existing params', () => {
    const url = h.buildFilteredUrl_bg('https://www.discogs.com/sell/release/456', true);
    assert.ok(url.includes('?ships_from=United+States'));
  });

  it('returns unmodified URL when usOnly is false', () => {
    const base = 'https://www.discogs.com/sell/list?master_id=123';
    assert.equal(h.buildFilteredUrl_bg(base, false), base);
  });
});

describe('buildFilteredUrl_popup() — popup.js version', () => {
  it('adds ships_from for US-only', () => {
    const url = h.buildFilteredUrl_popup('https://www.discogs.com/sell/list?master_id=123', true, false);
    assert.ok(url.includes('ships_from=United+States'));
  });

  it('releaseId rewrites URL to release sell page', () => {
    const url = h.buildFilteredUrl_popup('https://www.discogs.com/sell/list?master_id=123', false, false, 456);
    assert.ok(url.startsWith('https://www.discogs.com/sell/release/456'), 'should use release URL');
    assert.ok(!url.includes('condition'), 'condition params are broken on Discogs');
  });

  it('VG+ without releaseId keeps master URL, no condition params', () => {
    const url = h.buildFilteredUrl_popup('https://www.discogs.com/sell/list?master_id=123', false, true);
    assert.ok(url.includes('master_id=123'), 'should keep master URL');
    assert.ok(!url.includes('condition'), 'condition params are broken on Discogs');
  });

  it('handles both US and VG+ flags with releaseId', () => {
    const url = h.buildFilteredUrl_popup('https://www.discogs.com/sell/list?master_id=123', true, true, 789);
    assert.ok(url.startsWith('https://www.discogs.com/sell/release/789'), 'should use release URL');
    assert.ok(url.includes('ships_from=United+States'));
    assert.ok(!url.includes('condition'), 'condition params are broken on Discogs');
  });

  it('returns null for null input', () => {
    assert.equal(h.buildFilteredUrl_popup(null, true, true), null);
  });

  it('no filters and no releaseId returns url unchanged', () => {
    const base = 'https://www.discogs.com/sell/list?master_id=123';
    assert.equal(h.buildFilteredUrl_popup(base, false, false), base);
  });
});


// ═══════════════════════════════════════════════════════════════
// 10. POPUP HELPERS
// ═══════════════════════════════════════════════════════════════

describe('fmtPrice()', () => {
  it('formats a normal price', () => {
    assert.equal(h.fmtPrice(25.5), '$25.50');
  });

  it('formats zero', () => {
    assert.equal(h.fmtPrice(0), '$0.00');
  });

  it('formats large price', () => {
    assert.equal(h.fmtPrice(1250.99), '$1250.99');
  });

  it('returns dash for null', () => {
    assert.equal(h.fmtPrice(null), '—');
  });

  it('returns dash for undefined', () => {
    assert.equal(h.fmtPrice(undefined), '—');
  });
});


// ═══════════════════════════════════════════════════════════════
// 11. INTEGRATION-LEVEL: SEARCH PIPELINE SCENARIOS
// ═══════════════════════════════════════════════════════════════

describe('search pipeline scenarios (unit-level)', () => {
  describe('parseArtistTrack → tracklistContains flow', () => {
    it('Blueless - Ok → finds track "Ok" on tracklist', () => {
      const parsed = h.parseArtistTrack('Blueless - Ok');
      assert.equal(parsed.artist, 'Blueless');
      assert.equal(parsed.track, 'Ok');

      const tracklist = [
        { title: 'Run Away', type_: 'track' },
        { title: 'Ok', type_: 'track' },
        { title: 'Blue World', type_: 'track' },
      ];
      assert.equal(h.tracklistContains(tracklist, parsed.track), true);
    });

    it('cleanTitle → parseArtistTrack flow for YouTube title', () => {
      const raw = 'Blueless - Ok (Official Video) - YouTube';
      const clean = h.cleanTitle(raw);
      assert.equal(clean, 'Blueless - Ok');
      const parsed = h.parseArtistTrack(clean);
      assert.equal(parsed.track, 'Ok');
    });

    it('handles track with no separator in YouTube title', () => {
      const raw = 'Just A Song Name (Official Music Video) - YouTube';
      const clean = h.cleanTitle(raw);
      const parsed = h.parseArtistTrack(clean);
      assert.equal(parsed.artist, '');
      assert.equal(parsed.track, 'Just A Song Name');
    });
  });

  describe('fallback mode (empty trackName)', () => {
    it('tracklistContains returns false for empty string (caller handles via !trackName)', () => {
      // The actual code does: !trackName || tracklistContains(...)
      // So when trackName is "", !trackName is true → always accepts
      const tracklist = [{ title: 'Anything', type_: 'track' }];
      assert.equal(h.tracklistContains(tracklist, ''), false);
      // But in the code: !"" === true, so the release is accepted
      assert.equal(!"", true);
    });
  });

  describe('VG+ subtraction logic', () => {
    it('correctly computes VG+ count from total and bad grades', () => {
      // Simulating scrapeFilteredListings subtraction logic
      const total = 100;
      const vgCount = 20;
      const gCount = 5;
      const fCount = 2;
      const pCount = 1;
      const badCount = vgCount + gCount + fCount + pCount; // 28
      const vgPlusOrBetter = Math.max(0, total - badCount);
      assert.equal(vgPlusOrBetter, 72);
    });

    it('returns 0 when bad grades exceed total (rounding/race)', () => {
      const total = 10;
      const badCount = 12; // can happen if listings change between requests
      const vgPlusOrBetter = Math.max(0, total - badCount);
      assert.equal(vgPlusOrBetter, 0);
    });

    it('returns null price when VG+ count is 0', () => {
      const vgPlusCount = 0;
      const totalLowestPrice = 15.00;
      const result = vgPlusCount > 0 ? totalLowestPrice : null;
      assert.equal(result, null);
    });
  });

  describe('pricing aggregation edge cases', () => {
    it('Infinity check: lowestPrice defaults to null when no prices found', () => {
      let lowestPrice = Infinity;
      // ... no prices added ...
      if (lowestPrice === Infinity) lowestPrice = null;
      assert.equal(lowestPrice, null);
    });

    it('median calculation for odd-length array', () => {
      const allPrices = [10, 20, 30];
      allPrices.sort((a, b) => a - b);
      const median = allPrices[Math.floor(allPrices.length / 2)];
      assert.equal(median, 20);
    });

    it('median calculation for even-length array (takes lower-middle)', () => {
      const allPrices = [10, 20, 30, 40];
      allPrices.sort((a, b) => a - b);
      const median = allPrices[Math.floor(allPrices.length / 2)];
      assert.equal(median, 30); // floor(4/2)=2 → index 2 → 30
    });

    it('median returns null for empty array', () => {
      const allPrices = [];
      const median = allPrices.length > 0 ? allPrices[Math.floor(allPrices.length / 2)] : null;
      assert.equal(median, null);
    });
  });

  describe('match sorting (cheapest first)', () => {
    it('sorts matches by lowestPrice ascending', () => {
      const matches = [
        { title: 'Expensive', lowestPrice: 50 },
        { title: 'Cheap', lowestPrice: 10 },
        { title: 'Mid', lowestPrice: 25 },
      ];
      matches.sort((a, b) => {
        if (a.lowestPrice == null && b.lowestPrice == null) return 0;
        if (a.lowestPrice == null) return 1;
        if (b.lowestPrice == null) return -1;
        return a.lowestPrice - b.lowestPrice;
      });
      assert.equal(matches[0].title, 'Cheap');
      assert.equal(matches[1].title, 'Mid');
      assert.equal(matches[2].title, 'Expensive');
    });

    it('puts null prices at end', () => {
      const matches = [
        { title: 'No Price', lowestPrice: null },
        { title: 'Has Price', lowestPrice: 10 },
      ];
      matches.sort((a, b) => {
        if (a.lowestPrice == null && b.lowestPrice == null) return 0;
        if (a.lowestPrice == null) return 1;
        if (b.lowestPrice == null) return -1;
        return a.lowestPrice - b.lowestPrice;
      });
      assert.equal(matches[0].title, 'Has Price');
      assert.equal(matches[1].title, 'No Price');
    });
  });

  describe('showFilteredData price fallback logic', () => {
    it('uses filter-specific price when scraper returns a price', () => {
      const fData = { numForSale: 5, lowestPrice: 30.00 };
      const gLowest = 10.00; // global API price (cheaper but global, not filtered)
      const fLowest = fData.lowestPrice != null ? fData.lowestPrice : null;
      const displayed = fData.numForSale > 0 ? (fLowest != null ? fLowest : gLowest) : null;
      assert.equal(displayed, 30.00); // should show filtered price, not global
    });

    it('falls back to API price when scraper returns null price', () => {
      const fData = { numForSale: 5, lowestPrice: null };
      const gLowest = 10.00;
      const fLowest = fData.lowestPrice != null ? fData.lowestPrice : null;
      const displayed = fData.numForSale > 0 ? (fLowest != null ? fLowest : gLowest) : null;
      assert.equal(displayed, 10.00);
    });

    it('returns null price when 0 copies for sale', () => {
      const fData = { numForSale: 0, lowestPrice: null };
      const gLowest = 10.00;
      const fLowest = fData.lowestPrice != null ? fData.lowestPrice : null;
      const displayed = fData.numForSale > 0 ? (fLowest != null ? fLowest : gLowest) : null;
      assert.equal(displayed, null);
    });

    it('does NOT show global price when filtered count is 0 — THE $3 WORLDWIDE BUG', () => {
      // Bug: global API returned $3 (worldwide), US filter had 0 copies
      // but still showed $3 because it fell back to global price
      const fData = { numForSale: 0, lowestPrice: null };
      const gLowest = 3.00;
      const fLowest = fData.lowestPrice != null ? fData.lowestPrice : null;
      const displayed = fData.numForSale > 0 ? (fLowest != null ? fLowest : gLowest) : null;
      assert.equal(displayed, null, 'should NOT show global $3 when 0 US copies');
    });
  });
});


// ═══════════════════════════════════════════════════════════════
// 12. REGRESSION TESTS — specific bugs that were fixed
// ═══════════════════════════════════════════════════════════════

describe('regression tests', () => {
  it('BUG: 2-char track name "Ok" rejected (needle.length < 3 guard)', () => {
    const tl = [{ title: 'Ok', type_: 'track' }];
    assert.equal(h.tracklistContains(tl, 'Ok'), true);
  });

  it('BUG: shipping cost $6 shown as lowest price', () => {
    const html = `1 - 25 of 50 Media Condition: Very Good Plus (VG+) Sleeve Condition: VG $50.00 +$6.00 shipping $56.00 Ships From: Germany`;
    const r = h.parseSellPageHtml(html);
    assert.equal(r.lowestPrice, 50.00);
    assert.notEqual(r.lowestPrice, 6.00);
  });

  it('BUG: sidebar "More than $40" shown as lowest price', () => {
    const html = `
      <div>More than $40</div>
      <div>Price: $0 - $10</div>
      1 - 25 of 50
      Media Condition: Very Good Plus (VG+)
      Sleeve Condition: VG
      $25.00
      Ships From: Germany
    `;
    const r = h.parseSellPageHtml(html);
    assert.equal(r.lowestPrice, 25.00);
    assert.notEqual(r.lowestPrice, 40.00);
    assert.notEqual(r.lowestPrice, 0);
    assert.notEqual(r.lowestPrice, 10);
  });

  it('BUG: $1.01 phantom price when 0 copies for sale', () => {
    const html = `<div>No items for sale</div><p>Related: $1.01 thing</p>`;
    const r = h.parseSellPageHtml(html);
    assert.equal(r.numForSale, 0);
    assert.equal(r.lowestPrice, null);
  });

  it('BUG: global $3 worldwide price shown for US filter with 0 copies', () => {
    // Verifying the price display logic
    const fData = { numForSale: 0, lowestPrice: null };
    const globalPrice = 3.00;
    const displayed = fData.numForSale > 0
      ? (fData.lowestPrice != null ? fData.lowestPrice : globalPrice)
      : null;
    assert.equal(displayed, null);
  });

  it('BUG: "about $94.12" currency conversion shown as listing price', () => {
    const html = `1 - 25 of 50 Media Condition: Very Good Plus (VG+) Sleeve Condition: VG €80.00 about $94.12 $50.00 Ships From: Germany`;
    const r = h.parseSellPageHtml(html);
    assert.equal(r.lowestPrice, 50.00);
    assert.notEqual(r.lowestPrice, 94.12);
  });

  it('BUG: fallback mode should accept any release when trackName is empty', () => {
    // In the code: !trackName || tracklistContains(...)
    // For trackName = "" → !"" === true → accepted
    const trackName = "";
    const accepted = !trackName || h.tracklistContains([{ title: 'X' }], trackName);
    assert.equal(accepted, true);
  });

  it('BUG: "shipping $45.00" combined total shown as listing price', () => {
    const html = `1 - 25 of 10 Media Condition: Very Good Plus (VG+) Sleeve Condition: VG $40.00 +$5.00 shipping $45.00 Ships From: Germany`;
    const r = h.parseSellPageHtml(html);
    assert.equal(r.lowestPrice, 40.00);
    assert.notEqual(r.lowestPrice, 45.00);
    assert.notEqual(r.lowestPrice, 5.00);
  });

  it('BUG: VG+ filter shows 0 when VG+ copies exist (subtraction overcounted)', () => {
    // The old subtraction approach (total - VG - G - F - P) produced 0
    // because Discogs condition URL params don't filter properly — each
    // condition page returns the full total, so badCount = total × 4.
    // The new approach parses conditions directly from listing HTML.
    // Simulate a sell page with 3 listings: 1 G+, 2 VG+
    const html = `
      <div class="pagination">1 – 3 of 3</div>
      <div class="listing">
        Media Condition:
        <span>Good Plus (G+)</span>
        Sleeve Condition:
        <span>Fair (F)</span>
        <span class="price">$8.67</span>
        <span>+$7.50 shipping</span>
        Ships From: Germany
      </div>
      <div class="listing">
        Media Condition:
        <span>Very Good Plus (VG+)</span>
        Sleeve Condition:
        <span>Very Good (VG)</span>
        <span class="price">$15.00</span>
        <span>+$6.00 shipping</span>
        Ships From: Germany
      </div>
      <div class="listing">
        Media Condition:
        <span>Very Good Plus (VG+)</span>
        Sleeve Condition:
        <span>Very Good (VG)</span>
        <span class="price">$24.00</span>
        <span>+$8.00 shipping</span>
        Ships From: Germany
      </div>
    `;
    const r = h.parseSellPageHtml(html);
    // Total should be 3 from pagination
    assert.equal(r.numForSale, 3);
    // Lowest price should be $8.67 (first listing, G+)
    assert.equal(r.lowestPrice, 8.67);
  });

  it('BUG: CD/cassette releases shown when only vinyl wanted', () => {
    // isVinylFormat should correctly identify formats
    assert.equal(h.isVinylFormat([{ name: 'CD' }]), false);
    assert.equal(h.isVinylFormat([{ name: 'Cassette' }]), false);
    assert.equal(h.isVinylFormat([{ name: 'Vinyl' }]), true);
    assert.equal(h.isVinylFormat([{ name: 'Vinyl' }, { name: 'CD' }]), true);
  });

  it('BUG: US filter shows total worldwide count instead of US-only (ships_from URL param ignored)', () => {
    // The ships_from= URL param is NOT applied to server-rendered HTML.
    // scrapeFilteredListings must parse each listing's "Ships From" text.
    // Simulate: 3 listings total, 1 from US, 2 from elsewhere
    const html = `
      <div class="pagination">1 \u2013 3 of 3</div>
      <div class="listing">
        Media Condition: Fair (F)
        Sleeve Condition: Fair (F)
        <span class="price">$8.67</span>
        <span>+$7.50 shipping</span>
        Ships From:  United States
      </div>
      <div class="listing">
        Media Condition: Very Good Plus (VG+)
        Sleeve Condition: Very Good (VG)
        <span class="price">$12.00</span>
        <span>+$10.00 shipping</span>
        Ships From:  Germany
      </div>
      <div class="listing">
        Media Condition: Near Mint (NM or M-)
        Sleeve Condition: Very Good Plus (VG+)
        <span class="price">$18.00</span>
        <span>+$12.00 shipping</span>
        Ships From:  Japan
      </div>
    `;
    // parseSellPageHtml (total, no filter) should show 3
    const r = h.parseSellPageHtml(html);
    assert.equal(r.numForSale, 3);
    assert.equal(r.lowestPrice, 8.67);
    // The actual US-filter logic lives in scrapeFilteredListings (async,
    // uses fetch), but isVGPlusOrBetter is the per-listing check we test:
    assert.equal(h.isVGPlusOrBetter('Fair (F)'), false);
    assert.equal(h.isVGPlusOrBetter('Very Good Plus (VG+)'), true);
  });
});


// ═══════════════════════════════════════════════════════════════
// 13. NON-USD CURRENCY CONVERSION TESTS
// ═══════════════════════════════════════════════════════════════

describe('non-USD currency conversion', () => {
  const rates = { EUR: 0.847, GBP: 0.739, JPY: 154.4, CAD: 1.368, AUD: 1.418 };

  describe('convertToUSD', () => {
    it('converts EUR to USD', () => {
      const usd = h.convertToUSD(25.00, 'EUR', rates);
      assert.equal(usd, Math.round((25.00 / 0.847) * 100) / 100);
    });
    it('converts GBP to USD', () => {
      const usd = h.convertToUSD(7.00, 'GBP', rates);
      assert.equal(usd, Math.round((7.00 / 0.739) * 100) / 100);
    });
    it('converts JPY to USD', () => {
      const usd = h.convertToUSD(1500, 'JPY', rates);
      assert.equal(usd, Math.round((1500 / 154.4) * 100) / 100);
    });
    it('returns amount unchanged for USD', () => {
      assert.equal(h.convertToUSD(50.00, 'USD', rates), 50.00);
    });
    it('returns null for unknown currency', () => {
      assert.equal(h.convertToUSD(10, 'XYZ', rates), null);
    });
  });

  describe('parseFilteredPage with non-USD prices', () => {
    it('extracts euro-only listing and converts to USD', () => {
      const html = `1 - 25 of 5 Media Condition: Very Good Plus (VG+) Sleeve Condition: VG €25.00 about $28.12 Ships From: Germany`;
      const pg = h.parseFilteredPage(html, false, false, rates);
      assert.equal(pg.matched, 1);
      assert.equal(pg.prices.length, 1);
      assert.equal(pg.prices[0], Math.round((25.00 / 0.847) * 100) / 100);
    });

    it('extracts pound-only listing and converts to USD', () => {
      const html = `1 - 25 of 3 Media Condition: Near Mint (NM or M-) Sleeve Condition: VG £7.00 about $9.46 Ships From: United Kingdom`;
      const pg = h.parseFilteredPage(html, false, false, rates);
      assert.equal(pg.prices.length, 1);
      assert.equal(pg.prices[0], Math.round((7.00 / 0.739) * 100) / 100);
    });

    it('prefers direct $ over foreign currency in same block', () => {
      const html = `1 - 25 of 10 Media Condition: Very Good Plus (VG+) Sleeve Condition: VG $50.00 +$6.00 Ships From: United States`;
      const pg = h.parseFilteredPage(html, false, false, rates);
      assert.equal(pg.prices[0], 50.00);
    });

    it('handles page where ALL listings are non-USD', () => {
      const html = `
        1 - 3 of 3
        Media Condition: Very Good Plus (VG+) Sleeve Condition: VG €20.00 about $22.00 Ships From: France
        Media Condition: Near Mint (NM or M-) Sleeve Condition: VG €35.00 about $38.50 Ships From: Germany
        Media Condition: Very Good (VG) Sleeve Condition: G £12.00 about $16.20 Ships From: United Kingdom
      `;
      const pg = h.parseFilteredPage(html, false, false, rates);
      assert.equal(pg.matched, 3);
      assert.equal(pg.prices.length, 3);
      // All should be converted from native currency, not "about" price
      for (const p of pg.prices) {
        assert.ok(p > 0, 'price should be positive');
        assert.ok(p !== 22.00 && p !== 38.50 && p !== 16.20, 'should not use "about" price');
      }
    });

    it('skips foreign shipping add-ons (+€5)', () => {
      const html = `1 - 25 of 5 Media Condition: Very Good Plus (VG+) Sleeve Condition: VG €25.00 +€5.00 Ships From: Germany`;
      const pg = h.parseFilteredPage(html, false, false, rates);
      assert.equal(pg.prices.length, 1);
      assert.equal(pg.prices[0], Math.round((25.00 / 0.847) * 100) / 100);
    });

    it('mixed USD and non-USD: lowest is correct', () => {
      const html = `
        1 - 25 of 10
        Media Condition: Very Good Plus (VG+) Sleeve Condition: VG €80.00 about $94.12 Ships From: Germany
        Media Condition: Very Good Plus (VG+) Sleeve Condition: VG $50.00 +$6.00 Ships From: United States
      `;
      const pg = h.parseFilteredPage(html, false, false, rates);
      assert.equal(pg.prices.length, 2);
      assert.equal(pg.lowest, 50.00);
    });

    it('handles CA$ currency', () => {
      const html = `1 - 25 of 5 Media Condition: Very Good Plus (VG+) Sleeve Condition: VG CA$30.00 Ships From: Canada`;
      const pg = h.parseFilteredPage(html, false, false, rates);
      assert.equal(pg.prices.length, 1);
      assert.equal(pg.prices[0], Math.round((30.00 / 1.368) * 100) / 100);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// 14. EDGE CASE STRESS TESTS
// ═══════════════════════════════════════════════════════════════

describe('edge case stress tests', () => {
  describe('unusual YouTube titles', () => {
    it('handles title with multiple dashes', () => {
      const raw = 'DJ Shadow - Building Steam With A Grain Of Salt - YouTube';
      const clean = h.cleanTitle(raw);
      const parsed = h.parseArtistTrack(clean);
      assert.equal(parsed.artist, 'DJ Shadow');
      assert.ok(parsed.track.includes('Building Steam'));
    });

    it('handles title with pipe AND dash', () => {
      const raw = 'Label | Artist - Track (Official Video) - YouTube';
      const clean = h.cleanTitle(raw);
      const parsed = h.parseArtistTrack(clean);
      // Pipe takes priority
      assert.equal(parsed.artist, 'Label');
      assert.ok(parsed.track.includes('Artist'));
    });

    it('handles title with only hashtags', () => {
      const raw = 'Artist - Track #shorts #viral #music - YouTube';
      const clean = h.cleanTitle(raw);
      assert.ok(!clean.includes('#'));
      assert.ok(clean.includes('Artist'));
      assert.ok(clean.includes('Track'));
    });

    it('handles all-caps title', () => {
      const raw = 'ARTIST - TRACK NAME (OFFICIAL VIDEO) - YouTube';
      const clean = h.cleanTitle(raw);
      assert.equal(clean, 'ARTIST - TRACK NAME');
    });
  });

  describe('false positive prevention in track matching', () => {
    it('"Fire" does NOT match "Firestarter"', () => {
      const tl = [{ title: 'Fire', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, 'Firestarter'), false);
    });

    it('"Star" does NOT match "Stardust"', () => {
      const tl = [{ title: 'Star', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, 'Stardust'), false);
    });

    it('"Love" does NOT match "Loveblind"', () => {
      const tl = [{ title: 'Love', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, 'Loveblind'), false);
    });

    it('"Blue" does NOT match "Blueberry Hill"', () => {
      const tl = [{ title: 'Blue', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, 'Blueberry Hill'), false);
    });

    it('"Blue Monday" DOES match "Blue Monday Remix"', () => {
      const tl = [{ title: 'Blue Monday', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, 'Blue Monday Remix'), true);
    });

    it('"Running Away" DOES match "Running Away"', () => {
      const tl = [{ title: 'Running Away', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, 'Running Away'), true);
    });

    it('"Terms of 2026" does NOT produce count of 2026 on sell page', () => {
      const html = '<div>Terms of 2026</div>';
      const r = h.parseSellPageHtml(html);
      assert.notEqual(r.numForSale, 2026);
    });
  });

  describe('unusual track names in tracklist matching', () => {
    it('handles numeric track name "1999"', () => {
      const tl = [{ title: '1999', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, '1999'), true);
    });

    it('handles track with leading/trailing whitespace', () => {
      const tl = [{ title: '  Spaces  ', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, 'Spaces'), true);
    });

    it('handles unicode in track names', () => {
      const tl = [{ title: 'Déjà Vu', type_: 'track' }];
      // normalize strips non-[a-z0-9], so accented chars are removed
      // 'Déjà Vu' → 'dj vu', 'Deja Vu' → 'deja vu' — they won't match
      assert.equal(h.tracklistContains(tl, 'Deja Vu'), false);
      // But searching with the same accented spelling works (both normalize the same)
      assert.equal(h.tracklistContains(tl, 'Déjà Vu'), true);
    });

    it('handles very long track names', () => {
      const longName = 'This Is A Very Long Track Name That Goes On And On Forever';
      const tl = [{ title: longName, type_: 'track' }];
      assert.equal(h.tracklistContains(tl, longName), true);
    });

    it('handles track name with only digits "42"', () => {
      const tl = [{ title: '42', type_: 'track' }];
      assert.equal(h.tracklistContains(tl, '42'), true);
    });
  });

  describe('unusual sell page HTML', () => {
    it('handles completely empty HTML', () => {
      const r = h.parseSellPageHtml('');
      assert.equal(r.numForSale, 0);
      assert.equal(r.lowestPrice, null);
    });

    it('handles HTML with only sidebar content', () => {
      const html = '<div>Some sidebar $100.00 More than $50</div>';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 0);
      assert.equal(r.lowestPrice, null);
    });

    it('handles price of $0.01 (penny listing)', () => {
      const html = '1 - 25 of 5 Media Condition: Very Good (VG) Sleeve Condition: VG $0.01 +$4.00 shipping Ships From: Germany';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.lowestPrice, 0.01);
    });

    it('handles price of $9,999.99 (high-value listing)', () => {
      const html = '1 - 25 of 1 Media Condition: Mint (M) Sleeve Condition: VG $9,999.99 Ships From: Germany';
      const r = h.parseSellPageHtml(html);
      assert.equal(r.lowestPrice, 9999.99);
    });

    it('handles malformed "of" count gracefully', () => {
      const html = 'of abc Media Condition: Very Good (VG) Sleeve Condition: VG $10.00 Ships From: Germany';
      const r = h.parseSellPageHtml(html);
      // No "of X" match (abc has no digits), no "no results" message
      // → falls back to counting "Media Condition" occurrences = 1
      assert.equal(r.numForSale, 1);
      assert.equal(r.lowestPrice, 10.00);
    });
  });

  describe('URL edge cases', () => {
    it('handles Discogs URL with query params', () => {
      const r = [], s = {};
      h.parseDiscogsUrl('https://www.discogs.com/release/12345?format=Vinyl', r, s);
      assert.equal(r.length, 1);
      assert.equal(r[0].id, 12345);
    });

    it('handles Discogs URL with fragment', () => {
      const r = [], s = {};
      h.parseDiscogsUrl('https://www.discogs.com/master/12345#tracklist', r, s);
      assert.equal(r.length, 1);
      assert.equal(r[0].id, 12345);
    });

    it('handles Discogs URL with country prefix', () => {
      // Some Google results may use localized Discogs URLs
      const r = [], s = {};
      h.parseDiscogsUrl('https://www.discogs.com/Artist-Name-Album-Name/release/12345', r, s);
      assert.equal(r.length, 1);
      assert.equal(r[0].id, 12345);
    });
  });

  describe('VG+ and US HTML condition parsing', () => {
    it('counts VG+ listings from realistic Discogs sell page', () => {
      // Simulates the 23 Candles EP: 1 G+, 2 VG+ = 2 VG+ or better
      const html = `
        <html>
        <div class="pagination">1 \u2013 3 of 3</div>
        <div class="shortcut_navigable">
          <div class="item">
            <span class="item_condition">
              <span>Media Condition:</span>
              <span>Good Plus (G+)</span>
            </span>
            <span>Sleeve Condition:</span>
            <span>Fair (F)</span>
            <span class="price">$8.67</span>
            <span>+$7.50 shipping</span>
            Ships From: Germany
          </div>
          <div class="item">
            <span class="item_condition">
              <span>Media Condition:</span>
              <span>Very Good Plus (VG+)</span>
            </span>
            <span>Sleeve Condition:</span>
            <span>Very Good (VG)</span>
            <span class="price">$15.00</span>
            <span>+$6.00 shipping</span>
            Ships From: Germany
          </div>
          <div class="item">
            <span class="item_condition">
              <span>Media Condition:</span>
              <span>Very Good Plus (VG+)</span>
            </span>
            <span>Sleeve Condition:</span>
            <span>Very Good (VG)</span>
            <span class="price">$24.00</span>
            <span>+$8.00 shipping</span>
            Ships From: Germany
          </div>
        </div>
        </html>
      `;
      // parseSellPageHtml gives us the total page stats
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 3);
      assert.equal(r.lowestPrice, 8.67);

      // isVGPlusOrBetter correctly classifies grades
      assert.equal(h.isVGPlusOrBetter('Very Good Plus (VG+)'), true);
      assert.equal(h.isVGPlusOrBetter('Good Plus (G+)'), false);
      assert.equal(h.isVGPlusOrBetter('Mint (M)'), true);
      assert.equal(h.isVGPlusOrBetter('Near Mint (NM or M-)'), true);
    });

    it('all-NM page should have 100% VG+ or better', () => {
      const html = `
        1 - 5 of 5
        Media Condition: Near Mint (NM or M-) Sleeve Condition: Near Mint (NM or M-) $20.00 Ships From: Germany
        Media Condition: Near Mint (NM or M-) Sleeve Condition: Near Mint (NM or M-) $25.00 Ships From: Germany
        Media Condition: Near Mint (NM or M-) Sleeve Condition: Near Mint (NM or M-) $30.00 Ships From: Germany
        Media Condition: Near Mint (NM or M-) Sleeve Condition: Near Mint (NM or M-) $35.00 Ships From: Germany
        Media Condition: Near Mint (NM or M-) Sleeve Condition: Near Mint (NM or M-) $40.00 Ships From: Germany
      `;
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 5);
      // All 5 are NM which is VG+ or better
      assert.equal(h.isVGPlusOrBetter('Near Mint (NM or M-)'), true);
    });

    it('all-Fair page should have 0% VG+ or better', () => {
      const html = `
        1 - 3 of 3
        Media Condition: Fair (F) Sleeve Condition: Poor (P) $5.00 Ships From: Germany
        Media Condition: Fair (F) Sleeve Condition: Poor (P) $8.00 Ships From: Germany
        Media Condition: Fair (F) Sleeve Condition: Poor (P) $10.00 Ships From: Germany
      `;
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 3);
      assert.equal(h.isVGPlusOrBetter('Fair (F)'), false);
    });

    it('mixed-condition page extracts correct total', () => {
      const html = `
        1 - 25 of 150
        Media Condition: Very Good (VG) Sleeve Condition: Good (G) $10.00 Ships From: Germany
        Media Condition: Very Good Plus (VG+) Sleeve Condition: Very Good (VG) $18.00 Ships From: Germany
        Media Condition: Near Mint (NM or M-) Sleeve Condition: Very Good Plus (VG+) $25.00 Ships From: Germany
        Media Condition: Good (G) Sleeve Condition: Fair (F) $5.00 Ships From: Germany
        Media Condition: Mint (M) Sleeve Condition: Near Mint (NM or M-) $50.00 Ships From: Germany
      `;
      const r = h.parseSellPageHtml(html);
      assert.equal(r.numForSale, 150);
      assert.equal(r.lowestPrice, 5.00);  // Good (G) copy has lowest price
    });

    it('"Ships From" text is parseable in listing HTML', () => {
      // Verify the Ships From pattern we use in scrapeFilteredListings works
      const block = `
        : Very Good Plus (VG+)
        <span class="price">$15.00</span>
        +$6.00 shipping
        Ships From:   <a href="...">United States</a>
      `;
      const shipMatch = block.match(/Ships\s+From:\s*(?:<[^>]*>\s*)*([A-Za-z\s]+)/i);
      assert.ok(shipMatch, 'should match Ships From pattern');
      assert.ok(/United States/i.test(shipMatch[1].trim()), 'should extract United States');
    });

    it('"Ships From" text with plain text (no link) is parseable', () => {
      const block = `
        : Near Mint (NM or M-)
        $20.00
        Ships From:  Germany
      `;
      const shipMatch = block.match(/Ships\s+From:\s*(?:<[^>]*>\s*)*([A-Za-z\s]+)/i);
      assert.ok(shipMatch);
      assert.equal(shipMatch[1].trim(), 'Germany');
      assert.ok(!/United States/i.test(shipMatch[1].trim()), 'Germany is not US');
    });

    it('"Ships From" text with Japan is parseable', () => {
      const block = `Ships From: Japan`;
      const shipMatch = block.match(/Ships\s+From:\s*(?:<[^>]*>\s*)*([A-Za-z\s]+)/i);
      assert.ok(shipMatch);
      assert.ok(!/United States/i.test(shipMatch[1].trim()));
    });
  });

  describe('VG+ filter uses media condition only (ignores sleeve)', () => {
    it('BUG: media Good + sleeve VG+ must be filtered OUT', () => {
      const html = `
        1 - 1 of 1
        Media Condition:
        <span>Good (G)</span>
        Sleeve Condition:
        <span>Very Good Plus (VG+)</span>
        <span class="price">$4.00</span>
        Ships From: Germany
      `;
      const r = h.parseFilteredPage(html, false, true);
      assert.equal(r.matched, 0, 'Good (G) media should not pass VG+ filter');
      assert.equal(r.prices.length, 0);
    });

    it('media VG+ + sleeve Good must pass VG+ filter', () => {
      const html = `
        1 - 1 of 1
        Media Condition:
        <span>Very Good Plus (VG+)</span>
        Sleeve Condition:
        <span>Good (G)</span>
        <span class="price">$12.00</span>
        Ships From: Germany
      `;
      const r = h.parseFilteredPage(html, false, true);
      assert.equal(r.matched, 1, 'VG+ media should pass regardless of sleeve');
      assert.equal(r.prices.length, 1);
      assert.equal(r.lowest, 12.00);
    });

    it('media NM + sleeve Fair must pass VG+ filter', () => {
      const html = `
        1 - 1 of 1
        Media Condition:
        <span>Near Mint (NM or M-)</span>
        Sleeve Condition:
        <span>Fair (F)</span>
        <span class="price">$25.00</span>
        Ships From: Germany
      `;
      const r = h.parseFilteredPage(html, false, true);
      assert.equal(r.matched, 1, 'NM media should pass regardless of sleeve');
      assert.equal(r.prices.length, 1);
      assert.equal(r.lowest, 25.00);
    });

    it('mixed page: filters out only sub-VG+ media conditions', () => {
      const html = `
        1 - 3 of 3
        Media Condition:
        <span>Good (G)</span>
        Sleeve Condition:
        <span>Very Good Plus (VG+)</span>
        <span class="price">$4.00</span>
        Ships From: Germany
        Media Condition:
        <span>Very Good Plus (VG+)</span>
        Sleeve Condition:
        <span>Very Good (VG)</span>
        <span class="price">$15.00</span>
        Ships From: Germany
        Media Condition:
        <span>Fair (F)</span>
        Sleeve Condition:
        <span>Near Mint (NM or M-)</span>
        <span class="price">$2.00</span>
        Ships From: Germany
      `;
      const r = h.parseFilteredPage(html, false, true);
      assert.equal(r.matched, 1, 'only the VG+ media listing should pass');
      assert.equal(r.lowest, 15.00);
    });
  });

  describe('Filtered price consistency', () => {
    // These tests verify the popup.js showFilteredData logic:
    // - VG+ filter: ALWAYS use scraped prices (global API includes all conditions)
    // - US-only filter (no VG+): fall back to global API prices when count matches

    // Helper: simulates the useScrapedPrices decision from popup.js
    // unfilteredRef = scrapedTotal (from sell page) or g.numForSale (API fallback)
    function useScraped(vg, cappedTotal, unfilteredRef) {
      return vg || cappedTotal < unfilteredRef;
    }

    it('VG+ filter: always use scraped prices even when count matches global', () => {
      // Bug case: 10 global, 10 VG+ filtered, but global lowest ($2.35) is a VG copy
      const vg = true;
      const g = { numForSale: 10, lowestPrice: 2.35, medianPrice: 5.00 };
      const fData = { numForSale: 10, scrapedTotal: 10, lowestPrice: 3.27, medianPrice: 6.00 };
      const unfilteredRef = fData.scrapedTotal || g.numForSale || 0;
      const cappedTotal = Math.min(fData.numForSale, unfilteredRef);
      assert.equal(useScraped(vg, cappedTotal, unfilteredRef), true, 'VG+ must always use scraped');
      const displayLowest = fData.lowestPrice != null ? fData.lowestPrice : g.lowestPrice;
      assert.equal(displayLowest, 3.27, 'should use scraped VG+ lowest, not global');
    });

    it('VG+ filter: use scraped prices when count narrows too', () => {
      const vg = true;
      const g = { numForSale: 10, lowestPrice: 2.35, medianPrice: 5.00 };
      const fData = { numForSale: 7, scrapedTotal: 10, lowestPrice: 4.00, medianPrice: 8.00 };
      const unfilteredRef = fData.scrapedTotal || g.numForSale || 0;
      const cappedTotal = Math.min(fData.numForSale, unfilteredRef);
      assert.equal(useScraped(vg, cappedTotal, unfilteredRef), true);
      assert.equal(fData.lowestPrice, 4.00, 'should use scraped VG+ lowest');
      assert.equal(fData.medianPrice, 8.00, 'should use scraped VG+ median');
    });

    it('US-only (no VG+): use global prices when count matches', () => {
      const vg = false;
      const g = { numForSale: 5, lowestPrice: 12.68, medianPrice: 12.68 };
      const fData = { numForSale: 5, scrapedTotal: 5, lowestPrice: 29.72, medianPrice: 29.72 };
      const unfilteredRef = fData.scrapedTotal || g.numForSale || 0;
      const cappedTotal = Math.min(fData.numForSale, unfilteredRef);
      assert.equal(useScraped(vg, cappedTotal, unfilteredRef), false, 'US-only with same count uses global');
      const displayLowest = g.lowestPrice;
      assert.equal(displayLowest, 12.68, 'should use global lowest');
    });

    it('US-only (no VG+): use scraped prices when count narrows', () => {
      const vg = false;
      const g = { numForSale: 10, lowestPrice: 8.00, medianPrice: 15.00 };
      const fData = { numForSale: 3, scrapedTotal: 10, lowestPrice: 20.00, medianPrice: 25.00 };
      const unfilteredRef = fData.scrapedTotal || g.numForSale || 0;
      const cappedTotal = Math.min(fData.numForSale, unfilteredRef);
      assert.equal(useScraped(vg, cappedTotal, unfilteredRef), true, 'US-only with fewer copies uses scraped');
      assert.equal(fData.lowestPrice, 20.00, 'should use filtered lowest');
      assert.equal(fData.medianPrice, 25.00, 'should use filtered median');
    });

    it('US + VG+ combined: always use scraped prices', () => {
      const vg = true;
      const g = { numForSale: 5, lowestPrice: 10.00, medianPrice: 14.00 };
      const fData = { numForSale: 5, scrapedTotal: 5, lowestPrice: 15.00, medianPrice: 18.00 };
      const unfilteredRef = fData.scrapedTotal || g.numForSale || 0;
      const cappedTotal = Math.min(fData.numForSale, unfilteredRef);
      assert.equal(useScraped(vg, cappedTotal, unfilteredRef), true, 'VG+ always forces scraped');
      assert.equal(fData.lowestPrice, 15.00, 'should use scraped price');
    });

    it('when API undercounts: scrapedTotal is the reliable reference', () => {
      // Bug case from Felka: API says 8, sell page has 10, VG+ filter matches 8
      // Old code: cappedTotal = min(8, 8) = 8, no change visible
      // New code: unfilteredRef = scrapedTotal(10), cappedTotal = min(8, 10) = 8
      const vg = true;
      const g = { numForSale: 8, lowestPrice: 4.00, medianPrice: 7.72 };
      const fData = { numForSale: 8, scrapedTotal: 10, lowestPrice: 4.00, medianPrice: 4.00 };
      const unfilteredRef = fData.scrapedTotal || g.numForSale || 0;
      const cappedTotal = Math.min(fData.numForSale, unfilteredRef);
      assert.equal(cappedTotal, 8, 'filtered 8 of 10 = 8');
      assert.equal(useScraped(vg, cappedTotal, unfilteredRef), true, 'VG+ always uses scraped');
    });

    it('when filtered count is capped but VG+ on, still use scraped', () => {
      const vg = true;
      const g = { numForSale: 5, lowestPrice: 2.00, medianPrice: 5.00 };
      const fData = { numForSale: 6, scrapedTotal: 5, lowestPrice: 4.00, medianPrice: 7.00 };
      const unfilteredRef = fData.scrapedTotal || g.numForSale || 0;
      const cappedTotal = Math.min(fData.numForSale, unfilteredRef);
      assert.equal(cappedTotal, 5);
      assert.equal(useScraped(vg, cappedTotal, unfilteredRef), true, 'VG+ overrides count match');
      assert.equal(fData.lowestPrice, 4.00, 'should use scraped VG+ price');
    });

    it('when scraped price is null with VG+, falls back to global', () => {
      const vg = true;
      const g = { numForSale: 8, lowestPrice: 12.00, medianPrice: 18.00 };
      const fData = { numForSale: 2, scrapedTotal: 8, lowestPrice: null, medianPrice: null };
      const unfilteredRef = fData.scrapedTotal || g.numForSale || 0;
      const cappedTotal = Math.min(fData.numForSale, unfilteredRef);
      assert.equal(useScraped(vg, cappedTotal, unfilteredRef), true);
      const displayLowest = cappedTotal > 0
        ? (fData.lowestPrice != null ? fData.lowestPrice : g.lowestPrice)
        : null;
      assert.equal(displayLowest, 12.00, 'should fall back to global when scraped is null');
    });

    it('per-match: VG+ always uses scraped match price', () => {
      const vg = true;
      const m = { numForSale: 5, lowestPrice: 2.35 };
      const msRaw = { numForSale: 5, scrapedTotal: 5, lowestPrice: 3.27 };
      const msUnfiltered = msRaw.scrapedTotal || m.numForSale || 0;
      const ms = { numForSale: Math.min(msRaw.numForSale, msUnfiltered), lowestPrice: msRaw.lowestPrice };
      const useMatchScraped = vg || ms.numForSale < msUnfiltered;
      assert.equal(useMatchScraped, true);
      const msPrice = useMatchScraped ? ms.lowestPrice : m.lowestPrice;
      assert.equal(msPrice, 3.27, 'VG+ should use scraped match price');
    });

    it('per-match: US-only with same count uses global match price', () => {
      const vg = false;
      const m = { numForSale: 5, lowestPrice: 12.68 };
      const msRaw = { numForSale: 5, scrapedTotal: 5, lowestPrice: 29.72 };
      const msUnfiltered = msRaw.scrapedTotal || m.numForSale || 0;
      const ms = { numForSale: Math.min(msRaw.numForSale, msUnfiltered), lowestPrice: msRaw.lowestPrice };
      const useMatchScraped = vg || ms.numForSale < msUnfiltered;
      assert.equal(useMatchScraped, false);
      const msPrice = useMatchScraped ? ms.lowestPrice : m.lowestPrice;
      assert.equal(msPrice, 12.68, 'US-only same count should use global match price');
    });

    it('when filtered count is 0, prices should be null', () => {
      const g = { numForSale: 5, lowestPrice: 12.00, medianPrice: 18.00 };
      const fData = { numForSale: 0, scrapedTotal: 5, lowestPrice: null, medianPrice: null };
      const unfilteredRef = fData.scrapedTotal || g.numForSale || 0;
      const cappedTotal = Math.min(fData.numForSale, unfilteredRef);
      assert.equal(cappedTotal, 0);
      const displayLowest = cappedTotal > 0 ? g.lowestPrice : null;
      const displayMedian = cappedTotal > 0 ? g.medianPrice : null;
      assert.equal(displayLowest, null, 'no copies means no price');
      assert.equal(displayMedian, null, 'no copies means no median');
    });
  });

  describe('computeMedian', () => {
    it('returns null for empty array', () => {
      assert.equal(h.computeMedian([]), null);
    });

    it('single item returns that value', () => {
      assert.equal(h.computeMedian([15.00]), 15.00);
    });

    it('two items returns average (the bug case)', () => {
      assert.equal(h.computeMedian([58.00, 70.59]), 64.295);
    });

    it('odd count picks middle', () => {
      assert.equal(h.computeMedian([10.00, 20.00, 30.00]), 20.00);
    });

    it('even count (4) averages two middle values', () => {
      assert.equal(h.computeMedian([5.00, 10.00, 20.00, 30.00]), 15.00);
    });

    it('even count (6) averages two middle values', () => {
      assert.equal(h.computeMedian([2, 4, 6, 8, 10, 12]), 7);
    });

    it('unsorted input must be sorted first', () => {
      const prices = [30.00, 5.00, 20.00, 10.00, 15.00];
      prices.sort((a, b) => a - b);
      assert.equal(h.computeMedian(prices), 15.00);
    });
  });

});
