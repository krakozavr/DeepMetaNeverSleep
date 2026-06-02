const browserAPI = chrome;

const DEFAULT_SETTINGS = {
  preventSleepActiveUploads: true,
  restoreSearchResults: true,
  restoreBatchPosition: true
};

let settings = { ...DEFAULT_SETTINGS };
let settingsLoaded = false;

const STATE_TITLES = {
  active:  'DeepMetaNeverSleep - Active',
  waiting: 'DeepMetaNeverSleep - Idling',
  error:   'DeepMetaNeverSleep - Error'
};

let currentIconState = null;

// Set extension icon and tooltip based on state: 'active', 'waiting', 'error'.
// No-op when the requested state already matches the current one; otherwise
// each upload request would re-issue setIcon (which re-fetches three PNGs).
function setIcon(state) {
  if (currentIconState === state) return;
  currentIconState = state;
  browserAPI.action.setIcon({
    path: {
      16: `icons/icon-16-${state}.png`,
      48: `icons/icon-48-${state}.png`,
      128: `icons/icon128-${state}.png`
    }
  });
  browserAPI.action.setTitle({ title: STATE_TITLES[state] });
}

// Track active upload requests by request ID
const activeUploadRequests = new Map(); // requestId -> { tabId, url, timestamp }
const activeUploadTabs = new Set(); // Set of tab IDs with active uploads

// Alarm names
const GRACE_PERIOD_ALARM = 'releaseKeepAwake';
const STALE_CLEANUP_ALARM = 'staleCleanup';

// Grace period (in minutes) before releasing keep-awake after all uploads finish.
// Must be >= 1 due to Chrome alarm API minimum delay.
// Prevents rapid on/off during gaps between upload batches.
const RELEASE_GRACE_PERIOD_MINUTES = 1;

function loadSettings(callback) {
  browserAPI.storage.local.get(DEFAULT_SETTINGS, (stored) => {
    settings = { ...DEFAULT_SETTINGS, ...stored };
    settingsLoaded = true;
    if (callback) callback();
  });
}

browserAPI.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  let changed = false;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (changes[key]) {
      settings[key] = changes[key].newValue;
      changed = true;
    }
  }

  if (changed) {
    updatePowerState();
  }
});

// Check if URL is a DeepMeta upload endpoint.
// Matches only the real file-transfer endpoints. The /contribute/esp/uploads
// page route is intentionally NOT matched: the SPA posts to it for page-state
// work that is not a file upload, which would otherwise flip the icon active.
function isDeepMetaUploadUrl(url) {
  return url.includes('/api/dm-initialize-upload') ||
         url.includes('/api/dm-authorize-upload-chunk') ||
         url.includes('/api/dm-finalize-upload') ||
         (url.includes('dm-proxy-') && url.includes('.workers.dev'));
}

// Listen for upload requests starting (webRequest API - works at browser level)
browserAPI.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Only track POST and PUT requests to DeepMeta endpoints
    if ((details.method === 'POST' || details.method === 'PUT') &&
        isDeepMetaUploadUrl(details.url) &&
        details.tabId >= 0) {

      activeUploadRequests.set(details.requestId, {
        tabId: details.tabId,
        url: details.url,
        timestamp: Date.now()
      });

      if (!activeUploadTabs.has(details.tabId)) {
        activeUploadTabs.add(details.tabId);
        console.log(`[DeepMeta Never Sleep] Upload started in tab ${details.tabId} - ${details.method} ${details.url}`);
        updatePowerState();
      }
    }
  },
  {
    urls: [
      "https://deepmeta.creativ.zone/*",
      "https://*.workers.dev/*"
    ]
  }
);

// Listen for upload requests completing
browserAPI.webRequest.onCompleted.addListener(
  (details) => {
    if (activeUploadRequests.has(details.requestId)) {
      const request = activeUploadRequests.get(details.requestId);
      activeUploadRequests.delete(details.requestId);

      console.log(`[DeepMeta Never Sleep] Upload request completed: ${request.url}`);

      // Check if this tab still has active uploads
      const tabStillActive = Array.from(activeUploadRequests.values())
        .some(req => req.tabId === request.tabId);

      if (!tabStillActive && activeUploadTabs.has(request.tabId)) {
        activeUploadTabs.delete(request.tabId);
        console.log(`[DeepMeta Never Sleep] All uploads completed in tab ${request.tabId}`);
        updatePowerState();
      }
    }
  },
  {
    urls: [
      "https://deepmeta.creativ.zone/*",
      "https://*.workers.dev/*"
    ]
  }
);

// Listen for upload requests failing/aborting
browserAPI.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (activeUploadRequests.has(details.requestId)) {
      const request = activeUploadRequests.get(details.requestId);
      activeUploadRequests.delete(details.requestId);

      console.log(`[DeepMeta Never Sleep] Upload request failed: ${request.url} (${details.error})`);

      // Check if this tab still has active uploads
      const tabStillActive = Array.from(activeUploadRequests.values())
        .some(req => req.tabId === request.tabId);

      if (!tabStillActive && activeUploadTabs.has(request.tabId)) {
        activeUploadTabs.delete(request.tabId);
        setIcon('error');
        console.log(`[DeepMeta Never Sleep] All uploads stopped in tab ${request.tabId}`);
        updatePowerState();
      }
    }
  },
  {
    urls: [
      "https://deepmeta.creativ.zone/*",
      "https://*.workers.dev/*"
    ]
  }
);

// Handle alarms - persistent across service worker restarts
browserAPI.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === GRACE_PERIOD_ALARM) {
    // After grace period, release keep-awake if still no active uploads.
    // This fires even if the service worker was terminated and restarted,
    // which is the key fix for the deactivation bug.
    if (activeUploadTabs.size === 0 || !settings.preventSleepActiveUploads) {
      browserAPI.power.releaseKeepAwake();
      setIcon('waiting');
      console.log('[DeepMeta Never Sleep] Keep awake released (grace period alarm fired, no active uploads)');
    } else {
      console.log('[DeepMeta Never Sleep] New uploads started during grace period, staying awake');
    }
  } else if (alarm.name === STALE_CLEANUP_ALARM) {
    runStaleCleanup();
  }
});

// Periodic cleanup of stale requests (safety mechanism)
// Uses alarms instead of setInterval so it survives service worker restarts.
function runStaleCleanup() {
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000; // 5 minutes

  for (const [requestId, request] of activeUploadRequests.entries()) {
    if (now - request.timestamp > staleThreshold) {
      console.log(`[DeepMeta Never Sleep] Cleaning up stale request: ${request.url}`);
      activeUploadRequests.delete(requestId);
    }
  }

  // Recalculate active tabs
  const currentActiveTabs = new Set(
    Array.from(activeUploadRequests.values()).map(req => req.tabId)
  );

  if (currentActiveTabs.size !== activeUploadTabs.size) {
    activeUploadTabs.clear();
    currentActiveTabs.forEach(tabId => activeUploadTabs.add(tabId));
    updatePowerState();
  }
}

// Listen for messages from content scripts (for heartbeat to keep worker alive)
browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HEARTBEAT') {
    // Heartbeat to keep service worker alive
    // Just receiving this message keeps the worker active
  }
});

// Listen for tab closure
browserAPI.tabs.onRemoved.addListener((tabId) => {
  if (activeUploadTabs.has(tabId)) {
    console.log(`[DeepMeta Never Sleep] Tab ${tabId} closed, removing from active uploads`);
    activeUploadTabs.delete(tabId);
    updatePowerState();
  }
});

// Update power management state based on active uploads
function updatePowerState() {
  if (!settingsLoaded) {
    // Defer power-state decisions until the user's saved settings have loaded.
    // On a cold service-worker start, webRequest events can fire before
    // storage.local.get resolves; acting now would mean honoring the default
    // (preventSleepActiveUploads:true) even when the user disabled it.
    // loadSettings's callback will re-run updatePowerState to reconcile.
    return;
  }
  if (!settings.preventSleepActiveUploads) {
    browserAPI.alarms.clear(GRACE_PERIOD_ALARM);
    browserAPI.power.releaseKeepAwake();
    setIcon('waiting');
    if (activeUploadTabs.size > 0) {
      console.log('[DeepMeta Never Sleep] Keep awake disabled in extension settings');
    }
    return;
  }

  if (activeUploadTabs.size > 0) {
    // Cancel any pending grace period alarm
    browserAPI.alarms.clear(GRACE_PERIOD_ALARM);

    // Keep system awake (screen can turn off)
    browserAPI.power.requestKeepAwake('system');
    setIcon('active');
    console.log(`[DeepMeta Never Sleep] Keep awake enabled (${activeUploadTabs.size} active uploads)`);
  } else {
    // No active uploads - schedule grace period alarm before releasing keep-awake.
    // Using chrome.alarms instead of setTimeout so the release fires correctly
    // even if the service worker is terminated while waiting (e.g. tab in background).
    browserAPI.alarms.get(GRACE_PERIOD_ALARM, (existing) => {
      if (existing) {
        console.log('[DeepMeta Never Sleep] Grace period alarm already scheduled, waiting...');
        return;
      }
      console.log(`[DeepMeta Never Sleep] No active uploads, scheduling ${RELEASE_GRACE_PERIOD_MINUTES}min grace period alarm...`);
      browserAPI.alarms.create(GRACE_PERIOD_ALARM, {
        delayInMinutes: RELEASE_GRACE_PERIOD_MINUTES
      });
    });
  }
}

// Check for existing DeepMeta tabs on extension load
browserAPI.runtime.onInstalled.addListener(() => {
  console.log('[DeepMeta Never Sleep] Extension installed/updated');
  loadSettings(() => {
    setIcon('waiting');
    // Start periodic stale-request cleanup alarm
    browserAPI.alarms.create(STALE_CLEANUP_ALARM, { periodInMinutes: 1 });
    checkExistingTabs();
  });
});

browserAPI.runtime.onStartup.addListener(() => {
  console.log('[DeepMeta Never Sleep] Browser started');
  loadSettings(() => {
    setIcon('waiting');
    // Ensure periodic cleanup alarm is running
    browserAPI.alarms.get(STALE_CLEANUP_ALARM, (existing) => {
      if (!existing) {
        browserAPI.alarms.create(STALE_CLEANUP_ALARM, { periodInMinutes: 1 });
      }
    });
    checkExistingTabs();
  });
});

// Check existing tabs for DeepMeta
async function checkExistingTabs() {
  try {
    const tabs = await browserAPI.tabs.query({ url: 'https://deepmeta.creativ.zone/*' });
    console.log(`[DeepMeta Never Sleep] Found ${tabs.length} DeepMeta tab(s)`);
    // Content script injection is handled automatically by the manifest content_scripts
    // declaration — no need to inject manually here, which would cause a duplicate
    // 'browserAPI' declaration error on pages that already have the script loaded.
  } catch (error) {
    console.error('[DeepMeta Never Sleep] Error checking existing tabs:', error);
  }
}

loadSettings(() => updatePowerState());
