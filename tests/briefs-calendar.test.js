const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'briefs-calendar.js'),
  'utf8'
);

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    clone() { return response(payload, status); },
    async json() { return payload; }
  };
}

function article(title, deadline, isCc = true, code = '') {
  const values = {
    h3: { textContent: title },
    'time[datetime]': { getAttribute: () => deadline },
    '[class*="fuchsia"]': isCc ? {} : null,
    'img[alt]': { getAttribute: () => code }
  };
  return { querySelector(selector) { return values[selector] || null; } };
}

function likeEvent(articleNode, isLiked = false) {
  const svg = { getAttribute: () => isLiked ? 'currentColor' : 'none' };
  const button = {
    querySelector(selector) { return selector === 'svg' ? svg : null; },
    closest(selector) { return selector === 'article' ? articleNode : null; }
  };
  return {
    target: {
      closest(selector) {
        return selector === 'button[title="Like"]' ? button : null;
      }
    }
  };
}

const BRIEFS_URL =
  '/api/v1/dm/briefs?rf=511&uiModelRequirements=7&uiCc=1&uiLikes=6&uiAssetTypes=3&sort=0&descending=false&search=';

function createHarness(initialPayload) {
  const documentListeners = {};
  const windowListeners = {};
  const timers = [];
  const messages = [];
  let payload = initialPayload;
  const fetchCalls = [];

  async function originalFetch(url, options = {}) {
    fetchCalls.push({ url, options });
    return response(payload);
  }

  const window = {
    fetch: originalFetch,
    location: { pathname: '/contribute/esp/briefs' },
    setTimeout(callback, delay) {
      timers.push({ callback, delay, ran: false });
      return timers.length;
    },
    postMessage(message) { messages.push(message); },
    addEventListener(type, callback) { windowListeners[type] = callback; }
  };
  const document = {
    addEventListener(type, callback) { documentListeners[type] = callback; },
    querySelector() { return null; }
  };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Date,
    Error,
    Map,
    Promise,
    Set,
    String,
    document,
    location: { origin: 'https://deepmeta.creativ.zone' },
    window
  });
  vm.runInContext(source, context);

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
  }

  return {
    fetchCalls,
    messages,
    setPayload(value) { payload = value; },
    // Default to the live endpoint DeepMeta uses since Nov 2026
    async observePayload(url = BRIEFS_URL) {
      await window.fetch(url);
      await flush();
    },
    click(articleNode, isLiked = false) {
      documentListeners.click(likeEvent(articleNode, isLiked));
    },
    async runTimer(delay) {
      const timer = timers.find(item => item.delay === delay && !item.ran);
      assert.ok(timer, `Expected a ${delay}ms timer`);
      timer.ran = true;
      await timer.callback();
      await flush();
    }
  };
}

const deadline = '2026-08-02T23:59:59.999Z';

test('rechecks the briefs API when the site does not refetch after a like', async () => {
  const harness = createHarness([
    { espId: 'old-id', title: 'Old brief', rating: 100 },
    { espId: 'new-id', title: 'New brief', rating: 0 }
  ]);
  await harness.observePayload();

  harness.click(article('New brief', deadline, true));
  harness.setPayload([
    { espId: 'old-id', title: 'Old brief', rating: 100 },
    { espId: 'new-id', title: 'New brief', rating: 100 }
  ]);
  await harness.runTimer(500);

  const created = harness.messages.find(message => message.source === 'DMNS_BRIEF_LIKED');
  assert.ok(created);
  assert.equal(created.title, 'New brief');
  assert.match(created.espLink, /\/new-id$/);
  assert.equal(harness.fetchCalls.at(-1).options.cache, 'no-store');
});

test('keeps two quick list likes and matches both to their ESP IDs', async () => {
  const harness = createHarness([
    { espId: 'id-a', title: 'Brief A', rating: 0 },
    { espId: 'id-b', title: 'Brief B', rating: 0 }
  ]);
  await harness.observePayload();

  harness.click(article('Brief A', deadline, true, 'A'));
  harness.click(article('Brief B', deadline, false, 'B'));
  harness.setPayload([
    { espId: 'id-a', title: 'Brief A', code: 'A', rating: 100 },
    { espId: 'id-b', title: 'Brief B', code: 'B', rating: 100 }
  ]);
  await harness.observePayload();

  const created = harness.messages.filter(message => message.source === 'DMNS_BRIEF_LIKED');
  assert.equal(created.length, 2);
  assert.deepEqual(
    created.map(message => [message.title, message.espLink, message.isCc]),
    [
      ['Brief A', 'https://esp.gettyimages.com/contribute/briefs/detail/id-a', true],
      ['Brief B', 'https://esp.gettyimages.com/contribute/briefs/detail/id-b', false]
    ]
  );
});

test('reports a visible error if DeepMeta never confirms the like', async () => {
  const harness = createHarness([
    { espId: 'new-id', title: 'New brief', rating: 0 }
  ]);
  await harness.observePayload();

  harness.click(article('New brief', deadline));
  await harness.runTimer(10000);

  const failure = harness.messages.find(message => message.source === 'DMNS_BRIEF_STATUS');
  assert.equal(failure.status.state, 'error');
  assert.equal(failure.status.title, 'New brief');
  assert.match(failure.status.error, /did not confirm/);
});

test('dispatches an unlike only after the briefs API confirms it', async () => {
  const harness = createHarness([
    { espId: 'liked-id', title: 'Liked brief', rating: 100 }
  ]);
  await harness.observePayload();

  harness.click(article('Liked brief', deadline), true);
  assert.equal(
    harness.messages.some(message => message.source === 'DMNS_BRIEF_UNLIKED'),
    false
  );

  harness.setPayload([
    { espId: 'liked-id', title: 'Liked brief', rating: 0 }
  ]);
  await harness.observePayload();

  const removed = harness.messages.find(
    message => message.source === 'DMNS_BRIEF_UNLIKED'
  );
  assert.ok(removed);
  assert.equal(removed.title, 'Liked brief');
  assert.match(removed.espLink, /\/liked-id$/);
});

test('confirms removal of the last liked brief when the API list becomes empty', async () => {
  const harness = createHarness([
    { espId: 'last-id', title: 'Last liked brief', rating: 100 }
  ]);
  await harness.observePayload();

  harness.click(article('Last liked brief', deadline), true);
  harness.setPayload([]);
  await harness.observePayload();

  const removed = harness.messages.find(
    message => message.source === 'DMNS_BRIEF_UNLIKED'
  );
  assert.ok(removed);
  assert.match(removed.espLink, /\/last-id$/);
});

// Live API items carry no title: { espId, rating, lastViewedAt, totalCount }.
// Matching must fall back to the liked-set diff.
test('matches a like from the live /api/v1/dm/briefs payload shape (no titles)', async () => {
  const harness = createHarness([
    { espId: 'GIoGo', rating: 100, lastViewedAt: null, totalCount: 2 },
    { espId: 'GIRim', rating: null, lastViewedAt: null, totalCount: 2 }
  ]);
  await harness.observePayload();

  harness.click(article('Analog Hobbies', deadline, false));
  harness.setPayload([
    { espId: 'GIoGo', rating: 100, lastViewedAt: null, totalCount: 2 },
    { espId: 'GIRim', rating: 100, lastViewedAt: null, totalCount: 2 }
  ]);
  await harness.observePayload();

  const created = harness.messages.filter(message => message.source === 'DMNS_BRIEF_LIKED');
  assert.equal(created.length, 1);
  assert.equal(created[0].title, 'Analog Hobbies');
  assert.match(created[0].espLink, /\/GIRim$/);
});

test('still tracks the legacy /api/dm-briefs endpoint', async () => {
  const harness = createHarness([{ espId: 'id-x', rating: 0 }]);
  await harness.observePayload('/api/dm-briefs?uiLikes=6');

  harness.click(article('Brief X', deadline));
  harness.setPayload([{ espId: 'id-x', rating: 100 }]);
  await harness.observePayload('/api/dm-briefs?uiLikes=6');

  assert.ok(harness.messages.some(message => message.source === 'DMNS_BRIEF_LIKED'));
});

test('ignores briefs sub-routes such as interest-sync and unrelated APIs', async () => {
  const harness = createHarness([{ espId: 'id-y', rating: 0 }]);
  await harness.observePayload();

  harness.click(article('Brief Y', deadline));
  // A matching liked-set change arriving on the wrong URLs must not dispatch
  harness.setPayload([{ espId: 'id-y', rating: 100 }]);
  await harness.observePayload('/api/v1/dm/briefs/interest-sync');
  await harness.observePayload('/api/v1/cz/likes/019f43d1');

  assert.equal(
    harness.messages.some(message => message.source === 'DMNS_BRIEF_LIKED'),
    false
  );
});

// --- Toggle sequences on the same brief (live payload: no titles) ---

function dispatched(harness) {
  return harness.messages
    .filter(m => m.source === 'DMNS_BRIEF_LIKED' || m.source === 'DMNS_BRIEF_UNLIKED')
    .map(m => `${m.source === 'DMNS_BRIEF_LIKED' ? 'like' : 'unlike'}:${m.espLink.split('/').pop()}`);
}

function errors(harness) {
  return harness.messages.filter(m => m.source === 'DMNS_BRIEF_STATUS');
}

test('like → unlike → like on the same brief dispatches all three (no 30s suppression)', async () => {
  const brief = article('Toggle brief', deadline, false);
  const off = [{ espId: 'T1', rating: null }, { espId: 'Z9', rating: 100 }];
  const on = [{ espId: 'T1', rating: 100 }, { espId: 'Z9', rating: 100 }];
  const harness = createHarness(off);
  await harness.observePayload();

  harness.click(brief, false);
  harness.setPayload(on);
  await harness.observePayload();

  harness.click(brief, true);
  harness.setPayload(off);
  await harness.observePayload();

  harness.click(brief, false);
  harness.setPayload(on);
  await harness.observePayload();

  assert.deepEqual(dispatched(harness), ['like:T1', 'unlike:T1', 'like:T1']);
  assert.equal(errors(harness).length, 0);
});

test('like then unlike before DeepMeta answers cancels out: no task, no error', async () => {
  const brief = article('Quick toggle', deadline, false);
  const off = [{ espId: 'Q1', rating: null }];
  const harness = createHarness(off);
  await harness.observePayload();

  harness.click(brief, false);
  harness.click(brief, true);
  await harness.observePayload(); // site state is back to "not liked"
  await harness.runTimer(10000);

  assert.deepEqual(dispatched(harness), []);
  assert.equal(errors(harness).length, 0);
});

test('like → unlike → like faster than DeepMeta answers ends with one like', async () => {
  const brief = article('Triple toggle', deadline, false);
  const harness = createHarness([{ espId: 'R1', rating: null }]);
  await harness.observePayload();

  harness.click(brief, false);
  harness.click(brief, true);
  harness.click(brief, false);
  harness.setPayload([{ espId: 'R1', rating: 100 }]);
  await harness.observePayload();
  await harness.runTimer(10000);

  assert.deepEqual(dispatched(harness), ['like:R1']);
  assert.equal(errors(harness).length, 0);
});

test('unlike clicked right after a confirmed like resolves (stale snapshot case)', async () => {
  const brief = article('Stale snapshot', deadline, false);
  const harness = createHarness([{ espId: 'S1', rating: null }]);
  await harness.observePayload();

  harness.click(brief, false);
  harness.setPayload([{ espId: 'S1', rating: 100 }]);
  await harness.observePayload();
  harness.click(brief, true);
  // A refetch started before the unlike landed still shows it liked
  await harness.observePayload();
  harness.setPayload([{ espId: 'S1', rating: null }]);
  await harness.observePayload();

  assert.deepEqual(dispatched(harness), ['like:S1', 'unlike:S1']);
});

test('a duplicate confirmation of the same like is dispatched only once', async () => {
  const brief = article('Dup', deadline, false);
  const harness = createHarness([{ espId: 'D1', rating: null }]);
  await harness.observePayload();

  harness.click(brief, false);
  harness.setPayload([{ espId: 'D1', rating: 100 }]);
  await harness.observePayload();
  await harness.observePayload();
  await harness.runTimer(500);

  assert.deepEqual(dispatched(harness), ['like:D1']);
});

test('baseline comes from the same list URL: a different filter is not read as a like', async () => {
  const brief = article('Filter', deadline, false);
  const harness = createHarness([{ espId: 'F1', rating: null }, { espId: 'F2', rating: null }]);
  await harness.observePayload();

  harness.click(brief, false);
  // Liked-only filter view lists an older liked brief — not this click
  harness.setPayload([{ espId: 'OLD', rating: 100 }]);
  await harness.observePayload(BRIEFS_URL.replace('uiLikes=6', 'uiLikes=1'));
  assert.deepEqual(dispatched(harness), []);

  harness.setPayload([{ espId: 'F1', rating: 100 }, { espId: 'F2', rating: null }]);
  await harness.observePayload();
  assert.deepEqual(dispatched(harness), ['like:F1']);
});

// --- Detail page ---

test('detail page: like → unlike → like (each confirmed) dispatches all three', async () => {
  const h = createDetailHarness('DET1');
  h.click();            // like
  h.setLiked(true);  await h.runAllTimers();
  h.click();            // unlike
  h.setLiked(false); await h.runAllTimers();
  h.click();            // like
  h.setLiked(true);  await h.runAllTimers();
  assert.deepEqual(dispatched(h), ['like:DET1', 'unlike:DET1', 'like:DET1']);
  assert.equal(errors(h).length, 0);
});

test('detail page: quick like → unlike cancels out with no error', async () => {
  const h = createDetailHarness('DET2');
  h.click();            // like
  h.setLiked(true);
  h.click();            // unlike before confirmation
  h.setLiked(false);
  await h.runAllTimers();
  assert.deepEqual(dispatched(h), []);
  assert.equal(errors(h).length, 0);
});

function createDetailHarness(espId) {
  let liked = false;
  let listener;
  const timers = [];
  const messages = [];
  const svg = { getAttribute: () => liked ? 'currentColor' : 'none' };
  const button = { querySelector: sel => sel === 'svg' ? svg : null };
  const nodes = {
    'header h1': { textContent: 'Detail brief' },
    'time[datetime]': { getAttribute: () => deadline },
    '[class*="fuchsia"]': null
  };
  const window = {
    fetch: async () => response([]),
    location: { pathname: `/contribute/esp/briefs/detail/${espId}` },
    setTimeout(callback, delay) { timers.push({ callback, delay, ran: false }); return timers.length; },
    postMessage(message) { messages.push(message); },
    addEventListener() {}
  };
  const document = {
    addEventListener(type, callback) { if (type === 'click') listener = callback; },
    querySelector: sel => nodes[sel] ?? null
  };
  vm.runInContext(source, vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Date, Error, Map, Promise, Set, String, document,
    location: { origin: 'https://deepmeta.creativ.zone' }, window
  }));
  return {
    messages,
    setLiked(value) { liked = value; },
    click() {
      listener({ target: { closest: sel => sel === 'button[title="Like / Remove like"]' ? button : null } });
    },
    async runAllTimers() {
      for (let i = 0; i < 20; i++) {
        const timer = timers.find(t => !t.ran);
        if (!timer) break;
        timer.ran = true;
        await timer.callback();
      }
    }
  };
}
