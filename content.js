/*  content.js — Discogs Preview content script
 *  Runs on youtube.com. Detects video changes, extracts the title,
 *  asks the background worker for Discogs data, and renders a panel.
 */

/* ── state ───────────────────────────────────────────────────── */
let currentVideoId = null;
let panelEl        = null;
let usOnly         = false;

/** Guard: check if the extension context is still valid. */
function isExtensionAlive() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

/* ── title cleaning ──────────────────────────────────────────── */

function cleanTitle(raw) {
  return raw
    /* parenthetical / bracketed noise */
    .replace(/[\(\[][^)\]]*(?:official|music|lyric|audio|video|visuali[sz]er|animated|remaster(?:ed)?|hd|hq|4k|1080p|720p|full\s*album)[\s\S]*?[\)\]]/gi, '')
    /* hashtags & common suffixes */
    .replace(/#\S+/g, '')
    .replace(/\b(official\s*(music\s*)?video|music\s*video|lyric\s*video|audio|visuali[sz]er|full\s*album)\b/gi, '')
    /* collapse whitespace */
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* ── panel creation ──────────────────────────────────────────── */

function ensurePanel() {
  if (panelEl) return panelEl;

  panelEl = document.createElement('div');
  panelEl.id = 'dcgp-panel';

  panelEl.innerHTML = `
    <div class="dcgp-header">
      <svg class="dcgp-logo" width="20" height="20" viewBox="0 0 48 48" fill="none">
        <circle cx="24" cy="24" r="22" stroke="#00e676" stroke-width="3" fill="rgba(0,230,118,0.08)"/>
        <circle cx="24" cy="24" r="8"  fill="#00e676"/>
        <circle cx="24" cy="24" r="3"  fill="#0a0a0a"/>
        <circle cx="24" cy="24" r="15" stroke="#00e676" stroke-width="1" fill="none" opacity="0.4"/>
      </svg>
      <span class="dcgp-brand">Discogs Preview</span>
      <div class="dcgp-toggle-wrap" title="Show US releases only">
        <label class="dcgp-switch">
          <input type="checkbox" id="dcgp-us-toggle">
          <span class="dcgp-slider"></span>
        </label>
        <span class="dcgp-toggle-label">US Only</span>
      </div>
    </div>
    <div class="dcgp-body">
      <div class="dcgp-loading">
        <div class="dcgp-spinner"></div>
        <span>Searching Discogs…</span>
      </div>
    </div>
  `;

  /* inject into YouTube DOM — after the video title area */
  const anchor = document.querySelector('#above-the-fold')
              || document.querySelector('#info-contents')
              || document.querySelector('#meta');

  if (anchor) {
    anchor.parentElement.insertBefore(panelEl, anchor.nextSibling);
  } else {
    document.body.appendChild(panelEl);
  }

  /* US-only toggle handler */
  const toggle = panelEl.querySelector('#dcgp-us-toggle');
  if (isExtensionAlive()) {
    chrome.storage.sync.get('usOnly', (d) => {
      if (chrome.runtime.lastError) return;
      usOnly         = !!d.usOnly;
      toggle.checked = usOnly;
    });
  }

  toggle.addEventListener('change', () => {
    usOnly = toggle.checked;
    if (isExtensionAlive()) {
      chrome.storage.sync.set({ usOnly });
      runSearch();
    }
  });

  return panelEl;
}

/* ── UI renderers ────────────────────────────────────────────── */

function showLoading() {
  const body = panelEl.querySelector('.dcgp-body');
  body.innerHTML = `
    <div class="dcgp-loading">
      <div class="dcgp-spinner"></div>
      <span>Searching Discogs…</span>
    </div>`;
}

function showError(msg) {
  const body = panelEl.querySelector('.dcgp-body');
  if (msg === 'NO_TOKEN') {
    body.innerHTML = `
      <div class="dcgp-error">
        <span>⚠ No Discogs token set.</span>
        <a class="dcgp-link" href="#" id="dcgp-open-options">Open settings →</a>
      </div>`;
    body.querySelector('#dcgp-open-options').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'open-options' });
    });
  } else {
    body.innerHTML = `<div class="dcgp-error">⚠ ${escHtml(msg)}</div>`;
  }
}

function showResults(data) {
  const body     = panelEl.querySelector('.dcgp-body');
  const fmt      = (v) => v != null ? `$${v.toFixed(2)}` : '—';
  const modeTag  = data.usOnly ? ' <span class="dcgp-tag">US</span>' : '';

  body.innerHTML = `
    <div class="dcgp-result">
      ${data.thumb ? `<img class="dcgp-thumb" src="${data.thumb}" alt="">` : ''}
      <div class="dcgp-info">
        <div class="dcgp-title">${escHtml(data.artists)} — ${escHtml(data.title)}
          <span class="dcgp-year">(${data.year || '?'})</span>
        </div>

        <div class="dcgp-stats">
          <div class="dcgp-stat">
            <span class="dcgp-label">Copies for sale${modeTag}</span>
            <span class="dcgp-value">${data.numForSale || 0}</span>
          </div>
          <div class="dcgp-stat">
            <span class="dcgp-label">Median price${modeTag}</span>
            <span class="dcgp-value">${fmt(data.medianPrice)}</span>
          </div>
          <div class="dcgp-stat">
            <span class="dcgp-label">Lowest price${modeTag}</span>
            <span class="dcgp-value dcgp-highlight">${fmt(data.lowestPrice)}</span>
          </div>
        </div>

        <a class="dcgp-link" href="${data.sellUrl}" target="_blank" rel="noopener noreferrer">
          View copies on Discogs ↗
        </a>
      </div>
    </div>
  `;
}

/** Basic HTML-entity escaping for safe DOM insertion. */
function escHtml(str) {
  const el = document.createElement('span');
  el.textContent = str || '';
  return el.innerHTML;
}

/* ── search orchestration ────────────────────────────────────── */

function runSearch() {
  const titleEl =
    document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
    document.querySelector('#title h1 yt-formatted-string');
  if (!titleEl) return;

  const query = cleanTitle(titleEl.textContent);
  if (!query) return;

  ensurePanel();
  showLoading();

  if (!isExtensionAlive()) {
    showError('Extension was reloaded — please refresh the page.');
    return;
  }

  try {
    chrome.runtime.sendMessage(
      { type: 'discogs-full-search', query },
      (res) => {
        if (chrome.runtime.lastError) {
          showError('Extension error — try reloading the page.');
          return;
        }
        if (res?.error)  return showError(res.error);
        if (res?.data?.global)   return showResults(res.data.global);
        showError('Unexpected response from Discogs.');
      }
    );
  } catch {
    showError('Extension was reloaded — please refresh the page.');
  }
}

/* ── detect YouTube navigation ───────────────────────────────── */

function onNavigate() {
  if (!isExtensionAlive()) return;
  if (!location.pathname.startsWith('/watch')) {
    if (panelEl) panelEl.style.display = 'none';
    currentVideoId = null;
    return;
  }

  const vid = new URLSearchParams(location.search).get('v');
  if (vid === currentVideoId) return;
  currentVideoId = vid;

  if (panelEl) panelEl.style.display = '';

  /* YouTube renders the title asynchronously; retry until it appears */
  let attempts = 0;
  const tryRun = () => {
    const titleEl =
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
      document.querySelector('#title h1 yt-formatted-string');
    if (titleEl && titleEl.textContent.trim()) {
      runSearch();
    } else if (attempts++ < 20) {
      setTimeout(tryRun, 500);
    }
  };
  tryRun();
}

/* YouTube SPA custom event — fires after every client-side navigation */
document.addEventListener('yt-navigate-finish', onNavigate);

/* first page load */
setTimeout(onNavigate, 1500);
