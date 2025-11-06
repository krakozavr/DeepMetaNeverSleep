// Track active uploads
let activeUploads = new Set();
let lastUploadState = false;

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
  }
}

// Update upload state
function updateUploadState() {
  const hasActiveUploads = activeUploads.size > 0;
  console.log(`[DeepMeta Never Sleep] Upload state: ${hasActiveUploads ? 'ACTIVE' : 'IDLE'} (${activeUploads.size} uploads)`);
  notifyUploadStatus(hasActiveUploads);
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

  // Check if this looks like a file upload
  const isUpload = body instanceof FormData ||
                   body instanceof File ||
                   body instanceof Blob ||
                   (body && body.constructor && body.constructor.name === 'FormData');

  if (isUpload && xhr._deepMetaMethod === 'POST') {
    const uploadId = Date.now() + Math.random();
    console.log(`[DeepMeta Never Sleep] XHR upload detected: ${xhr._deepMetaUrl}`);

    activeUploads.add(uploadId);
    updateUploadState();

    // Track upload completion
    const originalOnReadyStateChange = xhr.onreadystatechange;
    xhr.onreadystatechange = function(...args) {
      if (xhr.readyState === 4) {
        console.log(`[DeepMeta Never Sleep] XHR upload completed: ${xhr._deepMetaUrl}`);
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
      console.log(`[DeepMeta Never Sleep] XHR upload error: ${xhr._deepMetaUrl}`);
      activeUploads.delete(uploadId);
      updateUploadState();
    });

    xhr.addEventListener('abort', () => {
      console.log(`[DeepMeta Never Sleep] XHR upload aborted: ${xhr._deepMetaUrl}`);
      activeUploads.delete(uploadId);
      updateUploadState();
    });
  }

  return originalXHRSend.apply(this, arguments);
};

// Monitor Fetch API
const originalFetch = window.fetch;
window.fetch = function(url, options = {}) {
  const isUpload = options.body instanceof FormData ||
                   options.body instanceof File ||
                   options.body instanceof Blob;

  if (isUpload && options.method && options.method.toUpperCase() === 'POST') {
    const uploadId = Date.now() + Math.random();
    console.log(`[DeepMeta Never Sleep] Fetch upload detected: ${url}`);

    activeUploads.add(uploadId);
    updateUploadState();

    return originalFetch.apply(this, arguments)
      .then(response => {
        console.log(`[DeepMeta Never Sleep] Fetch upload completed: ${url}`);
        activeUploads.delete(uploadId);
        updateUploadState();
        return response;
      })
      .catch(error => {
        console.log(`[DeepMeta Never Sleep] Fetch upload error: ${url}`);
        activeUploads.delete(uploadId);
        updateUploadState();
        throw error;
      });
  }

  return originalFetch.apply(this, arguments);
};

// Monitor DOM for upload indicators (backup detection method)
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
observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'style']
});

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
