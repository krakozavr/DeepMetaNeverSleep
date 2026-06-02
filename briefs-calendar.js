// Content script (MAIN world) — briefs page only.
// Wraps window.fetch to track liked espIds via /api/dm-briefs responses.
// Detects like-button clicks, snapshots liked set, diffs post-like response
// to find the new espId, then sends complete brief data to background.
(function () {
  'use strict';

  const LOG = '[DeepMeta Never Sleep][Briefs]';
  const BRIEFS_API = '/api/dm-briefs';
  const ESP_BASE = 'https://esp.gettyimages.com/contribute/briefs/detail/';

  let likedEspIds = new Set();  // espIds currently known to have rating:100
  let pendingSnapshot = null;   // snapshot of likedEspIds taken just before like POST
  let pendingData = null;       // { title, isoDeadline, isCc } extracted from DOM at click

  // --- Fetch interception ---

  const _fetch = window.fetch;
  window.fetch = function dmnsBriefsFetch(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const promise = _fetch.apply(this, args);

    if (url.includes(BRIEFS_API)) {
      promise.then(r => r.clone().json().then(onBriefsResponse).catch(() => {}));
    }

    return promise;
  };

  function onBriefsResponse(items) {
    if (!Array.isArray(items)) return;

    const newLiked = new Set(
      items.filter(item => item.rating === 100).map(item => item.espId)
    );

    // If there is a pending like, diff to find the newly added espId
    if (pendingSnapshot !== null && pendingData !== null) {
      const addedId = [...newLiked].find(id => !pendingSnapshot.has(id));
      if (addedId) {
        dispatchLike(addedId, pendingData);
        pendingSnapshot = null;
        pendingData = null;
      }
    }

    likedEspIds = newLiked;
  }

  function dispatchLike(espId, data) {
    const espLink = ESP_BASE + espId;
    console.log(`${LOG} Brief liked: "${data.title}" (${data.isCc ? 'CC' : 'Creative'}) → ${espLink}`);
    // MAIN world has no chrome.runtime — bridge via postMessage to isolated content.js
    window.postMessage({
      source: 'DMNS_BRIEF_LIKED',
      title: data.title,
      dueDate: data.isoDeadline,
      espLink,
      isCc: data.isCc
    }, location.origin);
  }

  // --- DOM helpers ---

  function extractArticleData(article) {
    const h3 = article.querySelector('h3');
    const time = article.querySelector('time[datetime]');
    if (!h3 || !time) return null;
    return {
      title: h3.textContent.trim(),
      isoDeadline: time.getAttribute('datetime'),
      isCc: !!article.querySelector('[class*="fuchsia"]')
    };
  }

  // --- Like click detection ---

  function onDocumentClick(event) {
    const btn = event.target.closest('button[title="Like"]');
    if (!btn) return;

    // SVG fill="currentColor" means the brief is already liked → this is an unlike → skip
    const svg = btn.querySelector('svg');
    if (!svg || svg.getAttribute('fill') === 'currentColor') return;

    const article = btn.closest('article');
    if (!article) return;

    const data = extractArticleData(article);
    if (!data) return;

    // Snapshot current liked state before the like POST fires
    pendingSnapshot = new Set(likedEspIds);
    pendingData = data;
    console.log(`${LOG} Like click: "${data.title}"`);
  }

  document.addEventListener('click', onDocumentClick, true);
  console.log(`${LOG} Active (MAIN world)`);
})();
