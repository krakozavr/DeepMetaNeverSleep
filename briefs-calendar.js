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

  let likedEspIds = new Set();      // liked set from the latest list response
  let lastBriefsUrl = '';
  let nextPendingId = 1;
  let pendingActions = [];
  // Liked set per list URL. Diffs are taken only between two responses of the
  // same URL, so switching filters/pages is never mistaken for a like/unlike.
  const likedByUrl = new Map();
  // Article (title + deadline) → espId, learned from resolved actions so later
  // toggles of the same brief resolve directly instead of by diff.
  const espIdByArticle = new Map();
  // espId → last dispatched action; suppresses repeat confirmations of the same
  // state while letting like → unlike → like through.
  const lastDispatched = new Map();

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
          .then(payload => onBriefsResponse(extractBriefItems(payload), url))
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

  function articleKey(data) {
    return `${normalizeTitle(data.title)}|${data.isoDeadline || ''}`;
  }

  function onBriefsResponse(items, url = '') {
    if (!Array.isArray(items)) return;

    const present = new Set(items.map(itemEspId).filter(Boolean));
    const newLiked = new Set(
      items
        .filter(item => Number(item.rating) === 100)
        .map(itemEspId)
        .filter(Boolean)
    );

    // Changes since the previous response of the same list URL
    const previous = likedByUrl.get(url);
    const addedIds = previous ? [...newLiked].filter(id => !previous.has(id)) : [];
    const removedIds = previous ? [...previous].filter(id => !newLiked.has(id)) : [];
    likedByUrl.set(url, newLiked);

    if (pendingActions.length > 0) {
      const usedIds = new Set();
      const resolvedPendingIds = new Set();
      const resolve = (pending, espId) => {
        usedIds.add(espId);
        resolvedPendingIds.add(pending.id);
        espIdByArticle.set(pending.key, espId);
        dispatchAction(pending.action, espId, pending.data);
      };
      const reachedTarget = (pending, espId) => pending.action === 'like'
        ? newLiked.has(espId)
        : (present.has(espId) ? !newLiked.has(espId) : removedIds.includes(espId));

      // 1. Brief already identified earlier: just wait for its target state.
      for (const pending of pendingActions) {
        const espId = espIdByArticle.get(pending.key);
        if (espId && !usedIds.has(espId) && reachedTarget(pending, espId)) {
          resolve(pending, espId);
        }
      }

      // 2. API payloads that expose titles/codes: deterministic match.
      for (const pending of pendingActions) {
        if (resolvedPendingIds.has(pending.id) || espIdByArticle.has(pending.key)) continue;
        const espId = findConfirmedEspId(pending, items, newLiked, usedIds);
        if (espId) resolve(pending, espId);
      }

      // 3. Live API has no titles: use the same-URL diff, but only when it is
      //    unambiguous (one waiting action ↔ one changed espId). Guessing
      //    between several would attach a title/deadline to the wrong brief.
      for (const action of ['like', 'unlike']) {
        const waiting = pendingActions.filter(pending =>
          pending.action === action &&
          !resolvedPendingIds.has(pending.id) &&
          !espIdByArticle.has(pending.key)
        );
        const knownIds = new Set(espIdByArticle.values());
        const candidates = (action === 'like' ? addedIds : removedIds)
          .filter(id => !usedIds.has(id) && !knownIds.has(id));
        if (waiting.length === 1 && candidates.length === 1) {
          resolve(waiting[0], candidates[0]);
        }
      }

      pendingActions = pendingActions.filter(pending => !resolvedPendingIds.has(pending.id));
    }

    likedEspIds = newLiked;
  }

  async function refreshBriefs(reason) {
    // Capture the URL now: the page may switch filters (updating
    // lastBriefsUrl) while this request is in flight.
    const url = lastBriefsUrl;
    if (!url || pendingActions.length === 0) return;
    try {
      const response = await _fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onBriefsResponse(extractBriefItems(await response.json()), url);
      console.log(`${LOG} Rechecked briefs after like (${reason})`);
    } catch (error) {
      console.warn(`${LOG} Brief recheck failed (${reason}): ${error.message}`);
    }
  }

  function queueListAction(action, data) {
    const key = articleKey(data);

    // like then unlike (or the reverse) before DeepMeta confirmed the first:
    // the two cancel out — the brief is back in its original state.
    const opposite = pendingActions.find(pending => pending.key === key && pending.action !== action);
    if (opposite) {
      pendingActions = pendingActions.filter(pending => pending !== opposite);
      console.log(`${LOG} ${opposite.action} + ${action} cancelled out: "${data.title}"`);
      return;
    }
    // Same action already waiting for this brief (double click): keep one.
    if (pendingActions.some(pending => pending.key === key && pending.action === action)) return;

    const pending = {
      id: nextPendingId++,
      action,
      data,
      key,
      snapshot: new Set(likedEspIds)
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
    // Skip only a repeat of the same state (e.g. two responses confirming the
    // same like). A real toggle like → unlike → like always goes through.
    const last = lastDispatched.get(espId);
    if (last && last.action === action && Date.now() - last.at < RECENT_DISPATCH_MS) return;
    lastDispatched.set(espId, { action, at: Date.now() });

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

  // espId → { action } awaiting DOM confirmation on the detail page
  const pendingDetail = new Map();

  function queueDetailAction(button, data, action) {
    const waiting = pendingDetail.get(data.espId);
    if (waiting && waiting.action !== action) {
      // Toggled back before the first click was confirmed: cancel both.
      pendingDetail.delete(data.espId);
      console.log(`${LOG} ${waiting.action} + ${action} cancelled out (detail): "${data.title}"`);
      return;
    }
    if (waiting) return; // double click of the same action
    const token = { action };
    pendingDetail.set(data.espId, token);
    confirmDetailAction(button, data, action, 0, token);
  }

  function confirmDetailAction(button, data, action, attempt, token) {
    window.setTimeout(() => {
      if (pendingDetail.get(data.espId) !== token) return; // cancelled

      const svg = button.querySelector('svg');
      const isLiked = svg?.getAttribute('fill') === 'currentColor';
      if ((action === 'like' && isLiked) || (action === 'unlike' && !isLiked)) {
        pendingDetail.delete(data.espId);
        dispatchAction(action, data.espId, data);
        return;
      }
      if (attempt < 4) {
        confirmDetailAction(button, data, action, attempt + 1, token);
      } else {
        pendingDetail.delete(data.espId);
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
    queueDetailAction(detailBtn, data, action);
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
