// Track active uploads
let activeUploads = new Set();
let lastUploadState = false;
let heartbeatInterval = null;

console.log('[DeepMeta Never Sleep] Content script loaded');

// Notify background script of upload status
function notifyUploadStatus(isUploading) {
  if (lastUploadState !== isUploading) {
    lastUploadState = isUploading;
    chrome.runtime.sendMessage({
      type: 'UPLOAD_STATUS',
      isUploading: isUploading
    }).catch(err => {
      // Extension might be reloading, ignore
      console.log('[DeepMeta Never Sleep] Could not send message:', err.message);
    });

    // Manage heartbeat to keep service worker alive during uploads
    if (isUploading) {
      // Start heartbeat every 20 seconds to keep service worker alive
      if (!heartbeatInterval) {
        console.log('[DeepMeta Never Sleep] Starting service worker heartbeat');
        heartbeatInterval = setInterval(() => {
          chrome.runtime.sendMessage({
            type: 'HEARTBEAT'
          }).catch(err => {
            console.log('[DeepMeta Never Sleep] Heartbeat failed:', err.message);
          });
        }, 20000); // Every 20 seconds
      }
    } else {
      // Stop heartbeat when uploads complete
      if (heartbeatInterval) {
        console.log('[DeepMeta Never Sleep] Stopping service worker heartbeat');
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    }
  }
}

// Update upload state
function updateUploadState() {
  const hasActiveUploads = activeUploads.size > 0;
  console.log(`[DeepMeta Never Sleep] Upload state: ${hasActiveUploads ? 'ACTIVE' : 'IDLE'} (${activeUploads.size} uploads)`);
  notifyUploadStatus(hasActiveUploads);
}

// Check if URL is a DeepMeta upload-related endpoint
function isDeepMetaUploadUrl(url, method) {
  const urlStr = url.toString();

  // DeepMeta API endpoints
  if (urlStr.includes('/api/dm-initialize-upload') ||
      urlStr.includes('/api/dm-authorize-upload-chunk') ||
      urlStr.includes('/api/dm-finalize-upload') ||
      urlStr.includes('/contribute/esp/uploads')) {
    return true;
  }

  // Proxy URLs for actual file uploads to ESP/S3
  if (urlStr.includes('dm-proxy-') && urlStr.includes('.workers.dev')) {
    return true;
  }

  // Generic upload detection for POST/PUT with file data
  if ((method === 'POST' || method === 'PUT')) {
    return true;
  }

  return false;
}

// Monitor XMLHttpRequest
const originalXHROpen = XMLHttpRequest.prototype.open;
const originalXHRSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function(method, url, ...args) {
  this._deepMetaMethod = method;
  this._deepMetaUrl = url;
  return originalXHROpen.apply(this, [method, url, ...args]);
};

XMLHttpRequest.prototype.send = function(body) {
  const xhr = this;
  const method = xhr._deepMetaMethod;
  const url = xhr._deepMetaUrl;

  // Check if this is a DeepMeta upload request
  const isUploadData = body instanceof FormData ||
                       body instanceof File ||
                       body instanceof Blob ||
                       (body && body.constructor && body.constructor.name === 'FormData') ||
                       (body && typeof body === 'string' && body.length > 1024) || // Large data
                       (body instanceof ArrayBuffer && body.byteLength > 1024);

  // Monitor both POST and PUT for DeepMeta uploads
  if (isUploadData && (method === 'POST' || method === 'PUT') && isDeepMetaUploadUrl(url, method)) {
    const uploadId = Date.now() + Math.random();
    console.log(`[DeepMeta Never Sleep] XHR ${method} upload detected: ${url}`);

    activeUploads.add(uploadId);
    updateUploadState();

    // Track upload completion
    const originalOnReadyStateChange = xhr.onreadystatechange;
    xhr.onreadystatechange = function(...args) {
      if (xhr.readyState === 4) {
        console.log(`[DeepMeta Never Sleep] XHR ${method} upload completed: ${url}`);
        activeUploads.delete(uploadId);
        updateUploadState();
      }
      if (originalOnReadyStateChange) {
        return originalOnReadyStateChange.apply(this, args);
      }
    };

    // Also listen to loadend event
    xhr.addEventListener('loadend', () => {
      activeUploads.delete(uploadId);
      updateUploadState();
    });

    // Handle errors
    xhr.addEventListener('error', () => {
      console.log(`[DeepMeta Never Sleep] XHR ${method} upload error: ${url}`);
      activeUploads.delete(uploadId);
      updateUploadState();
    });

    xhr.addEventListener('abort', () => {
      console.log(`[DeepMeta Never Sleep] XHR ${method} upload aborted: ${url}`);
      activeUploads.delete(uploadId);
      updateUploadState();
    });
  }

  return originalXHRSend.apply(this, arguments);
};

// Monitor Fetch API
const originalFetch = window.fetch;
window.fetch = function(url, options = {}) {
  const method = options.method ? options.method.toUpperCase() : 'GET';
  const isUploadData = options.body instanceof FormData ||
                       options.body instanceof File ||
                       options.body instanceof Blob ||
                       (options.body && typeof options.body === 'string' && options.body.length > 1024) ||
                       (options.body instanceof ArrayBuffer && options.body.byteLength > 1024);

  // Monitor both POST and PUT for DeepMeta uploads
  if (isUploadData && (method === 'POST' || method === 'PUT') && isDeepMetaUploadUrl(url, method)) {
    const uploadId = Date.now() + Math.random();
    console.log(`[DeepMeta Never Sleep] Fetch ${method} upload detected: ${url}`);

    activeUploads.add(uploadId);
    updateUploadState();

    return originalFetch.apply(this, arguments)
      .then(response => {
        console.log(`[DeepMeta Never Sleep] Fetch ${method} upload completed: ${url}`);
        activeUploads.delete(uploadId);
        updateUploadState();
        return response;
      })
      .catch(error => {
        console.log(`[DeepMeta Never Sleep] Fetch ${method} upload error: ${url}`);
        activeUploads.delete(uploadId);
        updateUploadState();
        throw error;
      });
  }

  return originalFetch.apply(this, arguments);
};

// Monitor DOM for upload indicators (backup detection method)
function setupDOMObserver() {
  const observer = new MutationObserver((mutations) => {
    // Look for common upload UI patterns
    const uploadIndicators = document.querySelectorAll([
      '[class*="upload"][class*="progress"]',
      '[class*="uploading"]',
      '[class*="file-upload"]',
      'progress[value]',
      '[role="progressbar"]',
      '.upload-progress',
      '.uploading'
    ].join(','));

    // If we find upload indicators, we might have missed the upload start
    // This is a backup to ensure we catch uploads
    if (uploadIndicators.length > 0 && activeUploads.size === 0) {
      console.log('[DeepMeta Never Sleep] Upload UI detected in DOM (backup detection)');
      const backupId = 'dom-detected';
      activeUploads.add(backupId);
      updateUploadState();

      // Clear after a timeout if no actual uploads are detected
      setTimeout(() => {
        if (activeUploads.has(backupId) && activeUploads.size === 1) {
          activeUploads.delete(backupId);
          updateUploadState();
        }
      }, 5000);
    }
  });

  // Start observing the document
  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style']
    });
  }
}

// Wait for document.body to be available before setting up DOM observer
if (document.body) {
  setupDOMObserver();
} else {
  document.addEventListener('DOMContentLoaded', setupDOMObserver);
}

// Periodic check for upload activity (every 5 seconds)
setInterval(() => {
  // Check for visible progress bars or upload indicators
  const hasVisibleUploads = document.querySelector([
    '[class*="upload"][class*="progress"]:not([hidden])',
    '[class*="uploading"]:not([hidden])',
    'progress[value]:not([value="0"]):not([value="100"])'
  ].join(','));

  if (hasVisibleUploads && activeUploads.size === 0) {
    console.log('[DeepMeta Never Sleep] Active upload UI detected (periodic check)');
    activeUploads.add('periodic-check');
    updateUploadState();
  } else if (!hasVisibleUploads && activeUploads.has('periodic-check')) {
    activeUploads.delete('periodic-check');
    updateUploadState();
  }
}, 5000);

// Handle page unload
window.addEventListener('beforeunload', () => {
  if (activeUploads.size > 0) {
    console.log('[DeepMeta Never Sleep] Page unloading with active uploads');
    notifyUploadStatus(false);
  }
});

console.log('[DeepMeta Never Sleep] Content script initialized and monitoring');
