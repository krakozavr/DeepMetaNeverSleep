// Content script for DeepMeta Never Sleep
// This script sends periodic heartbeats to keep the service worker alive
// Upload detection is now handled by webRequest API in background.js

// Cross-browser compatibility: Firefox uses 'browser', Chrome uses 'chrome'
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

console.log('[DeepMeta Never Sleep] Content script loaded');

// Send heartbeat every 20 seconds to keep service worker alive
// The service worker will be kept alive as long as there are active uploads
const heartbeatInterval = setInterval(() => {
  try {
    // Check if extension context is still valid
    if (!browserAPI.runtime?.id) {
      console.log('[DeepMeta Never Sleep] Extension context invalidated, stopping heartbeat');
      clearInterval(heartbeatInterval);
      return;
    }

    browserAPI.runtime.sendMessage({
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
