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
  if (event.source !== window || event.data?.source !== 'DMNS_SETTINGS_REQUEST') {
    return;
  }
  loadAndPostSettings();
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
