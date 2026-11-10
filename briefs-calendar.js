// Content script (MAIN world) — briefs page only.
// Wraps window.fetch to track liked espIds via the briefs list API responses.
// List-view likes/unlikes are queued until DeepMeta confirms them in the API,
// with explicit rechecks so a missing SPA refetch cannot silently lose sync.
(function () {
  'use strict';

  const LOG = '[DeepMeta Never Sleep][Briefs]';
  // Briefs list endpoint. DeepMeta moved it from /api/dm-briefs to
  // /api/v1/dm/briefs (Nov 2026); match both. Sub-routes such as
  // /api/v1/dm/briefs/interest-sync (polled every ~5s) are excluded.
  const BRIEFS_API_RE = /\/api\/(?:v\d+\/dm\/briefs|dm-briefs)(?:[?#]|$)/;
  const ESP_BASE = 'https://esp.gettyimages.com/contribute/briefs/detail/';
  const RECHECK_DELAYS_MS = [500, 1500, 3500];
  const PENDING_TTL_MS = 10000;
  const RECENT_DISPATCH_MS = 30000;

  let likedEspIds = new Set();
  let hasBriefSnapshot = false;
  let lastBriefsUrl = '';
  let nextPendingId = 1;
  let pendingActions = [];
  const recentDispatches = new Map();

  // --- Fetch interception ---

  const _fetch = window.fetch;
  window.fetch = function dmnsBriefsFetch(...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const method = String(args[1]?.method || args[0]?.method || 'GET').toUpperCase();
    const promise = _fetch.apply(this, args);

    if (BRIEFS_API_RE.test(url)) {
      if (method === 'GET') lastBriefsUrl = url;
      promise.then(r => {
        if (!r.ok) return;
        r.clone().json()
          .then(payload => onBriefsResponse(extractBriefItems(payload)))
          .catch(() => {});
      });
    }

    return promise;
  };

  function extractBriefItems(payload) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return null;
    for (const key of ['items', 'data', 'results', 'briefs']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
    return null;
  }

  function itemEspId(item) {
    return String(item?.espId || item?.espID || item?.esp_id || '').trim();
  }

  function itemTitle(item) {
    return String(
      item?.title || item?.name || item?.briefTitle || item?.displayTitle || ''
    ).trim();
  }

  function itemCode(item) {
    return String(
      item?.code || item?.briefCode || item?.briefId || item?.id || ''
    ).trim();
  }

  function normalizeTitle(value) {
    return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  }

  function findConfirmedEspId(pending, items, newLiked, usedIds) {
    const wantedTitle = normalizeTitle(pending.data.title);
    const wantedCode = String(pending.data.articleCode || '').trim();
    let candidates = items.filter(item => {
      const espId = itemEspId(item);
      if (!espId || usedIds.has(espId)) return false;
      const isLiked = newLiked.has(espId);
      if (pending.action === 'like' && (!isLiked || pending.snapshot.has(espId))) return false;
      if (pending.action === 'unlike' && isLiked) return false;
      return normalizeTitle(itemTitle(item)) === wantedTitle;
    });

    if (wantedCode && candidates.length > 1) {
      candidates = candidates.filter(item => itemCode(item) === wantedCode);
    }

    return candidates.length === 1 ? itemEspId(candidates[0]) : '';
  }

  function onBriefsResponse(items) {
    if (!Array.isArray(items)) return;

    const newLiked = new Set(
      items
        .filter(item => Number(item.rating) === 100)
        .map(itemEspId)
        .filter(Boolean)
    );

    if (pendingActions.length > 0) {
      const usedIds = new Set();
      const resolvedPendingIds = new Set();
      const globallyAddedIds = [...newLiked].filter(id => !likedEspIds.has(id));
      const globallyRemovedIds = [...likedEspIds].filter(id => !newLiked.has(id));

      // Prefer a deterministic title/code match from the API catalog. This is
      // what keeps multiple quick likes associated with the correct articles.
      for (const pending of pendingActions) {
        const espId = findConfirmedEspId(pending, items, newLiked, usedIds);
        if (!espId) continue;
        usedIds.add(espId);
        resolvedPendingIds.add(pending.id);
        dispatchAction(pending.action, espId, pending.data);
      }

      // Older API payloads may not expose a recognizable title. In that case,
      // fall back to the added-id diff, but only when a valid pre-click snapshot
      // was available. Never guess from an empty, not-yet-initialized snapshot.
      for (const pending of pendingActions) {
        if (resolvedPendingIds.has(pending.id) || !pending.snapshotReady) continue;
        const changedIds = pending.action === 'like'
          ? globallyAddedIds
          : globallyRemovedIds;
        const espId = changedIds.find(id =>
          !usedIds.has(id) && (
            pending.action === 'like'
              ? !pending.snapshot.has(id)
              : pending.snapshot.has(id)
          )
        );
        if (!espId) continue;
        usedIds.add(espId);
        resolvedPendingIds.add(pending.id);
        dispatchAction(pending.action, espId, pending.data);
      }

      pendingActions = pendingActions.filter(pending => !resolvedPendingIds.has(pending.id));
    }

    likedEspIds = newLiked;
    hasBriefSnapshot = true;
  }

  async function refreshBriefs(reason) {
    if (!lastBriefsUrl || pendingActions.length === 0) return;
    try {
      const response = await _fetch(lastBriefsUrl, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onBriefsResponse(extractBriefItems(await response.json()));
      console.log(`${LOG} Rechecked briefs after like (${reason})`);
    } catch (error) {
      console.warn(`${LOG} Brief recheck failed (${reason}): ${error.message}`);
    }
  }

  function queueListAction(action, data) {
    const pending = {
      id: nextPendingId++,
      action,
      data,
      snapshot: new Set(likedEspIds),
      snapshotReady: hasBriefSnapshot
    };
    pendingActions.push(pending);

    for (const delay of RECHECK_DELAYS_MS) {
      window.setTimeout(() => {
        if (pendingActions.some(item => item.id === pending.id)) {
          return refreshBriefs(`${delay}ms`);
        }
      }, delay);
    }

    window.setTimeout(() => {
      const stillPending = pendingActions.some(item => item.id === pending.id);
      if (!stillPending) return;
      pendingActions = pendingActions.filter(item => item.id !== pending.id);
      console.warn(`${LOG} ${action} confirmation timed out: "${data.title}"`);
      reportLocalFailure(
        data.title,
        action === 'like'
          ? 'DeepMeta did not confirm the like. No Google Task was created.'
          : 'DeepMeta did not confirm removal of the like. The Google Task was preserved.'
      );
    }, PENDING_TTL_MS);
  }

  function reportLocalFailure(title, error) {
    window.postMessage({
      source: 'DMNS_BRIEF_STATUS',
      status: { state: 'error', title, error }
    }, location.origin);
  }

  function dispatchAction(action, espId, data) {
    const dispatchKey = `${action}:${espId}`;
    const lastDispatchedAt = recentDispatches.get(dispatchKey) || 0;
    if (Date.now() - lastDispatchedAt < RECENT_DISPATCH_MS) return;
    recentDispatches.set(dispatchKey, Date.now());

    const espLink = ESP_BASE + espId;
    const liked = action === 'like';
    console.log(`${LOG} Brief ${liked ? 'liked' : 'unliked'}: "${data.title}" (${data.isCc ? 'CC' : 'Creative'}) → ${espLink}`);
    // MAIN world has no chrome.runtime — bridge via postMessage to isolated content.js
    window.postMessage({
      source: liked ? 'DMNS_BRIEF_LIKED' : 'DMNS_BRIEF_UNLIKED',
      title: data.title,
      dueDate: data.isoDeadline,
      espLink,
      isCc: data.isCc
    }, location.origin);
  }

  function confirmDetailAction(button, data, action, attempt = 0) {
    window.setTimeout(() => {
      const svg = button.querySelector('svg');
      const isLiked = svg?.getAttribute('fill') === 'currentColor';
      if ((action === 'like' && isLiked) || (action === 'unlike' && !isLiked)) {
        dispatchAction(action, data.espId, data);
        return;
      }
      if (attempt < 4) {
        confirmDetailAction(button, data, action, attempt + 1);
      } else {
        console.warn(`${LOG} Detail ${action} was not confirmed: "${data.title}"`);
        reportLocalFailure(
          data.title,
          action === 'like'
            ? 'DeepMeta did not confirm the like. No Google Task was created.'
            : 'DeepMeta did not confirm removal of the like. The Google Task was preserved.'
        );
      }
    }, 300 + attempt * 200);
  }

  // --- DOM helpers ---

  function extractArticleData(article) {
    const h3 = article.querySelector('h3');
    const time = article.querySelector('time[datetime]');
    if (!h3 || !time) return null;
    return {
      title: h3.textContent.trim(),
      isoDeadline: time.getAttribute('datetime'),
      isCc: !!article.querySelector('[class*="fuchsia"]'),
      articleCode: article.querySelector('img[alt]')?.getAttribute('alt') || ''
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

  // --- Like click detection ---

  function onDocumentClick(event) {
    // List view
    const listBtn = event.target.closest('button[title="Like"]');
    if (listBtn) {
      const svg = listBtn.querySelector('svg');
      if (!svg) return;
      const action = svg.getAttribute('fill') === 'currentColor' ? 'unlike' : 'like';
      const article = listBtn.closest('article');
      if (!article) return;
      const data = extractArticleData(article);
      if (!data) return;
      queueListAction(action, data);
      console.log(`${LOG} ${action} click: "${data.title}"`);
      return;
    }

    // Detail view — espId is in the URL, no diff needed
    const detailBtn = event.target.closest('button[title="Like / Remove like"]');
    if (!detailBtn) return;
    const svg = detailBtn.querySelector('svg');
    if (!svg) return;
    const action = svg.getAttribute('fill') === 'currentColor' ? 'unlike' : 'like';
    const data = extractDetailData();
    if (!data) return;
    console.log(`${LOG} ${action} click (detail): "${data.title}"`);
    confirmDetailAction(detailBtn, data, action);
  }

  document.addEventListener('click', onDocumentClick, true);

  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== 'DMNS_BRIEF_RESULT') return;
    const result = event.data.result;
    if (result?.ok) {
      const suffix = result.deduped ? ' (duplicate suppressed)' : '';
      const action = result.action === 'delete' ? 'removal' : 'creation';
      console.log(`${LOG} Google Task ${action} confirmed${suffix}: "${result.title || ''}"`);
    } else {
      console.error(`${LOG} Google Task failed: ${result?.error || 'Unknown error'}`);
    }
  });

  console.log(`${LOG} Active (MAIN world)`);
})();
