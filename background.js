// Track active upload requests by request ID
const activeUploadRequests = new Map(); // requestId -> { tabId, url, timestamp }
const activeUploadTabs = new Set(); // Set of tab IDs with active uploads

// Check if URL is a DeepMeta upload endpoint
function isDeepMetaUploadUrl(url) {
  return url.includes('/api/dm-initialize-upload') ||
         url.includes('/api/dm-authorize-upload-chunk') ||
         url.includes('/api/dm-finalize-upload') ||
         url.includes('/contribute/esp/uploads') ||
         (url.includes('dm-proxy-') && url.includes('.workers.dev'));
}

// Listen for upload requests starting (webRequest API - works at browser level)
chrome.webRequest.onBeforeRequest.addListener(
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
chrome.webRequest.onCompleted.addListener(
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
chrome.webRequest.onErrorOccurred.addListener(
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'HEARTBEAT') {
    // Heartbeat to keep service worker alive
    // Just receiving this message keeps the worker active
  }
});

// Listen for tab closure
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeUploadTabs.has(tabId)) {
    console.log(`[DeepMeta Never Sleep] Tab ${tabId} closed, removing from active uploads`);
    activeUploadTabs.delete(tabId);
    updatePowerState();
  }
});

// Update power management state based on active uploads
function updatePowerState() {
  if (activeUploadTabs.size > 0) {
    // Keep system awake (screen can turn off)
    chrome.power.requestKeepAwake('system');
    console.log(`[DeepMeta Never Sleep] Keep awake enabled (${activeUploadTabs.size} active uploads)`);
  } else {
    // Release keep awake
    chrome.power.releaseKeepAwake();
    console.log('[DeepMeta Never Sleep] Keep awake released (no active uploads)');
  }
}

// Check for existing DeepMeta tabs on extension load
chrome.runtime.onInstalled.addListener(() => {
  console.log('[DeepMeta Never Sleep] Extension installed/updated');
  checkExistingTabs();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[DeepMeta Never Sleep] Browser started');
  checkExistingTabs();
});

// Check existing tabs for DeepMeta
async function checkExistingTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://deepmeta.creativ.zone/*' });
    console.log(`[DeepMeta Never Sleep] Found ${tabs.length} DeepMeta tab(s)`);

    // Inject content script into existing tabs if needed
    for (const tab of tabs) {
      if (tab.id) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
          });
        } catch (error) {
          // Tab might not be ready or accessible, ignore
          console.log(`[DeepMeta Never Sleep] Could not inject into tab ${tab.id}:`, error.message);
        }
      }
    }
  } catch (error) {
    console.error('[DeepMeta Never Sleep] Error checking existing tabs:', error);
  }
}
