const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const backgroundSource = fs.readFileSync(
  path.join(__dirname, '..', 'background.js'),
  'utf8'
);

function jsonResponse(status, data = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => data
  };
}

function createHarness(initialStorage = {}, tokens = ['token']) {
  const storage = { ...initialStorage };
  const fetchCalls = [];
  const removedTokens = [];
  let fetchHandler = async () => jsonResponse(500);
  let tokenIndex = 0;

  const event = { addListener() {} };
  const chrome = {
    action: {
      setIcon() {},
      setTitle() {}
    },
    alarms: {
      clear() {},
      create() {},
      get(_name, callback) { callback(undefined); },
      onAlarm: event
    },
    identity: {
      getAuthToken(_options, callback) {
        const token = tokens[Math.min(tokenIndex, tokens.length - 1)];
        tokenIndex += 1;
        callback(token);
      },
      removeCachedAuthToken({ token }, callback) {
        removedTokens.push(token);
        callback();
      }
    },
    power: {
      releaseKeepAwake() {},
      requestKeepAwake() {}
    },
    runtime: {
      lastError: null,
      onInstalled: event,
      onMessage: event,
      onStartup: event
    },
    storage: {
      local: {
        get(defaults, callback) { callback({ ...defaults, ...storage }); },
        set(values, callback) {
          Object.assign(storage, values);
          if (callback) callback();
        },
        remove(keys, callback) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
          if (callback) callback();
        }
      },
      onChanged: event
    },
    tabs: {
      onRemoved: event,
      query: async () => []
    },
    webRequest: {
      onBeforeRequest: event,
      onCompleted: event,
      onErrorOccurred: event
    }
  };

  const context = vm.createContext({
    chrome,
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return fetchHandler(url, options);
    },
    setTimeout,
    clearTimeout,
    URL,
    Date,
    Error,
    Map,
    Set,
    Promise
  });

  vm.runInContext(
    `${backgroundSource}\n;globalThis.__taskTest = { handleBriefLiked, handleBriefUnliked, enqueueBriefTaskOperation };`,
    context
  );

  return {
    api: context.__taskTest,
    fetchCalls,
    removedTokens,
    setFetch(handler) { fetchHandler = handler; },
    storage
  };
}

const brief = {
  title: 'Test CC brief',
  dueDate: '2026-08-02T23:59:59.999Z',
  espLink: 'https://esp.gettyimages.com/contribute/briefs/detail/test-id',
  isCc: true
};

test('creates a task in the selected list and records visible success status', async () => {
  const harness = createHarness({
    ccListId: 'selected-list',
    ccListTitle: 'My CC Queue'
  });
  harness.setFetch(async () => jsonResponse(200, { id: 'task-1' }));

  const result = await harness.api.handleBriefLiked(brief);

  assert.equal(result.listName, 'My CC Queue');
  assert.equal(result.deduped, false);
  assert.equal(harness.fetchCalls.length, 1);
  assert.match(harness.fetchCalls[0].url, /\/lists\/selected-list\/tasks$/);
  assert.equal(harness.storage.lastTaskStatus.state, 'success');
  assert.equal(harness.storage.lastTaskStatus.title, brief.title);
});

test('removes a rejected cached token and retries once with a fresh token', async () => {
  const harness = createHarness({ ccListId: 'selected-list' }, ['old-token', 'fresh-token']);
  harness.setFetch(async (_url, options) => {
    if (options.headers.Authorization === 'Bearer old-token') return jsonResponse(401);
    return jsonResponse(200, { id: 'task-1' });
  });

  await harness.api.handleBriefLiked(brief);

  assert.deepEqual(harness.removedTokens, ['old-token']);
  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(
    harness.fetchCalls[1].options.headers.Authorization,
    'Bearer fresh-token'
  );
});

test('shows an explicit reconnect message when refreshed authorization is also rejected', async () => {
  const harness = createHarness({ ccListId: 'selected-list' }, ['old-token', 'rejected-token']);
  harness.setFetch(async () => jsonResponse(401));

  await assert.rejects(
    harness.api.handleBriefLiked(brief),
    /authorization expired.*reconnect Google Tasks/i
  );

  assert.deepEqual(harness.removedTokens, ['old-token']);
  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(harness.storage.lastTaskStatus.state, 'error');
  assert.match(
    harness.storage.lastTaskStatus.error,
    /authorization expired.*reconnect Google Tasks/i
  );
});

test('recovers from a deleted stored list and retries in the default list', async () => {
  const harness = createHarness({
    ccListId: 'deleted-list',
    ccListTitle: 'Deleted list'
  });
  let call = 0;
  harness.setFetch(async () => {
    call += 1;
    if (call === 1) return jsonResponse(404);
    if (call === 2) {
      return jsonResponse(200, { items: [{ id: 'cc-default', title: 'CC Briefs' }] });
    }
    return jsonResponse(200, { id: 'task-1' });
  });

  const result = await harness.api.handleBriefLiked(brief);

  assert.equal(result.listName, 'CC Briefs');
  assert.equal(harness.storage.ccListId, 'cc-default');
  assert.equal(harness.storage.ccListTitle, 'CC Briefs');
  assert.equal(harness.fetchCalls.length, 3);
  assert.match(harness.fetchCalls[2].url, /\/lists\/cc-default\/tasks$/);
});

test('suppresses duplicate messages for the same brief within the safety window', async () => {
  const harness = createHarness({ ccListId: 'selected-list' });
  harness.setFetch(async () => jsonResponse(200, { id: 'task-1' }));

  await harness.api.handleBriefLiked(brief);
  const duplicate = await harness.api.handleBriefLiked(brief);

  assert.equal(duplicate.deduped, true);
  assert.equal(harness.fetchCalls.length, 1);
});

test('deletes only the task previously linked to the unliked brief', async () => {
  const harness = createHarness({
    briefTaskLinks: {
      [brief.espLink]: {
        taskId: 'task-1',
        listId: 'selected-list',
        listName: 'My CC Queue',
        title: brief.title
      }
    }
  });
  harness.setFetch(async () => jsonResponse(204));

  const result = await harness.api.handleBriefUnliked(brief);

  assert.equal(result.deleted, true);
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.fetchCalls[0].options.method, 'DELETE');
  assert.match(harness.fetchCalls[0].url, /\/lists\/selected-list\/tasks\/task-1$/);
  assert.equal(harness.storage.briefTaskLinks[brief.espLink], undefined);
  assert.equal(harness.storage.lastTaskStatus.action, 'deleted');
});

test('does not delete an unrelated task when no extension-created link exists', async () => {
  const harness = createHarness();
  harness.setFetch(async () => jsonResponse(500));

  const result = await harness.api.handleBriefUnliked(brief);

  assert.equal(result.deleted, false);
  assert.equal(result.notFound, true);
  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(harness.storage.lastTaskStatus.action, 'not-found');
});

test('treats an already deleted linked task as successfully removed', async () => {
  const harness = createHarness({
    briefTaskLinks: {
      [brief.espLink]: {
        taskId: 'missing-task',
        listId: 'selected-list',
        listName: 'My CC Queue'
      }
    }
  });
  harness.setFetch(async () => jsonResponse(404));

  const result = await harness.api.handleBriefUnliked(brief);

  assert.equal(result.deleted, true);
  assert.equal(harness.storage.briefTaskLinks[brief.espLink], undefined);
  assert.equal(harness.storage.lastTaskStatus.state, 'success');
});

test('serializes a rapid like then unlike so the newly created task is deleted', async () => {
  const harness = createHarness({
    ccListId: 'selected-list',
    ccListTitle: 'My CC Queue'
  });
  let releaseCreation;
  harness.setFetch(async (_url, options) => {
    if (options.method === 'POST') {
      return new Promise(resolve => { releaseCreation = () => resolve(jsonResponse(200, { id: 'task-1' })); });
    }
    if (options.method === 'DELETE') return jsonResponse(204);
    return jsonResponse(500);
  });

  const creation = harness.api.enqueueBriefTaskOperation(
    () => harness.api.handleBriefLiked(brief)
  );
  const removal = harness.api.enqueueBriefTaskOperation(
    () => harness.api.handleBriefUnliked(brief)
  );

  while (!releaseCreation) await Promise.resolve();
  assert.equal(harness.fetchCalls.length, 1);
  releaseCreation();
  await Promise.all([creation, removal]);

  assert.deepEqual(
    harness.fetchCalls.map(call => call.options.method),
    ['POST', 'DELETE']
  );
  assert.equal(harness.storage.briefTaskLinks[brief.espLink], undefined);
  assert.equal(harness.storage.lastTaskStatus.action, 'deleted');
});
