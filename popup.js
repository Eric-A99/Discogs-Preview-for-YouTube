/*  popup.js — Discogs Preview toolbar popup
 *  Detects YouTube tab, fetches Discogs data, renders pricing.
 */

var DEBUG = false;

/* -- elements -- */
const setupEl      = document.getElementById('setup');
const tokenInput   = document.getElementById('token');
const saveBtn      = document.getElementById('save');
const changeToken  = document.getElementById('change-token');
const notYtEl      = document.getElementById('not-yt');
const loadingEl    = document.getElementById('loading');
const errorEl      = document.getElementById('error');
const mainEl       = document.getElementById('main');
const thumbEl      = document.getElementById('thumb');
const rTitle       = document.getElementById('r-title');
const rArtist      = document.getElementById('r-artist');
const rLink        = document.getElementById('r-link');
const globalStats  = document.getElementById('global-stats');
const usToggle     = document.getElementById('us-toggle');
const vgToggle     = document.getElementById('vg-toggle');

let cachedQuery = null;
let cachedData  = null;
let selectedMatchIndex = null;  // null = show aggregate, 0..N = specific release

/* -- utilities -- */
function show(el)  { el.classList.remove('hidden'); }
function hide(el)  { el.classList.add('hidden'); }
function hideAll() { [setupEl, notYtEl, loadingEl, errorEl, mainEl].forEach(hide); }

function fmtPrice(v) {
  return v != null ? '$' + v.toFixed(2) : '—';
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML; 
}

/* -- clean YouTube title -- */
function cleanTitle(raw) {
  return raw
    .replace(/\s*-\s*YouTube\s*$/i, '')
    .replace(/[\(\[][^)\]]*(?:official|music|lyric|audio|video|visuali[sz]er|animated|remaster(?:ed)?|hd|hq|4k|1080p|720p|full\s*album)[\s\S]*?[\)\]]/gi, '')
    .replace(/#\S+/g, '')
    .replace(/\b(official\s*(music\s*)?video|music\s*video|lyric\s*video|audio|visuali[sz]er|full\s*album)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* -- render stats cards -- */
function renderStats(container, data) {
  container.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Copies for Sale</div>
      <div class="stat-value">${data.numForSale || 0}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Median Price</div>
      <div class="stat-value">${fmtPrice(data.medianPrice)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Lowest Price</div>
      <div class="stat-value green">${fmtPrice(data.lowestPrice)}</div>
      <div class="stat-sub">${data.lowestGrade ? 'Est. ' + data.lowestGrade : ''}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Lowest VG+</div>
      <div class="stat-value green">${fmtPrice(data.vgPlusPrice)}</div>
      <div class="stat-sub">or better</div>
    </div>
  `;
}

/* -- display results -- */
function renderMatchList(container, matches) {
  if (!matches || matches.length <= 1) {
    container.innerHTML = '';
    return;
  }
  let html = '<div class="section-divider">Releases containing this track</div>';
  html += '<div class="match-list">';
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const isCheapest = i === 0;
    const isSelected = selectedMatchIndex === i;
    html += `<div class="match-item${isSelected ? ' selected' : ''}" data-match-idx="${i}">`;
    if (m.thumb) {
      html += `<img class="match-thumb" src="${escHtml(m.thumb)}" alt="">`;
    } else {
      html += `<div class="match-thumb match-thumb-empty">🎵</div>`;
    }
    html += `<div class="match-info">`;
    html += `<div class="match-title">${escHtml(m.title)}</div>`;
    html += `<div class="match-artist">${escHtml(m.artists)}${m.year ? ' (' + m.year + ')' : ''}${m.format ? ' · ' + escHtml(m.format) : ''}</div>`;
    html += `</div>`;
    html += `<div class="match-price-col">`;
    if (m.numForSale > 0) {
      html += `<div class="match-price">${fmtPrice(m.lowestPrice)}</div>`;
      html += `<div class="match-copies">${m.numForSale} for sale</div>`;
    } else {
      html += `<div class="match-price dim">—</div>`;
      html += `<div class="match-copies">none listed</div>`;
    }
    html += `</div>`;
    if (isCheapest) {
      html += `<div class="cheapest-badge">Best Price</div>`;
    }
    html += `</div>`;
  }
  html += '</div>';
  container.innerHTML = html;
  bindMatchClicks(container);
}

function bindMatchClicks(container) {
  container.querySelectorAll('.match-item[data-match-idx]').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.matchIdx, 10);
      selectMatch(idx);
    });
  });
}

function selectMatch(idx) {
  if (!cachedData) return;
  const g = cachedData.global;
  const matches = g.matches || [];
  if (idx < 0 || idx >= matches.length) return;

  // Toggle: clicking the already-selected release deselects it
  if (selectedMatchIndex === idx) {
    selectedMatchIndex = null;
  } else {
    selectedMatchIndex = idx;
  }

  updateHeaderForSelection();

  // Re-apply current filters (or unfiltered state)
  // Cache keys include selection index, so no need to clear old caches
  applyFilters();
}

function updateHeaderForSelection() {
  if (!cachedData) return;
  const g = cachedData.global;
  const matches = g.matches || [];
  const us = usToggle.checked;
  const vg = vgToggle.checked;

  if (selectedMatchIndex != null && selectedMatchIndex < matches.length) {
    const m = matches[selectedMatchIndex];
    if (m.thumb) { thumbEl.src = m.thumb; thumbEl.style.display = ''; }
    else         { thumbEl.style.display = 'none'; }
    rTitle.textContent = m.title;
    const fmtStr = m.format ? ' · ' + escHtml(m.format) : '';
    rArtist.innerHTML  = escHtml(m.artists) + ' <span class="release-year">(' + (m.year || '?') + ')</span>' + fmtStr;
    rLink.href         = buildFilteredUrl(m.sellUrl, us, vg, m.releaseId);
    rLink.textContent  = filterLinkText();
  } else {
    // Back to aggregate / primary
    const primary = matches.length > 0 ? matches[0] : g;
    if (primary.thumb) { thumbEl.src = primary.thumb; thumbEl.style.display = ''; }
    else               { thumbEl.style.display = 'none'; }
    rTitle.textContent = primary.title;
    rArtist.innerHTML  = escHtml(primary.artists) + ' <span class="release-year">(' + (primary.year || '?') + ')</span>';
    rLink.href         = buildFilteredUrl(primary.sellUrl || g.sellUrl, us, vg, primary.releaseId || g.releaseId);
    rLink.textContent  = filterLinkText();
  }
}

function buildFilteredUrl(url, usOnly, vgPlus, releaseId) {
  if (!url) return url;
  // When a specific release is selected, link directly to its sell page
  if (releaseId) {
    url = 'https://www.discogs.com/sell/release/' + releaseId + '?ev=rb&sort=price%2Casc';
  }
  let sep = url.includes('?') ? '&' : '?';
  if (usOnly) { url += sep + 'ships_from=United+States'; sep = '&'; }
  // Note: Discogs condition URL params (e.g. condition=Very+Good+Plus+...)
  // are broken server-side — the sidebar shows the filter but returns 0 results.
  // VG+ filtering is handled by our scraping code instead.
  return url;
}

function filterCacheKey() {
  const us = usToggle.checked;
  const vg = vgToggle.checked;
  let base = 'f:' + (us ? '1' : '0') + ':' + (vg ? '1' : '0');
  // Include selection so aggregate vs single-match results don't collide
  return selectedMatchIndex != null ? base + ':m' + selectedMatchIndex : base;
}

function filterLabel() {
  const us = usToggle.checked;
  const vg = vgToggle.checked;
  const tags = [];
  if (us) tags.push('<span class="badge">Ships from US</span>');
  if (vg) tags.push('<span class="badge">VG+ or better</span>');
  return tags.length ? 'All Vinyl — ' + tags.join(' ') : 'All Vinyl — <span class="badge">All Conditions Worldwide</span>';
}

function filterLinkText() {
  const us = usToggle.checked;
  const vg = vgToggle.checked;
  if (us && vg) return 'View all US VG+ or better copies on Discogs ↗';
  if (us)       return 'View all US copies on Discogs ↗';
  if (vg)       return 'View all VG+ or better copies on Discogs ↗';
  return 'View all copies on Discogs ↗';
}

function copiesSuffix() {
  const us = usToggle.checked;
  const vg = vgToggle.checked;
  const parts = [];
  if (us) parts.push('US');
  if (vg) parts.push('VG+');
  return parts.length ? parts.join(' ') : 'for sale';
}

function applyFilters() {
  if (!cachedData) return;
  const us = usToggle.checked;
  const vg = vgToggle.checked;

  const key = filterCacheKey();
  const g = cachedData.global;
  const matches = g.matches || [];
  const divider = document.getElementById('stats-divider');

  // If we already have cached data for this filter combo, show it
  if (cachedData[key]) {
    showFilteredData(cachedData[key], matches);
    return;
  }

  // Show loading state
  divider.innerHTML = filterLabel();
  updateHeaderForSelection();
  globalStats.innerHTML = '<div class="stat-card" style="grid-column:1/-1;text-align:center;color:#9e9e9e;font-size:12px;"><div class="spinner" style="display:inline-block;margin-right:8px;vertical-align:middle;"></div>Loading filtered results…</div>';

  // When a specific release is selected, only scrape that one
  const queryMatches = selectedMatchIndex != null && selectedMatchIndex < matches.length
    ? [matches[selectedMatchIndex]]
    : matches;

  const matchData = queryMatches.map(m => ({ sellUrl: m.sellUrl }));

  chrome.runtime.sendMessage(
    { type: 'discogs-filtered-stats', matches: matchData, usOnly: us, vgPlus: vg },
    (res) => {
      if (chrome.runtime.lastError || res?.error) {
        renderStats(globalStats, { numForSale: 0, lowestPrice: null, medianPrice: null, vgPlusPrice: null });
        return;
      }
      if (res?.data) {
        cachedData[key] = res.data;
        // Only apply if toggles are still in the same state
        if (filterCacheKey() === key) showFilteredData(res.data, matches);
      }
    }
  );
}

function showFilteredData(fData, matches) {
  const divider = document.getElementById('stats-divider');
  const us = usToggle.checked;
  const vg = vgToggle.checked;

  divider.innerHTML = filterLabel();
  updateHeaderForSelection();

  // Use filter-specific prices when available, fall back to API prices
  const g = cachedData.global;

  // When a specific release is selected, fData has one matchStats entry
  // that corresponds to that single release, not the full array.
  const isSingleSelected = selectedMatchIndex != null;

  const fLowest = fData.lowestPrice != null ? fData.lowestPrice : null;
  const fMedian = fData.medianPrice != null ? fData.medianPrice : null;

  // Scraped data is the single source of truth for counts.
  // fData.numForSale = filtered matched count (or all if no filter)
  // fData.scrapedTotal = total listings on the page (unfiltered)
  const displayTotal = fData.numForSale;
  const isFiltered = vg || us;
  const useScrapedPrices = isFiltered || displayTotal > 0;
  const fallbackLowest = isSingleSelected ? matches[selectedMatchIndex]?.lowestPrice : g.lowestPrice;
  const fallbackMedian = isSingleSelected ? matches[selectedMatchIndex]?.medianPrice : g.medianPrice;
  const displayLowest = displayTotal > 0
    ? (fLowest != null ? fLowest : fallbackLowest)
    : null;
  const displayMedian = displayTotal > 0
    ? (fMedian != null ? fMedian : fallbackMedian)
    : null;

  renderStats(globalStats, {
    numForSale: displayTotal,
    lowestPrice: displayLowest,
    medianPrice: displayMedian,
    vgPlusPrice: displayTotal > 0 ? (isSingleSelected ? matches[selectedMatchIndex]?.vgPlusPrice : g.vgPlusPrice) : null,
    lowestGrade: isFiltered ? null : (isSingleSelected ? matches[selectedMatchIndex]?.lowestGrade : g.lowestGrade)
  });

  const suffix = copiesSuffix();
  const matchListEl = document.getElementById('match-list');
  if (matchListEl && matches.length > 1) {
    // When a specific release is selected, we only have 1 matchStats entry
    // but we still render all matches so user can switch selection.
    let html = '<div class="section-divider">Releases containing this track</div>';
    html += '<div class="match-list">';
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const isSelected = selectedMatchIndex === i;

      // Determine per-match stats: if aggregate (no selection), use matchStats array;
      // if this is the selected match, use fData.matchStats[0] (the single entry).
      // Scraped data is the source of truth — no capping against stale API values.
      let msPrice = m.lowestPrice;
      let msCount = m.numForSale || 0;
      let msSuffix = 'for sale';

      if (!isSingleSelected && fData.matchStats && fData.matchStats[i]) {
        const msRaw = fData.matchStats[i];
        msPrice = msRaw.lowestPrice != null ? msRaw.lowestPrice : m.lowestPrice;
        msCount = msRaw.numForSale;
        msSuffix = suffix;
      } else if (isSingleSelected && isSelected && fData.matchStats && fData.matchStats[0]) {
        const msRaw = fData.matchStats[0];
        msPrice = msRaw.lowestPrice != null ? msRaw.lowestPrice : m.lowestPrice;
        msCount = msRaw.numForSale;
        msSuffix = suffix;
      }

      const isCheapest = i === 0;
      html += `<div class="match-item${isSelected ? ' selected' : ''}" data-match-idx="${i}">`;
      if (m.thumb) {
        html += `<img class="match-thumb" src="${escHtml(m.thumb)}" alt="">`;
      } else {
        html += `<div class="match-thumb match-thumb-empty">🎵</div>`;
      }
      html += `<div class="match-info">`;
      html += `<div class="match-title">${escHtml(m.title)}</div>`;
      html += `<div class="match-artist">${escHtml(m.artists)}${m.year ? ' (' + m.year + ')' : ''}${m.format ? ' · ' + escHtml(m.format) : ''}</div>`;
      html += `</div>`;
      html += `<div class="match-price-col">`;
      if (msCount > 0) {
        html += `<div class="match-price">${fmtPrice(msPrice)}</div>`;
        html += `<div class="match-copies">${msCount} ${msSuffix}</div>`;
      } else {
        html += `<div class="match-price dim">—</div>`;
        html += `<div class="match-copies">none ${msSuffix}</div>`;
      }
      html += `</div>`;
      if (isCheapest) html += `<div class="cheapest-badge">Best Price</div>`;
      html += `</div>`;
    }
    html += '</div>';
    matchListEl.innerHTML = html;
    bindMatchClicks(matchListEl);
  } else if (matchListEl && matches.length <= 1) {
    matchListEl.innerHTML = '';
  }
}

function showResults(data) {
  hideAll();
  show(mainEl);
  selectedMatchIndex = null;  // reset selection on new search

  const g = data.global;
  const matches = g.matches || [];

  /* release header — show the cheapest (first) match */
  const primary = matches.length > 0 ? matches[0] : g;

  if (primary.thumb) { thumbEl.src = primary.thumb; thumbEl.style.display = ''; }
  else               { thumbEl.style.display = 'none'; }

  rTitle.textContent  = primary.title;
  rArtist.innerHTML   = escHtml(primary.artists) + ' <span class="release-year">(' + (primary.year || '?') + ')</span>';
  rLink.href          = primary.sellUrl || g.sellUrl;

  /* stats */
  renderStats(globalStats, g);

  /* match list */
  const matchListEl = document.getElementById('match-list');
  if (matchListEl) {
    renderMatchList(matchListEl, matches);
  }

  cachedData = data;

  /* Apply saved toggle states */
  chrome.storage.sync.get(['usOnly', 'vgPlus'], (d) => {
    usToggle.checked = !!d.usOnly;
    vgToggle.checked = !!d.vgPlus;
    applyFilters();
  });
}

/* -- main flow -- */
async function init() {
  /* 1 — check for token */
  const { discogsToken } = await chrome.storage.sync.get('discogsToken');

  if (!discogsToken) {
    hideAll();
    show(setupEl);
    return;
  }

  /* token exists — hide setup, show gear link */
  hide(setupEl);
  changeToken.style.display = '';

  /* 2 — get current tab */
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.url || !tab.url.includes('youtube.com/watch')) {
    hideAll();
    show(notYtEl);
    return;
  }

  /* 3 — extract & clean title */
  const rawTitle = tab.title || '';
  const query = cleanTitle(rawTitle);
  if (DEBUG) console.log('[POPUP] raw tab.title:', JSON.stringify(rawTitle));
  if (DEBUG) console.log('[POPUP] cleaned query:', JSON.stringify(query));
  if (!query) {
    hideAll();
    show(notYtEl);
    return;
  }

  /* 4 — search */
  cachedQuery = query;

  // Check for cached data first — show instantly if available
  chrome.runtime.sendMessage(
    { type: 'discogs-cache-check', query },
    (cacheRes) => {
      if (chrome.runtime.lastError) { /* ignore */ }
      if (cacheRes?.data) {
        showResults(cacheRes.data);
      }

      // Always fetch fresh data (even if we showed cached)
      if (!cacheRes?.data) {
        hideAll();
        show(loadingEl);
      }

      chrome.runtime.sendMessage(
        { type: 'discogs-full-search', query },
        (res) => {
          if (chrome.runtime.lastError) {
            if (!cacheRes?.data) {
              hideAll();
              show(errorEl);
              errorEl.textContent = '⚠ Extension error — try reloading.';
            }
            return;
          }
          if (res?.error) {
            if (!cacheRes?.data) {
              hideAll();
              show(errorEl);
              errorEl.textContent = '⚠ ' + res.error;
            }
            return;
          }
          if (res?.data) {
            showResults(res.data);
          }
        }
      );
    }
  );
}

/* -- save token -- */
saveBtn.addEventListener('click', () => {
  const val = tokenInput.value.trim();
  if (!val) return;
  chrome.storage.sync.set({ discogsToken: val }, () => {
    init();
  });
});
tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBtn.click();
});

/* -- change token -- */
changeToken.addEventListener('click', (e) => {
  e.preventDefault();
  hideAll();
  tokenInput.value = '';
  show(setupEl);
  tokenInput.focus();
});

/* -- filter toggles -- */
usToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ usOnly: usToggle.checked });
  applyFilters();
});

vgToggle.addEventListener('change', () => {
  chrome.storage.sync.set({ vgPlus: vgToggle.checked });
  applyFilters();
});

/* -- kick off -- */
init();
