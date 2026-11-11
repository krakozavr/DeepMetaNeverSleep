// Content script for DeepMeta Never Sleep
// This script sends periodic heartbeats to keep the service worker alive
// Upload detection is now handled by webRequest API in background.js

console.log('[DeepMeta Never Sleep] Content script loaded');

const DEFAULT_SETTINGS = {
  preventSleepActiveUploads: true,
  restoreSearchResults: true,
  restoreBatchPosition: true
};

function postSettings(settings) {
  window.postMessage({
    source: 'DMNS_EXTENSION_SETTINGS',
    settings
  }, location.origin);
}

function loadAndPostSettings() {
  try {
    chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
      postSettings({ ...DEFAULT_SETTINGS, ...stored });
    });
  } catch (err) {
    postSettings(DEFAULT_SETTINGS);
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  const nextSettings = {};
  let changed = false;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (changes[key]) {
      nextSettings[key] = changes[key].newValue;
      changed = true;
    }
  }

  if (changed) {
    chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
      postSettings({ ...DEFAULT_SETTINGS, ...stored, ...nextSettings });
    });
  }
});

window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  if (event.data?.source === 'DMNS_SETTINGS_REQUEST') {
    loadAndPostSettings();
    return;
  }

  if (
    event.data?.source === 'DMNS_BRIEF_LIKED' ||
    event.data?.source === 'DMNS_BRIEF_UNLIKED'
  ) {
    const { source, ...payload } = event.data;
    const type = source === 'DMNS_BRIEF_LIKED' ? 'BRIEF_LIKED' : 'BRIEF_UNLIKED';
    chrome.runtime.sendMessage({ type, ...payload })
      .then(result => {
        window.postMessage({
          source: 'DMNS_BRIEF_RESULT',
          result: result || { ok: false, error: 'No response from extension' }
        }, location.origin);
      })
      .catch(error => {
        window.postMessage({
          source: 'DMNS_BRIEF_RESULT',
          result: { ok: false, error: error.message || 'Extension message failed' }
        }, location.origin);
      });
    return;
  }

  if (event.data?.source === 'DMNS_BRIEF_STATUS') {
    chrome.runtime.sendMessage({
      type: 'BRIEF_STATUS',
      status: event.data.status
    }).catch(() => {});
  }
});

loadAndPostSettings();

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
