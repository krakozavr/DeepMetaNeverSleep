// Content script (MAIN world) — briefs page only.
// Wraps window.fetch to track liked espIds via the briefs list API responses.
// Detects like/unlike button clicks, snapshots the liked set, diffs the
// post-click response to find the espId that changed, then sends the brief
// data to background (create task on like, remove task on unlike).
(function () {
  'use strict';

  const LOG = '[DeepMeta Never Sleep][Briefs]';
  // Briefs list endpoint. DeepMeta moved it from /api/dm-briefs to
  // /api/v1/dm/briefs (Nov 2026); match both. Sub-routes such as
  // /api/v1/dm/briefs/interest-sync are excluded.
  const BRIEFS_API_RE = /\/api\/(?:v\d+\/dm\/briefs|dm-briefs)(?:[?#]|$)/;
  const ESP_BASE = 'https://esp.gettyimages.com/contribute/briefs/detail/';

  let likedEspIds = new Set();  // espIds currently known to have rating:100
  // List-view clicks waiting for the refetch that reveals their espId:
  // { snapshot: Set of liked espIds before the click, data: { title, isoDeadline, isCc } }
  let pendingLike = null;
  let pendingUnlike = null;

  // --- Fetch interception ---

  const _fetch = window.fetch;
  window.fetch = function dmnsBriefsFetch(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const promise = _fetch.apply(this, args);

    if (BRIEFS_API_RE.test(url)) {
      promise.then(r => r.clone().json().then(onBriefsResponse).catch(() => {}));
    }

    return promise;
  };

  function onBriefsResponse(items) {
    if (!Array.isArray(items)) return;

    const newLiked = new Set(
      items.filter(item => item.rating === 100).map(item => item.espId)
    );

    if (pendingLike) {
      const added = [...newLiked].filter(id => !pendingLike.snapshot.has(id));
      if (added.length === 1) {
        dispatch('DMNS_BRIEF_LIKED', added[0], pendingLike.data);
        pendingLike = null;
      }
    }

    if (pendingUnlike) {
      // Only consider espIds present in this response, so a brief that merely
      // dropped out of a filtered/paged response isn't mistaken for an unlike.
      const present = new Set(items.map(item => item.espId));
      const removed = [...pendingUnlike.snapshot]
        .filter(id => present.has(id) && !newLiked.has(id));
      if (removed.length === 1) {
        dispatch('DMNS_BRIEF_UNLIKED', removed[0], pendingUnlike.data);
        pendingUnlike = null;
      }
    }

    likedEspIds = newLiked;
  }

  function dispatch(source, espId, data) {
    const espLink = ESP_BASE + espId;
    const verb = source === 'DMNS_BRIEF_LIKED' ? 'liked' : 'unliked';
    console.log(`${LOG} Brief ${verb}: "${data.title}" (${data.isCc ? 'CC' : 'Creative'}) → ${espLink}`);
    // MAIN world has no chrome.runtime — bridge via postMessage to isolated content.js
    window.postMessage({
      source,
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

  function extractDetailData() {
    const espId = window.location.pathname.split('/').pop();
    if (!espId) return null;
    const h1 = document.querySelector('header h1');
    const time = document.querySelector('time[datetime]');
    if (!h1 || !time) return null;
    return {
      espId,
      title: h1.textContent.trim(),
      isoDeadline: time.getAttribute('datetime'),
      isCc: !!document.querySelector('[class*="fuchsia"]')
    };
  }

  // A filled heart (fill="currentColor") means the brief is liked now,
  // so the click is an unlike.
  function isCurrentlyLiked(button) {
    const svg = button.querySelector('svg');
    return !!svg && svg.getAttribute('fill') === 'currentColor';
  }

  // --- Like / unlike click detection ---

  function onDocumentClick(event) {
    // List view — espId comes from diffing the refetched list
    const listBtn = event.target.closest('button[title="Like"]');
    if (listBtn) {
      if (!listBtn.querySelector('svg')) return;
      const article = listBtn.closest('article');
      if (!article) return;
      const data = extractArticleData(article);
      if (!data) return;
      const pending = { snapshot: new Set(likedEspIds), data };
      if (isCurrentlyLiked(listBtn)) {
        pendingUnlike = pending;
        console.log(`${LOG} Unlike click: "${data.title}"`);
      } else {
        pendingLike = pending;
        console.log(`${LOG} Like click: "${data.title}"`);
      }
      return;
    }

    // Detail view — espId is in the URL, no diff needed
    const detailBtn = event.target.closest('button[title="Like / Remove like"]');
    if (!detailBtn || !detailBtn.querySelector('svg')) return;
    const data = extractDetailData();
    if (!data) return;
    if (isCurrentlyLiked(detailBtn)) {
      console.log(`${LOG} Unlike click (detail): "${data.title}"`);
      dispatch('DMNS_BRIEF_UNLIKED', data.espId, data);
    } else {
      console.log(`${LOG} Like click (detail): "${data.title}"`);
      dispatch('DMNS_BRIEF_LIKED', data.espId, data);
    }
  }

  document.addEventListener('click', onDocumentClick, true);
  console.log(`${LOG} Active (MAIN world)`);
})();
