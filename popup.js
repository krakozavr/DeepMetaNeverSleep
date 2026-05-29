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
