# DeepMeta Never Sleep — Project Diary

## 2026-11-10 — v1.15.3: Stable like/unlike toggling; search restore + uploads on renamed APIs

### Like/unlike "unstable" (user report on 1.15.2)
Root causes in `briefs-calendar.js`:
1. Page-side de-dup keyed `action:espId` for 30s — the second *like* in like → unlike → like was silently dropped (no log).
2. Quick like → unlike before DeepMeta answered left both actions pending; net site state unchanged, so both timed out after 10s with false errors.
3. Diffs compared against the previous response of *any* list URL, so switching filters/pages could be read as a like.
Fix: de-dup only repeats of the same state per espId; opposite pending actions on the same article (title+deadline) cancel out (list and detail view); diffs only between responses of the same list URL; article→espId learned from resolved actions so later toggles resolve directly; diff assignment only when unambiguous (1 waiting ↔ 1 changed id). 7 new tests (5 fail on 1.15.2).

### Restore search results broken
`scroll-restore.js` intercepted only `/api/dm-batches`. Assuming the same rename as briefs (`/api/v1/dm/batches`) — **unverified, awaiting Network-tab confirmation**. Both spellings now accepted.

### Upload detection (keep-awake)
`background.js` matched only `/api/dm-initialize-upload|authorize-upload-chunk|finalize-upload`. Widened to also accept `/api/v1/dm/<same>` — **also unverified**.

## 2026-11-10 — v1.15.2: Briefs API moved to /api/v1/dm/briefs

### Symptom
List-view like logged the click but never `Brief liked: …`; no Google Task created even with Google Tasks connected. Unlike likewise never removed anything.

### Cause
DeepMeta renamed the briefs list endpoint `/api/dm-briefs` → `/api/v1/dm/briefs`. The fetch hook matched only the old path, so the liked-set snapshot, the post-click diff and the explicit rechecks (`lastBriefsUrl`) never ran. Confirmed via console capture: like = `PUT /api/v1/cz/likes/{uuid}` `{"rating":100}` (internal UUID, not espId), followed by `GET /api/v1/dm/briefs?...` where the new espId shows `rating:100`. Live items are `{ espId, rating, lastViewedAt, totalCount }` — no title, so matching relies on the diff fallback.

### Fix
`BRIEFS_API_RE` matches both paths and excludes sub-routes like `/api/v1/dm/briefs/interest-sync` (polled ~5s). Tests now default to the live URL and cover the title-less payload, the legacy path and ignored sub-routes.

## 2026-06-02 — v1.10.0: Detail page like detection

### Problem
briefs-calendar.js only handled like clicks from the **brief list** view. When a user opened a brief detail page and clicked Like there, nothing happened — no Google Task was created.

### DOM analysis (detail page)
- Like button: `button[title="Like / Remove like"]` (different from list: `button[title="Like"]`)
- Liked state: `svg[fill="currentColor"][fill-opacity="0.5"]` — same pattern as list
- CC badge: `[class*="fuchsia"]` — same selector works
- Title: `header h1`
- Deadline: `time[datetime]` attribute
- espId: directly in URL → `window.location.pathname.split('/').pop()`

### Solution
Added `extractDetailData()` helper and split `onDocumentClick` into two branches:
1. **List view** (`button[title="Like"]`) — unchanged snapshot/diff flow via `/api/dm-briefs`
2. **Detail view** (`button[title="Like / Remove like"]`) — espId from URL, calls `dispatchLike` directly, no diff needed

Manifest `matches: "...briefs*"` already covers detail page URLs — no manifest change required.
