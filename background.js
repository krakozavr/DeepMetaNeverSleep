const browserAPI = chrome;

// Update checking
// TODO: replace with your actual Vercel project URL after deploying
const UPDATE_CHECK_URL = 'https://YOUR_PROJECT.vercel.app/version.json';
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

async function checkForUpdate() {
  try {
    const response = await fetch(UPDATE_CHECK_URL);
    if (!response.ok) return;
    const { version: latestVersion } = await response.json();
    const manifest = browserAPI.runtime.getManifest();
    if (latestVersion && latestVersion !== manifest.version) {
      browserAPI.notifications.create('update-available', {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'DeepMeta Never Sleep — Update Available',
        message: `Version ${latestVersion} is available (you have ${manifest.version}). Reinstall the extension to update.`
      });
    }
  } catch (err) {
    // Network unavailable or endpoint not yet configured — silently ignore
  }
}

// Track active upload requests by request ID
const activeUploadRequests = new Map(); // requestId -> { tabId, url, timestamp }
const activeUploadTabs = new Set(); // Set of tab IDs with active uploads

// Grace period timer to prevent premature keep-awake release
let releaseKeepAwakeTimer = null;
const RELEASE_GRACE_PERIOD = 10000; // 10 seconds grace period

// Check if URL is a DeepMeta upload endpoint
function isDeepMetaUploadUrl(url) {
  return url.includes('/api/dm-initialize-upload') ||
         url.includes('/api/dm-authorize-upload-chunk') ||
         url.includes('/api/dm-finalize-upload') ||
         url.includes('/contribute/esp/uploads') ||
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

// Periodic cleanup of stale requests (safety mechanism)
setInterval(() => {
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
}, 30000); // Every 30 seconds

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
  if (activeUploadTabs.size > 0) {
    // Cancel any pending release timer
    if (releaseKeepAwakeTimer) {
      clearTimeout(releaseKeepAwakeTimer);
      releaseKeepAwakeTimer = null;
      console.log('[DeepMeta Never Sleep] Cancelled pending keep-awake release');
    }

    // Keep system awake (screen can turn off)
    browserAPI.power.requestKeepAwake('system');
    console.log(`[DeepMeta Never Sleep] Keep awake enabled (${activeUploadTabs.size} active uploads)`);
  } else {
    // No active uploads - start grace period before releasing keep-awake
    // This prevents releasing and re-acquiring keep-awake during gaps between upload batches
    if (releaseKeepAwakeTimer) {
      console.log('[DeepMeta Never Sleep] Grace period already active, waiting...');
      return;
    }

    console.log(`[DeepMeta Never Sleep] No active uploads, starting ${RELEASE_GRACE_PERIOD/1000}s grace period...`);
    releaseKeepAwakeTimer = setTimeout(() => {
      // After grace period, check again if still no uploads
      if (activeUploadTabs.size === 0) {
        browserAPI.power.releaseKeepAwake();
        console.log('[DeepMeta Never Sleep] Keep awake released (grace period expired, no new uploads)');
      } else {
        console.log('[DeepMeta Never Sleep] New uploads started during grace period, staying awake');
      }
      releaseKeepAwakeTimer = null;
    }, RELEASE_GRACE_PERIOD);
  }
}

// Check for existing DeepMeta tabs on extension load
browserAPI.runtime.onInstalled.addListener(() => {
  console.log('[DeepMeta Never Sleep] Extension installed/updated');
  checkExistingTabs();
  checkForUpdate();
  browserAPI.alarms.create('update-check', { periodInMinutes: UPDATE_CHECK_INTERVAL / 60000 });
});

browserAPI.runtime.onStartup.addListener(() => {
  console.log('[DeepMeta Never Sleep] Browser started');
  checkExistingTabs();
  checkForUpdate();
});

browserAPI.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'update-check') checkForUpdate();
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
