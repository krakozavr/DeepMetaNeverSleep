// Content script for DeepMeta Never Sleep
// This script sends periodic heartbeats to keep the service worker alive
// Upload detection is now handled by webRequest API in background.js

console.log('[DeepMeta Never Sleep] Content script loaded');

// Send heartbeat every 20 seconds to keep service worker alive
// The service worker will be kept alive as long as there are active uploads
const heartbeatInterval = setInterval(() => {
  try {
    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      console.log('[DeepMeta Never Sleep] Extension context invalidated, stopping heartbeat');
      clearInterval(heartbeatInterval);
      return;
    }

    chrome.runtime.sendMessage({
      type: 'HEARTBEAT'
    }).catch(err => {
      // Extension might be reloading, ignore promise rejection
    });
  } catch (err) {
    // Extension context invalidated, stop the interval
    console.log('[DeepMeta Never Sleep] Extension context invalidated, stopping heartbeat');
    clearInterval(heartbeatInterval);
  }
}, 20000); // Every 20 seconds

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
});

console.log('[DeepMeta Never Sleep] Content script initialized and monitoring');


// =============================================================================
// FEATURE: Restore batch list scroll position (added v1.2.0)
//
// PROBLEM: On the batches list page (/contribute/esp/batches), clicking a batch
// row navigates to /contribute/esp/uploads?batchId=UUID. Pressing the "<" back
// button returns to /contribute/esp/batches but resets the scroll to the top,
// forcing the user to manually scroll down to find their batch again.
//
// ROOT CAUSE: The site is a Next.js App Router SPA. Both the row click AND the
// back button use history.pushState (not a real browser popstate/back). Next.js
// re-mounts the page component on every navigation, resetting the scrollable
// container's scrollTop to 0. There is no built-in scroll anchor.
//
// FIX: Intercept history.pushState to:
//   1. Save the container's scrollTop to sessionStorage when leaving /batches.
//   2. Restore it when arriving back at /batches, after polling until the table
//      has re-rendered (Next.js renders async after pushState).
// =============================================================================

(function () {
  'use strict';

  const LOG = '[DeepMeta Never Sleep][ScrollRestore]';
  const STORAGE_KEY = 'deepmeta_batches_scrollTop';
  const CONTAINER_SEL = 'div.relative.flex.flex-1.flex-col.overflow-y-auto';
  const BATCHES_PATH = '/contribute/esp/batches';

  function getContainer() {
    return document.querySelector(CONTAINER_SEL);
  }

  function isBatchesPath(url) {
    try {
      return new URL(url, location.origin).pathname === BATCHES_PATH;
    } catch {
      return false;
    }
  }

  // After a pushState to /batches, Next.js re-renders asynchronously.
  // Poll until the table tbody has rows again, then restore scrollTop.
  function restoreScrollWhenReady() {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved === null) return;

    const scrollTo = parseInt(saved, 10);
    sessionStorage.removeItem(STORAGE_KEY);

    console.log(`${LOG} Navigation to batches detected — will restore scrollTop to ${scrollTo}px`);

    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const tbody = document.querySelector('table tbody');
      const container = getContainer();

      if (tbody && tbody.children.length > 0 && container) {
        container.scrollTop = scrollTo;
        console.log(`${LOG} Scroll restored to ${scrollTo}px after ${attempts} poll(s)`);
        clearInterval(interval);
      } else if (attempts > 40) {
        // Give up after ~2 seconds to avoid polling forever
        console.warn(`${LOG} Could not restore scroll — table did not appear within 2s`);
        clearInterval(interval);
      }
    }, 50);
  }

  // Intercept pushState — the single hook that covers both directions:
  //   • Row click  : current path = /batches, new URL = /uploads?batchId=...
  //   • Back button: current path = /uploads,  new URL = /batches
  const origPushState = history.pushState.bind(history);
  history.pushState = function (state, title, url) {
    const newUrl = String(url);

    // Leaving the batches page → save current scroll position
    if (location.pathname === BATCHES_PATH && !isBatchesPath(newUrl)) {
      const container = getContainer();
      if (container && container.scrollTop > 0) {
        sessionStorage.setItem(STORAGE_KEY, Math.round(container.scrollTop));
        console.log(`${LOG} Leaving batches — saved scrollTop: ${Math.round(container.scrollTop)}px`);
      }
    }

    origPushState(state, title, url);

    // Arriving at the batches page → restore scroll
    if (isBatchesPath(newUrl)) {
      restoreScrollWhenReady();
    }
  };

  // Belt-and-suspenders: also handle a real browser back/forward gesture,
  // in case the user uses the browser's own Back button instead of the "<" button.
  window.addEventListener('popstate', () => {
    if (location.pathname === BATCHES_PATH) {
      restoreScrollWhenReady();
    }
  });

  console.log(`${LOG} Scroll restore listener active`);
})();
