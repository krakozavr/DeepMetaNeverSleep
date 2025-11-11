// Track tabs with active uploads
const activeUploadTabs = new Set();

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'UPLOAD_STATUS') {
    const tabId = sender.tab?.id;

    if (!tabId) {
      return;
    }

    if (message.isUploading) {
      console.log(`[DeepMeta Never Sleep] Upload started in tab ${tabId}`);
      activeUploadTabs.add(tabId);
      updatePowerState();
    } else {
      console.log(`[DeepMeta Never Sleep] Upload ended in tab ${tabId}`);
      activeUploadTabs.delete(tabId);
      updatePowerState();
    }
  } else if (message.type === 'HEARTBEAT') {
    // Heartbeat to keep service worker alive during uploads
    // Just receiving this message keeps the worker active
    // Don't log every heartbeat to avoid console spam
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
