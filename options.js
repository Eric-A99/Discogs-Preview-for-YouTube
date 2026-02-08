/*  options.js — Discogs Preview settings page
 *  Saves / loads the user's Discogs personal access token.
 */

const tokenInput  = document.getElementById('token');
const saveBtn     = document.getElementById('save');
const statusLabel = document.getElementById('status');

/* load existing token on page open */
chrome.storage.sync.get('discogsToken', ({ discogsToken }) => {
  if (discogsToken) tokenInput.value = discogsToken;
});

/* save */
saveBtn.addEventListener('click', () => {
  const value = tokenInput.value.trim();
  chrome.storage.sync.set({ discogsToken: value }, () => {
    statusLabel.textContent = '✓ Saved';
    statusLabel.classList.add('show');
    setTimeout(() => statusLabel.classList.remove('show'), 2000);
  });
});

/* also save on Enter */
tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBtn.click();
});
