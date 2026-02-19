/* background.js — Discogs Preview service worker
 *
 * Discovery: Google search "youtube title + discogs" → grab Discogs URLs
 * Pricing:   Discogs API for master/release data + marketplace stats
 *
 * This mirrors how a human navigates from YouTube → Discogs:
 * Google the track name, click the first Discogs result.
 */

var DISCOGS_BASE = "https://api.discogs.com";
var UA = "DiscogsPreview/1.0 +https://github.com/discogs-preview";

/* ── Rate limiting (Discogs: 60 req/min) ─────────────────────── */

var discogsTimestamps = [];

function rateOk(stamps, limit, windowMs) {
  var now = Date.now();
  while (stamps.length > 0 && now - stamps[0] > windowMs) stamps.shift();
  return stamps.length < limit;
}

async function waitForDiscogsRate() {
  while (!rateOk(discogsTimestamps, 55, 60000)) {
    var wait = 60000 - (Date.now() - discogsTimestamps[0]) + 200;
    console.log("[DP] Discogs rate limit — waiting", wait, "ms");
    await new Promise(function(r) { setTimeout(r, wait); });
  }
}

/* ── Helpers ──────────────────────────────────────────────────── */

function getToken() {
  return chrome.storage.sync.get("discogsToken").then(function(d) {
    return d.discogsToken || "";
  });
}

var GRADE_ABBR = {
  "Mint (M)": "M",
  "Near Mint (NM or M-)": "NM-",
  "Very Good Plus (VG+)": "VG+",
  "Very Good (VG)": "VG",
  "Good Plus (G+)": "G+",
  "Good (G)": "G",
  "Fair (F)": "F",
  "Poor (P)": "P"
};

/* ── String helpers ───────────────────────────────────────────── */

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function fuzzyNorm(s) {
  return normalize(s)
    .replace(/\bnite\b/g, "night")
    .replace(/\bmidnight\b/g, "midnigh")
    .replace(/\bmidnite\b/g, "midnigh")
    .replace(/\bmid night\b/g, "midnigh")
    .replace(/\btha\b/g, "the")
    .replace(/\s+/g, " ").trim();
}

function parseArtistTrack(query) {
  var seps = [" | ", " - ", " \u2013 ", " \u2014 ", ": "];
  for (var i = 0; i < seps.length; i++) {
    var idx = query.indexOf(seps[i]);
    if (idx > 0) {
      return {
        artist: query.substring(0, idx).trim(),
        track: query.substring(idx + seps[i].length).trim()
      };
    }
  }
  return { artist: "", track: query };
}

function wordsContain(haystack, needle) {
  // Check if all words in needle appear in haystack
  var hw = haystack.split(" ");
  var nw = needle.split(" ");
  for (var w = 0; w < nw.length; w++) {
    if (hw.indexOf(nw[w]) < 0) return false;
  }
  return true;
}

function computeMedian(sortedArr) {
  var n = sortedArr.length;
  if (n === 0) return null;
  if (n % 2 === 1) return sortedArr[Math.floor(n / 2)];
  return (sortedArr[n / 2 - 1] + sortedArr[n / 2]) / 2;
}

function tracklistContains(tracklist, trackName) {
  if (!tracklist || !tracklist.length || !trackName) return false;
  var needle = normalize(trackName);
  var needleFuzzy = fuzzyNorm(trackName);
  if (!needle || needle.length < 2) return false;
  var isShort = needle.length <= 3; // short names: require exact match to avoid false positives

  for (var i = 0; i < tracklist.length; i++) {
    var t = tracklist[i];
    if (t.type_ && t.type_ !== "track") continue;
    var title = normalize(t.title);
    if (!title) continue;
    if (isShort) {
      // For very short names (2-3 chars like "Ok"), require exact match
      if (title === needle) return true;
    } else {
      // Word-overlap: all words of the shorter string must appear in the longer.
      // This lets "Blue Monday" match "Blue Monday Remix" but prevents
      // "Fire" from matching "Firestarter".
      if (wordsContain(title, needle) || wordsContain(needle, title)) return true;
      var titleFuzzy = fuzzyNorm(t.title);
      if (wordsContain(titleFuzzy, needleFuzzy) || wordsContain(needleFuzzy, titleFuzzy)) return true;
    }
  }
  return false;
}

/* ── Discogs API ─────────────────────────────────────────────── */

async function discogsGet(path, params, _retries) {
  var token = await getToken();
  if (!token) throw new Error("NO_TOKEN");

  await waitForDiscogsRate();

  var url = new URL(DISCOGS_BASE + path);
  url.searchParams.set("token", token);
  if (params) {
    var keys = Object.keys(params);
    for (var i = 0; i < keys.length; i++) {
      url.searchParams.set(keys[i], params[keys[i]]);
    }
  }

  console.log("[DP] DISCOGS", url.pathname);

  var res = await fetch(url.toString(), { headers: { "User-Agent": UA } });
  discogsTimestamps.push(Date.now());

  if (res.status === 429) {
    var attempt = (_retries || 0) + 1;
    if (attempt > 3) throw new Error("Discogs rate limit exceeded after 3 retries.");
    var ra = parseInt(res.headers.get("Retry-After") || "5", 10);
    console.log("[DP] 429 retry", attempt, "/3 in", ra, "s");
    await new Promise(function(r) { setTimeout(r, ra * 1000); });
    return discogsGet(path, params, attempt);
  }
  if (res.status === 401) throw new Error("Invalid Discogs token.");
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error("Discogs API error " + res.status);
  return res.json();
}

/* ── Google search → Discogs URLs ────────────────────────────── */

/**
 * Fetch Google search results from within the extension (has browser context),
 * extract Discogs release/master URLs from the results page.
 * Returns array of { type: "master"|"release", id: number, url: string }
 */
async function googleDiscogsSearch(query) {
  var searchQuery = query + " discogs vinyl";
  var url = "https://www.google.com/search?q=" + encodeURIComponent(searchQuery) + "&num=10";

  console.log("[DP] Google search:", searchQuery);

  var res = await fetch(url, {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });

  if (!res.ok) {
    console.log("[DP] Google HTTP", res.status);
    return [];
  }

  var html = await res.text();
  console.log("[DP] Google HTML length:", html.length);

  // Extract Discogs URLs from Google results
  // Google wraps links in /url?q=... redirects or as direct <a href="..."> links
  var results = [];
  var seen = {};

  // Pattern 1: /url?q=https://www.discogs.com/...
  var redirectPattern = /\/url\?q=(https?:\/\/www\.discogs\.com\/[^&"]+)/g;
  var m;
  while ((m = redirectPattern.exec(html)) !== null) {
    var decoded = decodeURIComponent(m[1]);
    parseDiscogsUrl(decoded, results, seen);
  }

  // Pattern 2: direct href="https://www.discogs.com/..."
  var directPattern = /href="(https?:\/\/www\.discogs\.com\/[^"]+)"/g;
  while ((m = directPattern.exec(html)) !== null) {
    parseDiscogsUrl(m[1], results, seen);
  }

  // Pattern 3: URLs in text (sometimes in snippets)
  var textPattern = /https?:\/\/www\.discogs\.com\/(?:release|master)\/(\d+)/g;
  while ((m = textPattern.exec(html)) !== null) {
    var fullUrl = m[0];
    parseDiscogsUrl(fullUrl, results, seen);
  }

  console.log("[DP] Google found", results.length, "Discogs URLs");
  return results;
}

function parseDiscogsUrl(url, results, seen) {
  // Match master or release URLs in various Discogs URL formats
  // Formats: /master/12345, /release/12345, /Artist-Name/master/12345, etc.
  var masterMatch = url.match(/discogs\.com\/(?:[^/]+\/)?master\/(\d+)/);
  var releaseMatch = url.match(/discogs\.com\/(?:[^/]+\/)?release\/(\d+)/);

  if (masterMatch) {
    var mid = parseInt(masterMatch[1], 10);
    var key = "m" + mid;
    if (!seen[key]) {
      seen[key] = true;
      results.push({ type: "master", id: mid, url: url });
    }
  }
  if (releaseMatch) {
    var rid = parseInt(releaseMatch[1], 10);
    var rkey = "r" + rid;
    if (!seen[rkey]) {
      seen[rkey] = true;
      results.push({ type: "release", id: rid, url: url });
    }
  }
}

/* ── Fetch Discogs release/master details ────────────────────── */

function extractArtistNames(discogsArtists) {
  if (!discogsArtists) return "";
  return discogsArtists.map(function(a) {
    return (a.name || "").replace(/\s*\(\d+\)$/, "");
  }).join(", ");
}

function isVinylFormat(formats) {
  if (!formats || !formats.length) return false;
  for (var f = 0; f < formats.length; f++) {
    if (/vinyl/i.test(formats[f].name || "")) return true;
  }
  return false;
}

/* ── Expand master into per-version matches ──────────────────── */

async function expandMasterVersions(master, masterId, seenReleases) {
  var results = [];
  var artists = extractArtistNames(master.artists);

  try {
    var vp = { per_page: "100", sort: "released", sort_order: "desc", format: "Vinyl" };
    var versionsData = await discogsGet("/masters/" + masterId + "/versions", vp);
    var vList = (versionsData && versionsData.versions) ? versionsData.versions : [];
    // Cap to avoid excessive API calls later in gatherPricing
    var vCap = Math.min(vList.length, 10);

    for (var i = 0; i < vCap; i++) {
      var v = vList[i];
      // Only vinyl
      if (!v.major_formats || v.major_formats.indexOf("Vinyl") < 0) continue;
      // Skip duplicates
      if (seenReleases[v.id]) continue;
      seenReleases[v.id] = true;

      // buildResult → gatherPricing scrapes the sell page for each match,
      // so versions with 0 copies will just show "none listed" and get
      // filtered out in buildResult.
      results.push({
        masterId: masterId,
        releaseId: v.id,
        title: v.title || master.title,
        format: v.format || null,
        artists: artists,
        year: v.released || master.year,
        thumb: v.thumb || ((master.images && master.images[0]) ? master.images[0].uri150 : null),
        numForSale: 0,
        lowestPrice: null
      });
    }
  } catch (e) {
    console.error("[DP] expandMasterVersions error:", e);
  }

  // Fallback: if no vinyl versions found at all, create a single master-level match
  if (results.length === 0) {
    results.push({
      masterId: masterId,
      releaseId: null,
      title: master.title,
      format: null,
      artists: artists,
      year: master.year,
      thumb: (master.images && master.images[0]) ? master.images[0].uri150 : null,
      numForSale: master.num_for_sale || 0,
      lowestPrice: master.lowest_price != null ? master.lowest_price : null
    });
  }

  return results;
}

async function fetchDiscogsDetails(googleResults, trackName) {
  var matches = [];
  var seenMasters = {};
  var seenReleases = {};

  // Process up to 5 Google results
  var cap = Math.min(googleResults.length, 5);

  for (var i = 0; i < cap; i++) {
    var gr = googleResults[i];

    if (gr.type === "master") {
      if (seenMasters[gr.id]) continue;
      seenMasters[gr.id] = true;

      var master = await discogsGet("/masters/" + gr.id);
      if (!master) continue;

      // Verify track is on this release (skip if empty — fallback mode)
      var trackOk = !trackName || tracklistContains(master.tracklist, trackName);
      console.log("[DP] master", gr.id, master.title, "→ track:", trackOk);
      if (!trackOk) continue;

      // Expand into per-version matches so each pressing appears separately
      var versionMatches = await expandMasterVersions(master, gr.id, seenReleases);
      for (var vm = 0; vm < versionMatches.length; vm++) matches.push(versionMatches[vm]);

    } else if (gr.type === "release") {
      var rel = await discogsGet("/releases/" + gr.id);
      if (!rel) continue;

      // If it has a master, expand the master into per-version matches
      if (rel.master_id && !seenMasters[rel.master_id]) {
        seenMasters[rel.master_id] = true;
        var mst = await discogsGet("/masters/" + rel.master_id);
        if (mst) {
          var mTrackOk = !trackName || tracklistContains(mst.tracklist, trackName);
          console.log("[DP] release", gr.id, "→ master", rel.master_id, mst.title, "→ track:", mTrackOk);
          if (mTrackOk) {
            var mVersionMatches = await expandMasterVersions(mst, rel.master_id, seenReleases);
            for (var mv = 0; mv < mVersionMatches.length; mv++) matches.push(mVersionMatches[mv]);
            continue;
          }
        }
        // Master didn't match — fall through to check the release itself
      } else if (rel.master_id && seenMasters[rel.master_id]) {
        continue;
      }

      // Skip non-vinyl releases (CD, cassette, digital, etc.)
      if (!isVinylFormat(rel.formats)) {
        console.log("[DP] release", gr.id, rel.title, "→ skipped (not vinyl)");
        continue;
      }

      // Check release tracklist directly (skip if empty — fallback mode)
      var rTrackOk = !trackName || tracklistContains(rel.tracklist, trackName);
      console.log("[DP] release", gr.id, rel.title, "→ track:", rTrackOk);
      if (!rTrackOk) continue;

      matches.push({
        masterId: null,
        releaseId: gr.id,
        title: rel.title,
        artists: extractArtistNames(rel.artists),
        year: rel.year,
        thumb: (rel.images && rel.images[0]) ? rel.images[0].uri150 : null,
        numForSale: rel.num_for_sale || 0,
        lowestPrice: rel.lowest_price != null ? rel.lowest_price : null
      });
    }
  }

  return matches;
}

/* ── Vinyl pricing ───────────────────────────────────────────── */

async function getPriceSuggestions(releaseId) {
  try {
    return (await discogsGet("/marketplace/price_suggestions/" + releaseId)) || null;
  } catch (e) { return null; }
}

async function gatherPricing(match, usOnly) {
  var totalForSale = 0;
  var lowestPrice = null;
  var scrapedPrices = [];
  var priceSuggestions = null;

  // Scrape the sell page for an initial count.  The popup will re-scrape
  // via handleFilteredStats for both filtered AND unfiltered views, so
  // this is just a best-effort first pass.
  var sellUrl;
  if (match.releaseId)
    sellUrl = "https://www.discogs.com/sell/release/" + match.releaseId + "?ev=rb&sort=price%2Casc";
  else if (match.masterId)
    sellUrl = "https://www.discogs.com/sell/list?master_id=" + match.masterId + "&ev=mb&format=Vinyl&sort=price%2Casc";

  if (sellUrl) {
    try {
      var spRes = await fetch(sellUrl, { headers: { "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9" } });
      if (spRes.ok) {
        var spHtml = await spRes.text();
        var pg = parseFilteredPage(spHtml, false, false);
        if (pg.total > 0) totalForSale = pg.total;
        if (pg.prices.length > 0) scrapedPrices = pg.prices;
        if (pg.lowest != null) lowestPrice = pg.lowest;
      }
    } catch (e) { /* scrape failed — counts stay 0 */ }
  }

  // Get price suggestions (VG+, NM estimates) — only API endpoint that
  // isn't available from the sell page HTML.
  var releaseForSuggestions = match.releaseId || null;
  if (releaseForSuggestions && totalForSale > 0)
    priceSuggestions = await getPriceSuggestions(releaseForSuggestions);

  var medianSource = scrapedPrices.length > 0 ? scrapedPrices : [];
  medianSource.sort(function(a, b) { return a - b; });
  var medianPrice = computeMedian(medianSource);

  var lowestGrade = null, vgPlusPrice = null, nearMintPrice = null;

  if (priceSuggestions) {
    var entries = Object.entries(priceSuggestions);
    for (var j = 0; j < entries.length; j++) {
      if (entries[j][0] === "Very Good Plus (VG+)" && entries[j][1] && entries[j][1].value != null)
        vgPlusPrice = entries[j][1].value;
      if (entries[j][0] === "Near Mint (NM or M-)" && entries[j][1] && entries[j][1].value != null)
        nearMintPrice = entries[j][1].value;
    }
    if (lowestPrice != null) {
      var bm = null, bd = Infinity;
      for (var k = 0; k < entries.length; k++) {
        if (entries[k][1] && entries[k][1].value != null) {
          var d = Math.abs(entries[k][1].value - lowestPrice);
          if (d < bd) { bd = d; bm = entries[k][0]; }
        }
      }
      if (bm) lowestGrade = GRADE_ABBR[bm] || bm;
    }
  }

  return {
    totalForSale: totalForSale, lowestPrice: lowestPrice, lowestGrade: lowestGrade,
    medianPrice: medianPrice, vgPlusPrice: vgPlusPrice, nearMintPrice: nearMintPrice,
    scrapedPrices: scrapedPrices
  };
}

/* ── Build result ────────────────────────────────────────────── */

function makeSellUrl(m, query) {
  // Prefer releaseId — links to the specific release sell page which matches
  // the per-release counts we scrape.  Master sell pages aggregate all
  // versions and show inflated totals.
  if (m.releaseId)
    return "https://www.discogs.com/sell/release/" + m.releaseId + "?ev=rb";
  if (m.masterId)
    return "https://www.discogs.com/sell/list?master_id=" + m.masterId + "&ev=mb&format=Vinyl";
  return "https://www.discogs.com/search/?q=" + encodeURIComponent(query) + "&format=Vinyl";
}

async function buildResult(matches, query, usOnly) {
  var totalForSale = 0, globalLowest = Infinity, globalGrade = null;
  var allPrices = [], bestVgPlus = null, bestNearMint = null;
  var matchDetails = [];

  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    var p = await gatherPricing(m, usOnly);
    totalForSale += p.totalForSale;
    if (p.lowestPrice != null) {
      if (p.lowestPrice < globalLowest) { globalLowest = p.lowestPrice; globalGrade = p.lowestGrade; }
    }
    // Use scraped per-listing prices for accurate median; fall back to API lowest+median
    if (p.scrapedPrices && p.scrapedPrices.length > 0) {
      for (var sp = 0; sp < p.scrapedPrices.length; sp++) allPrices.push(p.scrapedPrices[sp]);
    } else {
      if (p.lowestPrice != null) allPrices.push(p.lowestPrice);
      if (p.medianPrice != null) allPrices.push(p.medianPrice);
    }
    if (p.vgPlusPrice != null && (bestVgPlus == null || p.vgPlusPrice < bestVgPlus)) bestVgPlus = p.vgPlusPrice;
    if (p.nearMintPrice != null && (bestNearMint == null || p.nearMintPrice < bestNearMint)) bestNearMint = p.nearMintPrice;

    matchDetails.push({
      masterId: m.masterId, releaseId: m.releaseId,
      title: m.title, format: m.format || null,
      artists: m.artists,
      year: m.year, thumb: m.thumb,
      sellUrl: makeSellUrl(m, query),
      numForSale: p.totalForSale,
      lowestPrice: p.lowestPrice,
      lowestGrade: p.lowestGrade,
      medianPrice: p.medianPrice,
      vgPlusPrice: p.vgPlusPrice
    });
  }

  // Drop versions with nothing for sale (expanded from master but no listings)
  matchDetails = matchDetails.filter(function(d) { return d.numForSale > 0; });

  // Sort: cheapest first, nulls at end
  matchDetails.sort(function(a, b) {
    if (a.lowestPrice == null && b.lowestPrice == null) return 0;
    if (a.lowestPrice == null) return 1;
    if (b.lowestPrice == null) return -1;
    return a.lowestPrice - b.lowestPrice;
  });

  if (globalLowest === Infinity) globalLowest = null;
  allPrices.sort(function(a, b) { return a - b; });
  var medianPrice = computeMedian(allPrices);

  var primary = matchDetails[0] || matches[0];

  return {
    masterId: primary.masterId, releaseId: primary.releaseId,
    title: primary.title, artists: primary.artists,
    year: primary.year, thumb: primary.thumb,
    matchCount: matches.length, numForSale: totalForSale,
    lowestPrice: globalLowest, lowestGrade: globalGrade,
    medianPrice: medianPrice, vgPlusPrice: bestVgPlus, nearMintPrice: bestNearMint,
    sellUrl: primary.sellUrl || makeSellUrl(primary, query), usOnly: usOnly,
    matches: matchDetails
  };
}

/* ── Main search pipeline ────────────────────────────────────── */

async function findMatchingReleases(query) {
  console.log("[DP] searching:", query);

  var parsed = parseArtistTrack(query);
  var trackName = parsed.track || query;
  console.log("[DP] parsed → artist:", JSON.stringify(parsed.artist), "track:", JSON.stringify(trackName));

  // Step 1: Google search for Discogs URLs
  var googleResults = await googleDiscogsSearch(query);

  if (googleResults.length === 0) {
    console.log("[DP] No Discogs URLs found on Google");
    return [];
  }

  // Step 2: Fetch details + verify track is on each release
  var matches = await fetchDiscogsDetails(googleResults, trackName);
  console.log("[DP] Verified matches:", matches.length);

  // If nothing verified, retry without track filter (first Google result is usually right)
  if (matches.length === 0 && googleResults.length > 0) {
    console.log("[DP] No track matches — accepting first Google result as-is");
    matches = await fetchDiscogsDetails(googleResults.slice(0, 1), "");
  }

  return matches;
}

/* ── Handlers ────────────────────────────────────────────────── */

var searchCache = {};
var CACHE_TTL = 10 * 60 * 1000; // 10 minutes
var CACHE_MAX = 50;

function pruneCache() {
  var keys = Object.keys(searchCache);
  // Remove expired entries first
  var now = Date.now();
  for (var i = keys.length - 1; i >= 0; i--) {
    if (now - searchCache[keys[i]].time > CACHE_TTL) {
      delete searchCache[keys[i]];
      keys.splice(i, 1);
    }
  }
  // If still over limit, remove oldest
  while (keys.length >= CACHE_MAX) {
    var oldest = keys[0], oldestTime = searchCache[keys[0]].time;
    for (var j = 1; j < keys.length; j++) {
      if (searchCache[keys[j]].time < oldestTime) {
        oldest = keys[j]; oldestTime = searchCache[keys[j]].time;
      }
    }
    delete searchCache[oldest];
    keys.splice(keys.indexOf(oldest), 1);
  }
}

async function handleFullSearch(query) {
  var cached = searchCache[query];
  if (cached && (Date.now() - cached.time) < CACHE_TTL) {
    console.log("[DP] cache hit for:", query);
    return cached.data;
  }

  var matches = await findMatchingReleases(query);
  if (!matches.length) throw new Error("No Discogs results found for this title.");

  var g = await buildResult(matches, query, false);
  var result = { global: g };

  pruneCache();
  searchCache[query] = { data: result, time: Date.now() };
  return result;
}

/* ── Sell page scraping for filtered stats ────────────────────── */

/* Grades ranked from best to worst */
var GRADE_RANK = {
  "Mint (M)": 1,
  "Near Mint (NM or M-)": 2,
  "Very Good Plus (VG+)": 3,
  "Very Good (VG)": 4,
  "Good Plus (G+)": 5,
  "Good (G)": 6,
  "Fair (F)": 7,
  "Poor (P)": 8
};

function isVGPlusOrBetter(grade) {
  var rank = GRADE_RANK[grade];
  return rank != null && rank <= 3;
}

/**
 * Scrape a Discogs sell page and filter listings by condition and/or
 * shipping country, directly from the HTML.
 *
 * Discogs sell-page URL params like ships_from= and condition= do NOT
 * reliably filter the server-rendered HTML — they're applied client-side
 * by JavaScript.  So we must parse each listing ourselves.
 *
 * Strategy: ONE fetch (sorted price-asc), split at each "Media Condition"
 * marker.  For each listing block, extract:
 *   - condition grade (Mint, NM, VG+, VG, G+, G, F, P)
 *   - "Ships From: Country" text
 * Then count/price only listings matching the requested filters.
 *
 * Limitation: only page 1 (≤25 items) is in the HTML.  If the release has
 * more than 25 listings, we extrapolate the ratio.  The price is still
 * accurate because the page is sorted price-asc: the cheapest matching
 * item is on page 1 (unless ALL page-1 items fail the filter, which is
 * uncommon).
 */
function parseFilteredPage(html, usOnly, vgPlus) {
  /* ── Total count from pagination header ── */
  var total = 0;
  var hasPagination = false;
  var countMatch = html.match(/\d+\s*[\u2013\u2014-]\s*\d+\s+of\s+([\d,]+)/);
  if (countMatch) {
    total = parseInt(countMatch[1].replace(/,/g, ""), 10) || 0;
    hasPagination = true;
  } else {
    var noResults = html.match(/No\s+items\s+for\s+sale|0\s+results|Sorry,\s+no\s+results/i);
    if (!noResults) {
      total = (html.match(/Media[\s-]+Condition\s*:/gi) || []).length;
    }
  }

  /* ── Parse each listing ── */
  var parts = html.split(/Media[\s-]+Condition\s*:/i);
  var listingsOnPage = 0;
  var matched = 0;
  var prices = [];
  var lowest = null;

  for (var li = 1; li < parts.length; li++) {
    var block = parts[li];

    // Skip blocks without a price (safety net for non-listing fragments)
    if (!/\$[\d,.]/.test(block)) continue;

    // Every real listing has a parseable media condition grade right after
    // the "Media Condition:" split point.  Blocks that lack one are phantom
    // fragments (sidebar filters, schema markup, etc.) — skip them.
    var condMatch = block.match(/[\s]*(?:<[^>]*>\s*)*(Mint \(M\)|Near Mint \(NM or M-\)|Very Good Plus \(VG\+\)|Very Good \(VG\)|Good Plus \(G\+\)|Good \(G\)|Fair \(F\)|Poor \(P\))/);
    if (!condMatch) continue;

    // Every real listing shows "Ships From:" (mandatory seller location).
    // Sidebar filter blocks never contain this — they only have grade
    // labels and counts.  This reliably distinguishes real listings from
    // phantom sidebar fragments.
    if (!/Ships\s+From\s*:/i.test(block)) continue;

    listingsOnPage++;

    // ── Check VG+ filter ──
    if (vgPlus) {
      if (!isVGPlusOrBetter(condMatch[1])) continue;
    }

    // ── Check US filter ──
    if (usOnly) {
      var shipMatch = block.match(/Ships\s+From:\s*(?:<[^>]*>\s*)*([A-Za-z\s]+)/i);
      if (!shipMatch) continue;
      var country = shipMatch[1].trim();
      if (!/United States/i.test(country)) continue;
    }

    matched++;

    // Extract the item price from this listing block
    var priceRegex = /(\+)?(?:about\s+)?\$([\d,.]+)/g;
    var pm;
    while ((pm = priceRegex.exec(block)) !== null) {
      if (pm[1] === "+") continue;                    // +$6 shipping
      if (pm[0].indexOf("about") >= 0) continue;       // about $60
      var before = block.substring(Math.max(0, pm.index - 20), pm.index);
      if (/shipping\s*$/i.test(before)) continue;      // shipping $25
      var val = parseFloat(pm[2].replace(/,/g, ""));
      if (!isNaN(val) && val > 0) {
        prices.push(val);
        if (lowest == null || val < lowest) lowest = val;
        break; // first valid price in this listing block
      }
    }
  }

  // When no pagination header was found, use listingsOnPage as the total.
  // When pagination IS available, trust it — it's authoritative.
  // listingsOnPage can be inflated by stray "Media Condition:" fragments
  // elsewhere in the page HTML (hidden sections, schema markup, etc.).
  if (!hasPagination && listingsOnPage > 0) {
    total = listingsOnPage;
  }

  // Cap to pagination total — phantom blocks can inflate listingsOnPage
  // and matched beyond the real listing count.
  if (hasPagination && total > 0) {
    if (listingsOnPage > total) listingsOnPage = total;
    if (matched > total) matched = total;
  }

  console.log("[DP] parseFilteredPage → total:", total, "listingsOnPage:", listingsOnPage, "matched:", matched, "prices:", prices, "vgPlus:", vgPlus, "usOnly:", usOnly);

  return { total: total, listingsOnPage: listingsOnPage, matched: matched, prices: prices, lowest: lowest };
}

var MAX_SCRAPE_PAGES = 2;

async function scrapeFilteredListings(sellUrl, usOnly, vgPlus) {
  try {
    console.log("[DP] filtered scrape:", sellUrl, "usOnly:", usOnly, "vgPlus:", vgPlus);

    var allPrices = [];
    var allMatched = 0;
    var totalListings = 0;
    var totalOnPages = 0;
    var lowestPrice = null;

    for (var page = 1; page <= MAX_SCRAPE_PAGES; page++) {
      var pageUrl = sellUrl;
      if (page > 1) {
        var sep = pageUrl.indexOf("?") >= 0 ? "&" : "?";
        pageUrl += sep + "page=" + page;
      }

      var res = await fetch(pageUrl, {
        headers: { "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9" }
      });
      if (!res.ok) break;
      var html = await res.text();

      var pg = parseFilteredPage(html, usOnly, vgPlus);

      if (page === 1) {
        totalListings = pg.total;
        if (totalListings === 0) return { numForSale: 0, lowestPrice: null, medianPrice: null };
      }

      totalOnPages += pg.listingsOnPage;
      allMatched += pg.matched;
      for (var pi = 0; pi < pg.prices.length; pi++) allPrices.push(pg.prices[pi]);
      if (pg.lowest != null && (lowestPrice == null || pg.lowest < lowestPrice)) lowestPrice = pg.lowest;

      // Stop if this page wasn't full (no more pages) or we've seen all listings
      if (pg.listingsOnPage < 25 || totalOnPages >= totalListings) break;
    }

    /* ── Compute median from all matched prices ── */
    allPrices.sort(function(a, b) { return a - b; });
    var medianPrice = computeMedian(allPrices);

    /* ── Extrapolate for paginated results beyond fetched pages ── */
    var matchedCount = allMatched;
    if (totalListings > totalOnPages && totalOnPages > 0) {
      matchedCount = Math.round((allMatched / totalOnPages) * totalListings);
    }

    console.log("[DP] filtered scrape:", allMatched, "/", totalOnPages, "on", page - 1, "page(s) →", matchedCount, "of", totalListings, "total, lowest:", lowestPrice, "median:", medianPrice);
    return { numForSale: matchedCount, scrapedTotal: totalListings, lowestPrice: lowestPrice, medianPrice: medianPrice };
  } catch (e) {
    console.error("[DP] filtered scrape error:", e);
    return { numForSale: 0, scrapedTotal: 0, lowestPrice: null, medianPrice: null };
  }
}

function buildFilteredUrl(baseUrl, usOnly) {
  var url = baseUrl;
  if (usOnly) {
    var sep = url.indexOf("?") >= 0 ? "&" : "?";
    url += sep + "ships_from=United+States";
  }
  return url;
}

async function handleFilteredStats(matches, usOnly, vgPlus) {
  var totalForSale = 0;
  var scrapedTotal = 0;
  var allLowest = Infinity;
  var allMedians = [];
  var matchStats = [];

  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    var url = m.sellUrl;
    if (!url) continue;

    // Add sort=price,asc so the first matching listing price = lowest
    var sep = url.indexOf("?") >= 0 ? "&" : "?";
    var sortedUrl = url + sep + "sort=price%2Casc";

    // Always parse per-listing HTML — URL params (ships_from, condition)
    // are NOT reliably applied to server-rendered HTML by Discogs
    var stats = await scrapeFilteredListings(sortedUrl, usOnly, vgPlus);

    totalForSale += stats.numForSale;
    scrapedTotal += stats.scrapedTotal;
    if (stats.lowestPrice != null && stats.lowestPrice < allLowest) allLowest = stats.lowestPrice;
    if (stats.medianPrice != null) allMedians.push(stats.medianPrice);
    matchStats.push({ numForSale: stats.numForSale, scrapedTotal: stats.scrapedTotal, lowestPrice: stats.lowestPrice, medianPrice: stats.medianPrice });
  }

  if (allLowest === Infinity) allLowest = null;
  allMedians.sort(function(a, b) { return a - b; });
  var overallMedian = computeMedian(allMedians);

  return {
    numForSale: totalForSale,
    scrapedTotal: scrapedTotal,
    lowestPrice: allLowest,
    medianPrice: overallMedian,
    matchStats: matchStats
  };
}

/* ── Message listener ────────────────────────────────────────── */

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  console.log("[DP] message:", msg.type);

  if (msg.type === "discogs-full-search") {
    handleFullSearch(msg.query)
      .then(function(data) { sendResponse({ data: data }); })
      .catch(function(err) {
        console.error("[DP] error:", err);
        sendResponse({ error: err.message });
      });
    return true;
  }

  if (msg.type === "discogs-filtered-stats") {
    handleFilteredStats(msg.matches, msg.usOnly, msg.vgPlus)
      .then(function(data) { sendResponse({ data: data }); })
      .catch(function(err) { sendResponse({ error: err.message }); });
    return true;
  }

  if (msg.type === "open-options") {
    chrome.runtime.openOptionsPage();
  }
});

console.log("[DP] service worker loaded OK");
