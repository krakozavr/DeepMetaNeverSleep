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

// --- Google Tasks integration ---

const TASKS_ORIGIN = 'https://tasks.googleapis.com';
const TASKS_SCOPES = ['https://www.googleapis.com/auth/tasks'];
const LAST_TASK_STATUS_KEY = 'lastTaskStatus';
const BRIEF_TASK_LINKS_KEY = 'briefTaskLinks';
const BRIEF_DEDUP_WINDOW_MS = 30000;
const recentBriefTasks = new Map();
let taskLinkMutation = Promise.resolve();
let briefTaskOperation = Promise.resolve();

class TasksApiError extends Error {
  constructor(status, method, path) {
    const message = status === 401
      ? 'Google authorization expired. Open the extension and reconnect Google Tasks.'
      : `Google Tasks API ${status} (${method} ${path})`;
    super(message);
    this.name = 'TasksApiError';
    this.status = status;
  }
}

function storageGet(defaults) {
  return new Promise(resolve => browserAPI.storage.local.get(defaults, resolve));
}

function storageSet(values) {
  return new Promise(resolve => browserAPI.storage.local.set(values, resolve));
}

function storageRemove(keys) {
  return new Promise(resolve => browserAPI.storage.local.remove(keys, resolve));
}

function setLastTaskStatus(status) {
  return storageSet({
    [LAST_TASK_STATUS_KEY]: {
      ...status,
      timestamp: Date.now()
    }
  });
}

function mutateTaskLinks(mutator) {
  const operation = taskLinkMutation.then(async () => {
    const stored = await storageGet({ [BRIEF_TASK_LINKS_KEY]: {} });
    const links = { ...(stored[BRIEF_TASK_LINKS_KEY] || {}) };
    const result = await mutator(links);
    await storageSet({ [BRIEF_TASK_LINKS_KEY]: links });
    return result;
  });
  taskLinkMutation = operation.catch(() => {});
  return operation;
}

function getTaskLink(espLink) {
  return taskLinkMutation.then(async () => {
    const stored = await storageGet({ [BRIEF_TASK_LINKS_KEY]: {} });
    return stored[BRIEF_TASK_LINKS_KEY]?.[espLink] || null;
  });
}

function saveTaskLink(espLink, taskLink) {
  return mutateTaskLinks(links => {
    links[espLink] = taskLink;
  });
}

function removeTaskLink(espLink) {
  return mutateTaskLinks(links => {
    delete links[espLink];
  });
}

function enqueueBriefTaskOperation(operation) {
  const result = briefTaskOperation.then(operation, operation);
  briefTaskOperation = result.catch(() => {});
  return result;
}

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    browserAPI.identity.getAuthToken({ interactive, scopes: TASKS_SCOPES }, token => {
      if (browserAPI.runtime.lastError) {
        reject(new Error(browserAPI.runtime.lastError.message));
      } else if (!token) {
        reject(new Error('Google Tasks is not connected'));
      } else {
        resolve(token);
      }
    });
  });
}

function removeCachedAuthToken(token) {
  return new Promise(resolve => {
    if (!token) {
      resolve();
      return;
    }
    browserAPI.identity.removeCachedAuthToken({ token }, resolve);
  });
}

async function tasksApi(token, method, path, body, allowAuthRetry = true) {
  const res = await fetch(`${TASKS_ORIGIN}/tasks/v1${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (res.status === 401 && allowAuthRetry) {
    await removeCachedAuthToken(token);
    const refreshedToken = await getAuthToken(false);
    return tasksApi(refreshedToken, method, path, body, false);
  }

  if (!res.ok) throw new TasksApiError(res.status, method, path);
  if (res.status === 204) return {};
  return res.json();
}

async function findOrCreateList(token, name, storageKey, titleStorageKey) {
  const { items = [] } = await tasksApi(token, 'GET', '/users/@me/lists');
  const found = items.find(l => l.title === name);
  if (found) {
    await storageSet({
      [storageKey]: found.id,
      [titleStorageKey]: found.title
    });
    return found.id;
  }
  const created = await tasksApi(token, 'POST', '/users/@me/lists', { title: name });
  await storageSet({
    [storageKey]: created.id,
    [titleStorageKey]: created.title || name
  });
  return created.id;
}

async function handleBriefLiked({ title, dueDate, espLink, isCc }) {
  if (!title || !dueDate || !espLink) {
    throw new Error('Incomplete brief data');
  }

  const now = Date.now();
  for (const [link, timestamp] of recentBriefTasks) {
    if (now - timestamp > BRIEF_DEDUP_WINDOW_MS) recentBriefTasks.delete(link);
  }
  if (recentBriefTasks.has(espLink)) {
    console.log(`[DeepMeta Never Sleep] Duplicate task suppressed: "${title}"`);
    return { title, deduped: true };
  }

  const existingTaskLink = await getTaskLink(espLink);
  if (existingTaskLink) {
    recentBriefTasks.set(espLink, now);
    console.log(`[DeepMeta Never Sleep] Existing linked task preserved: "${title}"`);
    return {
      title,
      listName: existingTaskLink.listName,
      deduped: true
    };
  }

  const defaultListName = isCc ? 'CC Briefs' : 'Creative Briefs';
  const storageKey = isCc ? 'ccListId' : 'creativeListId';
  const titleStorageKey = isCc ? 'ccListTitle' : 'creativeListTitle';

  await setLastTaskStatus({ state: 'creating', title, listName: defaultListName });

  try {
    const token = await getAuthToken(false);
    const stored = await storageGet({
      ccListId: null,
      creativeListId: null,
      ccListTitle: null,
      creativeListTitle: null
    });
    let listId = stored[storageKey];
    let destinationName = stored[titleStorageKey] || defaultListName;

    if (!listId) {
      listId = await findOrCreateList(
        token,
        defaultListName,
        storageKey,
        titleStorageKey
      );
      destinationName = defaultListName;
    }

    const taskBody = { title, due: dueDate, notes: espLink };

    let createdTask;
    try {
      createdTask = await tasksApi(token, 'POST', `/lists/${listId}/tasks`, taskBody);
    } catch (error) {
      if (!(error instanceof TasksApiError) || error.status !== 404) throw error;

      // A list selected in the popup can later be deleted in Google Tasks.
      // Drop that stale ID, recreate/find the default list, and retry once.
      await storageRemove([storageKey, titleStorageKey]);
      listId = await findOrCreateList(
        token,
        defaultListName,
        storageKey,
        titleStorageKey
      );
      destinationName = defaultListName;
      createdTask = await tasksApi(token, 'POST', `/lists/${listId}/tasks`, taskBody);
    }

    if (!createdTask?.id) throw new Error('Google Tasks did not return a task ID');

    await saveTaskLink(espLink, {
      taskId: createdTask.id,
      listId,
      listName: destinationName,
      title,
      createdAt: Date.now()
    });

    recentBriefTasks.set(espLink, Date.now());
    await setLastTaskStatus({
      state: 'success',
      title,
      listName: destinationName,
      espLink
    });

    console.log(`[DeepMeta Never Sleep] Task created: "${title}" → ${destinationName}`);
    return { title, listName: destinationName, deduped: false };
  } catch (error) {
    await setLastTaskStatus({
      state: 'error',
      title,
      listName: defaultListName,
      error: error.message || 'Unknown Google Tasks error'
    });
    throw error;
  }
}

async function handleBriefUnliked({ title, espLink, isCc }) {
  if (!title || !espLink) throw new Error('Incomplete brief data');

  const defaultListName = isCc ? 'CC Briefs' : 'Creative Briefs';
  await setLastTaskStatus({
    state: 'deleting',
    action: 'delete',
    title,
    listName: defaultListName
  });

  try {
    const taskLink = await getTaskLink(espLink);
    if (!taskLink?.taskId || !taskLink?.listId) {
      recentBriefTasks.delete(espLink);
      await setLastTaskStatus({
        state: 'success',
        action: 'not-found',
        title,
        listName: taskLink?.listName || defaultListName,
        espLink
      });
      return { title, deleted: false, notFound: true };
    }

    const token = await getAuthToken(false);
    try {
      await tasksApi(
        token,
        'DELETE',
        `/lists/${encodeURIComponent(taskLink.listId)}/tasks/${encodeURIComponent(taskLink.taskId)}`
      );
    } catch (error) {
      // A 404 means the user already removed the linked task in Google Tasks.
      if (!(error instanceof TasksApiError) || error.status !== 404) throw error;
    }

    await removeTaskLink(espLink);
    recentBriefTasks.delete(espLink);
    await setLastTaskStatus({
      state: 'success',
      action: 'deleted',
      title,
      listName: taskLink.listName || defaultListName,
      espLink
    });
    console.log(`[DeepMeta Never Sleep] Task removed: "${title}" → ${taskLink.listName || defaultListName}`);
    return {
      title,
      listName: taskLink.listName || defaultListName,
      deleted: true
    };
  } catch (error) {
    await setLastTaskStatus({
      state: 'error',
      action: 'delete',
      title,
      listName: defaultListName,
      error: error.message || 'Unknown Google Tasks error'
    });
    throw error;
  }
}

const UPLOAD_API_RE =
  /\/api\/(?:dm-|v\d+\/dm\/)(?:initialize-upload|authorize-upload-chunk|finalize-upload)(?:[/?#]|$)/;

// Check if URL is a DeepMeta upload endpoint.
// Matches only the real file-transfer endpoints. The /contribute/esp/uploads
// page route is intentionally NOT matched: the SPA posts to it for page-state
// work that is not a file upload, which would otherwise flip the icon active.
function isDeepMetaUploadUrl(url) {
  // Old /api/dm-* names and the /api/v1/dm/* style DeepMeta moved to (Nov 2026)
  return UPLOAD_API_RE.test(url) ||
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
    return;
  }

  if (message.type === 'BRIEF_LIKED') {
    enqueueBriefTaskOperation(() => handleBriefLiked(message))
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => {
        console.error('[DeepMeta Never Sleep] Task creation failed:', err.message);
        sendResponse({ ok: false, title: message.title, error: err.message });
      });
    return true;
  }

  if (message.type === 'BRIEF_UNLIKED') {
    enqueueBriefTaskOperation(() => handleBriefUnliked(message))
      .then(result => sendResponse({ ok: true, action: 'delete', ...result }))
      .catch(err => {
        console.error('[DeepMeta Never Sleep] Task removal failed:', err.message);
        sendResponse({
          ok: false,
          action: 'delete',
          title: message.title,
          error: err.message
        });
      });
    return true;
  }

  if (message.type === 'BRIEF_STATUS') {
    const reported = message.status || {};
    const status = {
      state: 'error',
      title: String(reported.title || 'Brief').slice(0, 300),
      error: String(reported.error || 'Brief processing failed').slice(0, 500)
    };
    setLastTaskStatus(status)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'TASKS_CONNECT') {
    getAuthToken(true)
      .then(token => tasksApi(token, 'GET', '/users/@me/lists'))
      .then(data => sendResponse({ ok: true, lists: data.items || [] }))
      .catch(err => {
        console.error('[DeepMeta Never Sleep] TASKS_CONNECT failed:', err.message);
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message.type === 'TASKS_GET_LISTS') {
    getAuthToken(false)
      .then(token => tasksApi(token, 'GET', '/users/@me/lists'))
      .then(data => sendResponse({ ok: true, lists: data.items || [] }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'TASKS_DISCONNECT') {
    getAuthToken(false)
      .then(removeCachedAuthToken)
      .then(() => storageRemove([
        'ccListId',
        'creativeListId',
        'ccListTitle',
        'creativeListTitle',
        BRIEF_TASK_LINKS_KEY,
        LAST_TASK_STATUS_KEY
      ]))
      .then(() => sendResponse({ ok: true }))
      .catch(() => storageRemove([
        'ccListId',
        'creativeListId',
        'ccListTitle',
        'creativeListTitle',
        BRIEF_TASK_LINKS_KEY,
        LAST_TASK_STATUS_KEY
      ]).then(() => sendResponse({ ok: true })));
    return true;
  }

  if (message.type === 'TASKS_IS_CONNECTED') {
    getAuthToken(false)
      .then(token => sendResponse({ ok: true, connected: !!token }))
      .catch(() => sendResponse({ ok: true, connected: false }));
    return true;
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
