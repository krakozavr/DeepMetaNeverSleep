const DEFAULT_SETTINGS = {
  preventSleepActiveUploads: true,
  restoreSearchResults: true,
  restoreBatchPosition: true
};

const settingIds = Object.keys(DEFAULT_SETTINGS);
const statusEl = document.getElementById('status');

function setStatus(text) {
  statusEl.textContent = text;
  window.clearTimeout(setStatus.timer);
  setStatus.timer = window.setTimeout(() => {
    statusEl.textContent = '';
  }, 1200);
}

function loadSettings() {
  chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
    for (const id of settingIds) {
      document.getElementById(id).checked = Boolean(stored[id]);
    }
  });
}

function saveSetting(id, value) {
  chrome.storage.local.set({ [id]: value }, () => {
    setStatus('Saved');
  });
}

for (const id of settingIds) {
  document.getElementById(id).addEventListener('change', (event) => {
    saveSetting(id, event.target.checked);
  });
}

loadSettings();

// --- Google Tasks ---

const elNotConnected = document.getElementById('tasksNotConnected');
const elConnected    = document.getElementById('tasksConnected');
const btnConnect     = document.getElementById('btnConnect');
const btnDisconnect  = document.getElementById('btnDisconnect');
const ccListSelect   = document.getElementById('ccListSelect');
const creativeSelect = document.getElementById('creativeListSelect');

function populateSelect(select, lists, savedId) {
  select.innerHTML = '<option value="">Select list…</option>';
  for (const list of lists) {
    const opt = document.createElement('option');
    opt.value = list.id;
    opt.textContent = list.title;
    select.appendChild(opt);
  }
  select.value = savedId || '';
}

function showConnected(lists, ccListId, creativeListId) {
  elNotConnected.hidden = true;
  elConnected.hidden = false;
  populateSelect(ccListSelect, lists, ccListId);
  populateSelect(creativeSelect, lists, creativeListId);
}

function showNotConnected() {
  elNotConnected.hidden = false;
  elConnected.hidden = true;
}

const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';

function fetchLists(token) {
  return fetch(`${TASKS_API}/users/@me/lists`, {
    headers: { 'Authorization': `Bearer ${token}` }
  }).then(r => r.json()).then(d => d.items || []);
}

function initTasksUi() {
  chrome.identity.getAuthToken({ interactive: false }, token => {
    if (chrome.runtime.lastError || !token) { showNotConnected(); return; }
    fetchLists(token)
      .then(lists => {
        chrome.storage.local.get({ ccListId: null, creativeListId: null }, stored => {
          showConnected(lists, stored.ccListId, stored.creativeListId);
        });
      })
      .catch(() => showNotConnected());
  });
}

btnConnect.addEventListener('click', () => {
  btnConnect.disabled = true;
  btnConnect.textContent = 'Connecting…';
  chrome.identity.getAuthToken({ interactive: true }, token => {
    btnConnect.disabled = false;
    btnConnect.textContent = 'Connect Google Account';
    if (chrome.runtime.lastError || !token) {
      setStatus('Failed: ' + (chrome.runtime.lastError?.message || 'unknown'));
      return;
    }
    fetchLists(token)
      .then(lists => {
        chrome.storage.local.get({ ccListId: null, creativeListId: null }, stored => {
          showConnected(lists, stored.ccListId, stored.creativeListId);
          setStatus('Connected');
        });
      })
      .catch(err => setStatus('Failed: ' + err.message));
  });
});

btnDisconnect.addEventListener('click', () => {
  chrome.identity.getAuthToken({ interactive: false }, token => {
    const finish = () => {
      chrome.storage.local.remove(['ccListId', 'creativeListId'], () => {
        showNotConnected();
        setStatus('Disconnected');
      });
    };
    if (token) {
      chrome.identity.removeCachedAuthToken({ token }, finish);
    } else {
      finish();
    }
  });
});

ccListSelect.addEventListener('change', () => {
  chrome.storage.local.set({ ccListId: ccListSelect.value || null });
  setStatus('Saved');
});

creativeSelect.addEventListener('change', () => {
  chrome.storage.local.set({ creativeListId: creativeSelect.value || null });
  setStatus('Saved');
});

initTasksUi();
