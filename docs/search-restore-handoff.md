# DeepMeta batch search restore: implementation handoff

Date: 2026-05-29

Release state: `manifest.json` version `1.8.19`.

Primary file: `scroll-restore.js`.

Related files:

- `manifest.json`: registers `scroll-restore.js` in the page `MAIN` world and exposes extension permissions.
- `content.js`: bridges extension settings from `chrome.storage.local` into the page via `window.postMessage`.
- `popup.html`, `popup.js`, `popup.css`: settings UI for the three independently switchable features.
- `background.js`: upload detection and power-management feature, controlled by the settings UI.

## Original project state

The project started as a local Chromium extension named "DeepMeta Never Sleep".

Original purpose:

- detect active DeepMeta upload requests;
- keep the computer awake while uploads are active;
- release the power lock when uploads finish;
- work entirely locally on `https://deepmeta.creativ.zone/*`.

Before this development pass, the extension already had a separate `scroll-restore.js` feature for the DeepMeta batch list:

- when the user opened a batch from `/contribute/esp/batches`;
- then returned from `/contribute/esp/uploads?...`;
- the extension revealed the previously opened batch in the list;
- the feature relied on a deterministic batch id / thumbnail match;
- it used smooth scrolling because instant jumps broke DeepMeta's lazy-loaded per-row UI indicators;
- it asserted the row highlight for a short hold window to avoid DeepMeta's stale active-row preference.

That position-restore behavior was considered correct and stable by the user. A key constraint during this work was: do not damage the existing position restore.

## Requested feature

The user wanted the existing position restore feature extended to preserve a search-filtered batch list.

User-visible failure before the feature:

1. User searches in the batch list, for example `nevada`.
2. DeepMeta shows a filtered list.
3. User opens a batch from that filtered list.
4. User exits back to batches.
5. DeepMeta resets the search and loads the full list.
6. The existing position restore then scrolls the full list to the opened batch.

Desired behavior:

1. User searches `nevada`.
2. User opens any batch from the filtered list.
3. On return, the list is still the `nevada` filtered list.
4. The opened batch is revealed inside that filtered list.
5. User may repeat this across multiple batches without losing the filter.
6. If the user manually clears the search, the filter must clear for real.

Explicit scope:

- preserve only the textual `search` value;
- do not preserve sort order or other filters yet;
- preserve the existing batch position restore behavior;
- add settings toggles for:
  - preventing sleep during active uploads;
  - restoring search results;
  - restoring batch position.

## DeepMeta behavior observed in clean logs

The clean Firefox logs showed that the batch list is loaded with:

```text
https://deepmeta.creativ.zone/api/dm-batches?sort=0&descending=true&search=nevada&uiAssetTypes=7&uiBatchStatus=3&pageSize=25&page=1
https://deepmeta.creativ.zone/api/dm-batches?sort=0&descending=true&search=nevada&uiAssetTypes=7&uiBatchStatus=3&pageSize=25&page=2
```

Manual clear in clean DeepMeta sends an empty search:

```text
https://deepmeta.creativ.zone/api/dm-batches?sort=0&descending=true&search=&uiAssetTypes=7&uiBatchStatus=3&pageSize=25&page=7
```

Deleting text manually and pressing Enter also sends an empty search:

```text
https://deepmeta.creativ.zone/api/dm-batches?sort=0&descending=true&search=&uiAssetTypes=7&uiBatchStatus=3&pageSize=25&page=9
```

Important inference:

- DeepMeta's automatic reset when returning from a batch and the user's manual clear both appear as `search=` network requests.
- They cannot be distinguished by URL alone.
- They must be distinguished by surrounding user events and navigation state.

## Final architecture

The final implementation is conservative and event-driven.

### Search state variables

`scroll-restore.js` maintains:

- `currentSearch`: the latest known user/search API search value.
- `pendingOpenSearch`: a snapshot taken when a batch link is clicked.
- `returnSearch`: the search value to restore when returning from uploads.
- `returnSearchPhase`: state machine:
  - `idle`: no restore active;
  - `armed`: user left batches for uploads with a search snapshot;
  - `returning`: user is back on batches and empty list requests may be rewritten.
- `returnSearchLastPage`: diagnostic page number for restore logs.
- `restoredSearchOnPage`: true when the current list has been restored by our API rewrite.
- `restoredSearchDisplayValue`: the value to display in the search input after API-level restore.
- `userSearchIntentPending`: set when a trusted user event indicates the user is interacting with the search control.

### Navigation state

The feature watches path transitions passively:

- `batches -> uploads`: snapshot the visible/current search and arm restore.
- `uploads -> batches`: begin return restore and run existing batch reveal.
- `batches -> other`: clear restore state.
- `uploads -> other`: clear restore state.

The code still avoids touching the History API.

### Network interception

`scroll-restore.js` runs in the page `MAIN` world and wraps:

- `window.fetch`;
- `XMLHttpRequest.prototype.open`.

Only same-origin `/api/dm-batches` URLs are considered.

When `returnSearchPhase === "returning"` and DeepMeta requests an empty `search=`, the URL is rewritten:

```text
search=       -> search=nevada
```

Log example:

```text
[DeepMeta Never Sleep][ScrollRestore] Armed search restore on return (api): "nevada"
[DeepMeta Never Sleep][ScrollRestore] Restoring batch search: "nevada" page=1
[DeepMeta Never Sleep][ScrollRestore] Restoring batch search: "nevada" page=2
```

This is the core feature.

### Search input observation

The extension observes trusted user input events on the search control:

- `pointerdown`;
- `mousedown`;
- `keydown`;
- `beforeinput`;
- `input`;
- `change`;
- `search`.

The handlers do not synthesize user intent. Their purpose is:

- update `currentSearch` when the user types;
- disarm search restore when the user explicitly interacts with the search field;
- detect manual clear actions before an empty `search=` request can be rewritten;
- allow the user to start a new search after restored-search mode.

### Display-only input synchronization

The final implementation intentionally does not update DeepMeta's internal React state.

Instead, when the filtered list is restored by network rewriting, the extension updates only the visible input value:

```text
[DeepMeta Never Sleep][ScrollRestore] Synced restored search display: "nevada"
```

This keeps the UI honest: the list is filtered by `nevada`, and the field visibly says `nevada`.

No synthetic `input`, `change`, `search`, or keyboard events are sent during this display sync.

### Restored-search clear button

Because the input display is only a DOM-level value, DeepMeta's React state may still believe the field is empty. In that state DeepMeta does not render its native clear button.

Final fix:

- if `restoredSearchOnPage` is true;
- and the search input shows a restored value;
- and DeepMeta has not rendered a native clear button;
- inject a small fallback clear button into the search input wrapper.

Log:

```text
[DeepMeta Never Sleep][ScrollRestore] Added restored search clear button
```

Clicking the fallback button:

- clears extension restore state;
- reloads the batches page;
- lets DeepMeta rebuild the default full list from its own normal state.

Logs:

```text
[DeepMeta Never Sleep][ScrollRestore] User cleared batch search
[DeepMeta Never Sleep][ScrollRestore] Cleared restored search page: restored clear button
[DeepMeta Never Sleep][ScrollRestore] Reloading batches after restored search clear
```

The same reload reset is also used when the user clicks the invisible/right-side native clear zone after a restored search:

```text
[DeepMeta Never Sleep][ScrollRestore] User cleared batch search
[DeepMeta Never Sleep][ScrollRestore] Cleared restored search page: user clear click
[DeepMeta Never Sleep][ScrollRestore] Reloading batches after restored search clear
```

This is deliberately narrow: it applies only after a search was restored by the extension.

## Existing position restore preserved

The final code keeps the original stable position-restore approach:

- primary row match by batch id / thumbnail;
- fallback to stable DeepMeta highlight only if needed;
- smooth scroll;
- scroll at most once;
- assert row highlight for approximately `HOLD_MS = 2500`;
- do not chase the row repeatedly while pages render.

Typical final logs:

```text
[DeepMeta Never Sleep][ScrollRestore] Return to batches - will reveal opened batchId=019e0b64-6b16-7af3-9519-ac034faee580
[DeepMeta Never Sleep][ScrollRestore] Found target row via thumbnail @3ms
[DeepMeta Never Sleep][ScrollRestore] Revealed + held highlight (2505ms)
```

Important invariant:

- do not replace the thumbnail/batch id match with row index or previous-highlight assumptions;
- do not remove smooth scroll;
- do not add repeated programmatic scroll chasing.

The user explicitly reported that the main-list position restore works correctly and must stay unchanged.

## Settings UI

The popup now exposes three independent toggles:

- `preventSleepActiveUploads`;
- `restoreSearchResults`;
- `restoreBatchPosition`.

`popup.js` persists values in `chrome.storage.local`.

`content.js` forwards settings into the page via:

```js
window.postMessage({
  source: 'DMNS_EXTENSION_SETTINGS',
  settings
}, location.origin);
```

`scroll-restore.js` requests settings with:

```js
window.postMessage({ source: 'DMNS_SETTINGS_REQUEST' }, location.origin);
```

If `restoreSearchResults` is disabled, search restore is cleared.

If `restoreBatchPosition` is disabled, in-flight reveal/highlight work is cancelled by bumping `generation`.

## Dead ends and rejected approaches

This section is intentionally detailed. These are the paths that should not be repeated without a strong new reason.

### Dead end: time-window restore

Early versions used a short restore window, for example "restore for 5 seconds after return".

The user challenged this correctly:

- search state is event-driven;
- user starts a search;
- user starts another search;
- user clears search;
- user leaves the batch section;
- no unrelated timer should expire or rewrite this meaning.

Decision:

- no time-based expiry for search state;
- state transitions are driven by navigation, search API calls, and trusted search input events.

### Dead end: clearing restore after first successful row reveal

One hypothesis was to disarm search restore after the target row was found.

This broke the expected workflow:

1. search `nevada`;
2. open batch 1;
3. return to filtered list;
4. open batch 2 from the same filtered list;
5. return to the same filtered list again.

The restored search must remain the current list context while the user keeps navigating from that filtered list.

Decision:

- do not disarm search restore just because the row was found;
- the next `batches -> uploads` transition snapshots the current/visible search again.

### Dead end: modifying position-restore fallback logic

During early fixes, changes around filtered lists affected the existing position restore:

- smooth scroll disappeared;
- the old "one step behind" problem returned;
- filtered-list positioning became inconsistent.

The user clarified that:

- batch id is a reliable unique identifier;
- position restore after search had already worked when search restore itself was correct;
- the problem was search state drift, not row identity.

Decision:

- keep deterministic batch-id / thumbnail matching;
- do not replace it with broad fallback logic;
- keep scroll-once and smooth behavior.

### Dead end: relying on `/api/dm-batches` alone to update current search

The first implementation remembered search only from `/api/dm-batches` requests.

Observed failure:

1. search `livestock`;
2. open/return works;
3. change search to `wyoming` without full reset;
4. open/return goes back to `livestock`.

Representative logs:

```text
[DeepMeta Never Sleep][ScrollRestore] Remembered batch search: "livestock"
[DeepMeta Never Sleep][ScrollRestore] Restoring batch search: "livestock" page=1
```

Decision:

- treat the real search input as an important source of truth;
- update `currentSearch` on trusted `input` / `change` / `search`;
- snapshot `pendingOpenSearch` from the visible input when opening a batch.

### Dead end: synthetic clear events

Several attempts tried to make manual clear work by programmatically dispatching:

- `input`;
- `change`;
- `search`;
- synthetic Enter key events.

Representative log from a broken attempt:

```text
[DeepMeta Never Sleep][ScrollRestore] Disarmed search restore: search input intent
[DeepMeta Never Sleep][ScrollRestore] Current batch search (clear intent): ""
[DeepMeta Never Sleep][ScrollRestore] Forced search clear after click
```

Problem:

- synthetic events are not trusted;
- DeepMeta/React may ignore them or treat them differently;
- dispatching events on `pointerdown` could run before DeepMeta's own click handler;
- this risks interfering with the native clear control.

Decision:

- do not synthesize clear behavior;
- user clear only disarms extension restore state;
- for restored-search clear, do a full batches reload instead of pretending to be the app.

### Dead end: forcing input clear too early

One version cleared the input on `pointerdown` when the click looked like it hit the clear zone.

Likely failure mode:

- extension clears the DOM field first;
- DeepMeta's later click handler sees an already-empty field;
- no real empty search request is sent.

Decision:

- early events may observe and disarm restore;
- they must not mutate the field as if they were DeepMeta.

### Dead end: assuming display value equals React state

After the API rewrite restored the list, setting the input DOM value to `nevada` made the UI look almost correct.

But DeepMeta's own clear button disappeared:

```html
<button type="button" class="absolute inset-0 start-auto">...</button>
```

The button is apparently rendered from DeepMeta's internal React search state. Because the extension did not update React state, DeepMeta could believe the search value was empty even while the DOM input displayed `nevada`.

Observed final diagnostic logs:

```text
[DeepMeta Never Sleep][ScrollRestore] Synced restored search display: "nevada"
[DeepMeta Never Sleep][ScrollRestore] Restoring batch search: "nevada" page=1
```

Decision:

- accept that API-level restore and DeepMeta's React search state are not the same thing;
- keep display-only sync to avoid synthetic-event side effects;
- inject a fallback clear button only when the native clear button is missing.

### Dead end: trying to preserve full React search state

Theoretically, the ideal solution would update DeepMeta's own state as if the user had searched `nevada`.

Rejected for this release because:

- DeepMeta is a compiled third-party app;
- reliable internal state APIs are not exposed;
- synthetic events are unreliable and caused regressions;
- network-level restore is stable and scoped;
- fallback clear button + reload gives a predictable escape path.

Decision:

- do not reverse-engineer private React internals in this release.

## Important log sequences

### Correct restore from filtered list

From `C:\tmp\deepmeta.creativ.zone-1780083753753.log`:

```text
[DeepMeta Never Sleep][ScrollRestore] Current batch search (input): "nevada"
[DeepMeta Never Sleep][ScrollRestore] Remembered batch search: "nevada"
[DeepMeta Never Sleep][ScrollRestore] Armed search restore on return (api): "nevada"
[DeepMeta Never Sleep][ScrollRestore] Synced restored search display: "nevada"
[DeepMeta Never Sleep][ScrollRestore] Restoring batch search: "nevada" page=1
[DeepMeta Never Sleep][ScrollRestore] Return to batches - will reveal opened batchId=019e0b64-6b16-7af3-9519-ac034faee580
[DeepMeta Never Sleep][ScrollRestore] Found target row via thumbnail @-1ms
[DeepMeta Never Sleep][ScrollRestore] Restoring batch search: "nevada" page=2
```

### Correct clear after restored search

From the same log:

```text
[DeepMeta Never Sleep][ScrollRestore] Disarmed search restore: search input intent
[DeepMeta Never Sleep][ScrollRestore] Current batch search (clear intent): ""
[DeepMeta Never Sleep][ScrollRestore] User cleared batch search
[DeepMeta Never Sleep][ScrollRestore] Cleared restored search page: user clear click
[DeepMeta Never Sleep][ScrollRestore] Reloading batches after restored search clear
[DeepMeta Never Sleep][ScrollRestore] Active-row reveal active (MAIN world, v1.8.18 - scroll once + smooth, assert highlight ~2.5s)
```

### Final expected clear-button fallback

In `1.8.19`, when DeepMeta does not render its native clear button, expect:

```text
[DeepMeta Never Sleep][ScrollRestore] Added restored search clear button
```

Then clicking that fallback button should produce:

```text
[DeepMeta Never Sleep][ScrollRestore] User cleared batch search
[DeepMeta Never Sleep][ScrollRestore] Cleared restored search page: restored clear button
[DeepMeta Never Sleep][ScrollRestore] Reloading batches after restored search clear
```

## Test plan for the release

Before testing:

1. Reload the unpacked extension.
2. Fully reload or reopen the DeepMeta tab.
3. Confirm the console contains:

```text
[DeepMeta Never Sleep][ScrollRestore] Active-row reveal active (MAIN world, v1.8.19 - scroll once + smooth, assert highlight ~2.5s)
```

### Scenario 1: basic filtered restore

Steps:

1. Search `nevada`.
2. Open a batch from the filtered results.
3. Return to batches.

Expected:

- filtered list is still `nevada`;
- input visibly shows `nevada`;
- opened batch is revealed and highlighted;
- logs include `Restoring batch search: "nevada"`.

### Scenario 2: multiple batches in same filtered list

Steps:

1. Search `nevada`.
2. Open batch 1.
3. Return.
4. Open batch 2 without clearing search.
5. Return.

Expected:

- still returns to `nevada`, not a stale older search;
- no "one step behind" batch selection;
- row reveal still uses the opened batch id.

### Scenario 3: change search without full reset

Steps:

1. Search `nevada`.
2. Open/return.
3. Change search to another term, for example `wyoming`.
4. Open/return.

Expected:

- returns to `wyoming`;
- does not return to `nevada`;
- logs show `Current batch search (input): "wyoming"` and `Remembered batch search: "wyoming"`.

### Scenario 4: manual clear after restored search

Steps:

1. Search `nevada`.
2. Open/return.
3. Click the visible clear button.

Expected:

- if DeepMeta native clear is visible, user can click it;
- if native clear is not visible, extension fallback clear is visible;
- batches page reloads;
- full default list appears;
- old search does not reapply.

### Scenario 5: ordinary unfiltered position restore

Steps:

1. Start from full list, no search.
2. Open a batch.
3. Return.

Expected:

- original position restore behavior remains correct;
- no filtered-list rewrite occurs;
- no restored-search fallback clear button is injected.

### Scenario 6: settings toggles

Steps:

1. Disable `Restore search results`.
2. Repeat search/open/return.

Expected:

- DeepMeta behaves normally; search restore does not intervene.

Steps:

1. Disable `Restore batch position`.
2. Repeat open/return.

Expected:

- search restore may still happen if enabled;
- batch reveal/highlight does not run.

## Known limitations and acceptable tradeoffs

### React state mismatch is known

The extension restores search at the API layer. It does not fully restore DeepMeta's internal React state.

This is why the fallback clear button exists.

This is accepted for release because:

- it avoids fragile synthetic events;
- it keeps behavior predictable;
- manual clear has a reliable reset path;
- the visible field and list are consistent for the user.

### Clear reset reloads the batches page

When clearing a search restored by the extension, the implementation reloads `/contribute/esp/batches`.

This is deliberate:

- DeepMeta's own state may not know about the restored search;
- manually fetching `/api/dm-batches?search=` would not update React UI state;
- synthetic events were unreliable;
- a reload gives DeepMeta a clean default-list state.

### Highlight after leaving search

The user noticed that active batch highlight may remain after leaving search.

Current assessment:

- this is probably DeepMeta's active batch / preference state;
- it is not evidence that search restore is still active;
- it should be monitored only if it causes incorrect navigation or row reveal.

Do not treat this as a search restore bug without confirming logs show stale `Restoring batch search`.

## Future-extension notes

The planned follow-up may preserve more list state than textual search.

Before extending:

- keep textual search as an independent state dimension;
- do not mix sort/filter state into `currentSearch`;
- create explicit snapshots for each dimension;
- prefer event-derived state over timers;
- add separate diagnostics for each restored query parameter.

Potential future state object:

```js
{
  search: 'nevada',
  sort: '0',
  descending: 'true',
  uiAssetTypes: '7',
  uiBatchStatus: '3'
}
```

But do not implement this by blindly replaying a whole old URL:

- some query parameters are pagination-specific;
- page values should remain driven by DeepMeta's own pagination;
- stale `page` values could hide the target batch or skip initial list pages.

Recommended future approach:

1. Track explicit query dimensions from user events and `/api/dm-batches`.
2. Snapshot only stable dimensions when opening a batch.
3. On return, rewrite only the dimensions that are intentionally restored.
4. Keep page number controlled by the current DeepMeta request.
5. Keep independent user-intent detection for manual changes.

## Release verification commands

Run from the project root:

```powershell
node --check scroll-restore.js
node --check background.js
node --check content.js
node --check popup.js
python -m json.tool manifest.json
```

All commands passed for `1.8.19`.

## Reviewer checklist

When reviewing `scroll-restore.js`, focus on these invariants:

- Search restore only rewrites `/api/dm-batches`.
- Only empty `search=` requests are rewritten during `returning` phase.
- Trusted user interaction with the search control disarms restore.
- Manual clear after restored search reloads batches instead of dispatching synthetic events.
- The fallback clear button is injected only while `restoredSearchOnPage` is true and native clear is absent.
- Position restore still uses batch id / thumbnail identity and smooth scroll.
- Settings can disable search restore and position restore independently.

## Glossary

`currentSearch`: latest known search value from user input or API.

`pendingOpenSearch`: search snapshot taken from the input when a batch link is clicked.

`returnSearch`: search value that should be restored when coming back from uploads.

`returnSearchPhase`: search-restore state machine: `idle`, `armed`, `returning`.

`restoredSearchOnPage`: true when the visible list is currently filtered because the extension rewrote a DeepMeta request.

`restoredSearchDisplayValue`: value that the extension keeps visible in the input after API-level restore.

`userSearchIntentPending`: short-lived marker that a trusted user event happened in the search control before a matching API request arrives.

