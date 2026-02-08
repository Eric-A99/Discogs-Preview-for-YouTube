/*  popup.js — Discogs Preview toolbar popup
 *  Detects YouTube tab, fetches Discogs data, renders pricing.
 */

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
    html += `<a class="match-item${isCheapest ? ' cheapest' : ''}" href="${escHtml(m.sellUrl)}" target="_blank" rel="noopener noreferrer">`;
    if (m.thumb) {
      html += `<img class="match-thumb" src="${escHtml(m.thumb)}" alt="">`;
    } else {
      html += `<div class="match-thumb match-thumb-empty">🎵</div>`;
    }
    html += `<div class="match-info">`;
    html += `<div class="match-title">${escHtml(m.title)}</div>`;
    html += `<div class="match-artist">${escHtml(m.artists)}${m.year ? ' (' + m.year + ')' : ''}</div>`;
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
    html += `</a>`;
  }
  html += '</div>';
  container.innerHTML = html;
}

function buildFilteredUrl(url, usOnly, vgPlus) {
  if (!url) return url;
  let sep = url.includes('?') ? '&' : '?';
  if (usOnly) { url += sep + 'ships_from=United+States'; sep = '&'; }
  // Note: VG+ filtering is done in code, not via URL param
  // (Discogs condition URL param doesn't work reliably for VG+)
  return url;
}

function filterCacheKey() {
  const us = usToggle.checked;
  const vg = vgToggle.checked;
  if (us && vg) return 'usVg';
  if (us)       return 'us';
  if (vg)       return 'vg';
  return null;
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

function renderUnfiltered() {
  if (!cachedData) return;
  const g = cachedData.global;
  const matches = g.matches || [];
  const primary = matches.length > 0 ? matches[0] : g;
  const divider = document.getElementById('stats-divider');

  divider.innerHTML = 'All Vinyl — <span class="badge">All Conditions Worldwide</span>';
  rLink.href = primary.sellUrl || g.sellUrl;
  rLink.textContent = 'View all copies on Discogs ↗';
  renderStats(globalStats, g);

  const matchListEl = document.getElementById('match-list');
  if (matchListEl) renderMatchList(matchListEl, matches);
}

function applyFilters() {
  if (!cachedData) return;
  const us = usToggle.checked;
  const vg = vgToggle.checked;

  // No filters — show original API data
  if (!us && !vg) { renderUnfiltered(); return; }

  const key = filterCacheKey();
  const g = cachedData.global;
  const matches = g.matches || [];
  const primary = matches.length > 0 ? matches[0] : g;
  const divider = document.getElementById('stats-divider');

  // If we already have cached data for this filter combo, show it
  if (cachedData[key]) {
    showFilteredData(cachedData[key], matches);
    return;
  }

  // Show loading state
  divider.innerHTML = filterLabel();
  rLink.href = buildFilteredUrl(primary.sellUrl || g.sellUrl, us, vg);
  rLink.textContent = filterLinkText();
  globalStats.innerHTML = '<div class="stat-card" style="grid-column:1/-1;text-align:center;color:#9e9e9e;font-size:12px;"><div class="spinner" style="display:inline-block;margin-right:8px;vertical-align:middle;"></div>Loading filtered results…</div>';

  const matchData = matches.map(m => ({ sellUrl: m.sellUrl }));

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
  const primary = matches.length > 0 ? matches[0] : cachedData.global;
  const us = usToggle.checked;
  const vg = vgToggle.checked;

  divider.innerHTML = filterLabel();
  rLink.href = buildFilteredUrl(primary.sellUrl || cachedData.global.sellUrl, us, vg);
  rLink.textContent = filterLinkText();

  // Use filter-specific prices when available, fall back to API prices
  const g = cachedData.global;
  const fLowest = fData.lowestPrice != null ? fData.lowestPrice : null;
  const fMedian = fData.medianPrice != null ? fData.medianPrice : null;
  // Cap filtered count at global count — filtered is a subset, can never exceed total
  const cappedTotal = Math.min(fData.numForSale, g.numForSale || Infinity);

  // Decide whether to use scraped prices or fall back to global API prices.
  // When VG+ filter is on, we MUST use scraped prices — the global API
  // lowest/median includes all conditions (VG, G, F, P) which would be wrong.
  // When only US filter is on (no VG+), we can fall back to global prices
  // if the filter didn't narrow the count (all copies already ship from US).
  const useScrapedPrices = vg || cappedTotal < (g.numForSale || 0);
  const displayLowest = cappedTotal > 0
    ? (useScrapedPrices ? (fLowest != null ? fLowest : g.lowestPrice) : g.lowestPrice)
    : null;
  const displayMedian = cappedTotal > 0
    ? (useScrapedPrices ? (fMedian != null ? fMedian : g.medianPrice) : g.medianPrice)
    : null;

  renderStats(globalStats, {
    numForSale: cappedTotal,
    lowestPrice: displayLowest,
    medianPrice: displayMedian,
    vgPlusPrice: cappedTotal > 0 ? g.vgPlusPrice : null,
    lowestGrade: useScrapedPrices ? null : g.lowestGrade
  });

  const suffix = copiesSuffix();
  const matchListEl = document.getElementById('match-list');
  if (matchListEl && matches.length > 1 && fData.matchStats) {
    let html = '<div class="section-divider">Releases containing this track</div>';
    html += '<div class="match-list">';
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const msRaw = fData.matchStats[i] || { numForSale: 0, lowestPrice: null, medianPrice: null };
      // Cap per-match filtered count at global count for this match
      const ms = { numForSale: Math.min(msRaw.numForSale, m.numForSale || Infinity), lowestPrice: msRaw.lowestPrice };
      // When VG+ is on, always use scraped price (global includes all conditions).
      // When only US filter, fall back to global match price if count unchanged.
      const useMatchScraped = vg || ms.numForSale < (m.numForSale || 0);
      const msPrice = useMatchScraped
        ? (ms.lowestPrice != null ? ms.lowestPrice : m.lowestPrice)
        : m.lowestPrice;
      const isCheapest = i === 0;
      html += `<a class="match-item${isCheapest ? ' cheapest' : ''}" href="${escHtml(buildFilteredUrl(m.sellUrl, us, vg))}" target="_blank" rel="noopener noreferrer">`;
      if (m.thumb) {
        html += `<img class="match-thumb" src="${escHtml(m.thumb)}" alt="">`;
      } else {
        html += `<div class="match-thumb match-thumb-empty">🎵</div>`;
      }
      html += `<div class="match-info">`;
      html += `<div class="match-title">${escHtml(m.title)}</div>`;
      html += `<div class="match-artist">${escHtml(m.artists)}${m.year ? ' (' + m.year + ')' : ''}</div>`;
      html += `</div>`;
      html += `<div class="match-price-col">`;
      if (ms.numForSale > 0) {
        html += `<div class="match-price">${fmtPrice(msPrice)}</div>`;
        html += `<div class="match-copies">${ms.numForSale} ${suffix}</div>`;
      } else {
        html += `<div class="match-price dim">—</div>`;
        html += `<div class="match-copies">none ${suffix}</div>`;
      }
      html += `</div>`;
      if (isCheapest) html += `<div class="cheapest-badge">Best Price</div>`;
      html += `</a>`;
    }
    html += '</div>';
    matchListEl.innerHTML = html;
  } else if (matchListEl && matches.length <= 1) {
    matchListEl.innerHTML = '';
  }
}

function showResults(data) {
  hideAll();
  show(mainEl);

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
  console.log('[POPUP] raw tab.title:', JSON.stringify(rawTitle));
  console.log('[POPUP] cleaned query:', JSON.stringify(query));
  if (!query) {
    hideAll();
    show(notYtEl);
    return;
  }

  /* 4 — search */
  cachedQuery = query;
  hideAll();
  show(loadingEl);

  chrome.runtime.sendMessage(
    { type: 'discogs-full-search', query },
    (res) => {
      if (chrome.runtime.lastError) {
        hideAll();
        show(errorEl);
        errorEl.textContent = '⚠ Extension error — try reloading.';
        return;
      }
      if (res?.error) {
        hideAll();
        show(errorEl);
        errorEl.textContent = '⚠ ' + res.error;
        return;
      }
      if (res?.data) {
        showResults(res.data);
      }
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
