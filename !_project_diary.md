# DeepMeta Never Sleep — Project Diary

## 2026-11-09 — v1.11.0: Unlike removes the Google Task

- List view: clicking a filled heart sets `pendingUnlike`; the next briefs refetch is diffed for an espId that is still present but no longer `rating:100`. Only an unambiguous single change is dispatched (same rule now applies to likes).
- Detail view: espId from URL, dispatched immediately.
- Background `BRIEF_UNLIKED`: scans the stored CC/Creative list IDs plus any list titled "CC Briefs"/"Creative Briefs" (all pages, incl. completed/hidden), deletes tasks whose notes equal the ESP link. Never creates a list.
- `tasksApi` now tolerates empty 204 bodies (DELETE).

## 2026-11-07 — v1.10.1: Briefs API moved, list-view likes stopped creating tasks

### Symptom
List-view like logged `Like click: "…"` but never `Brief liked: …`; no Google Task created (Google connection itself was fine).

### Cause
DeepMeta renamed the briefs list endpoint `/api/dm-briefs` → `/api/v1/dm/briefs`. The fetch hook matched only the old path, so neither the baseline nor the post-like response was ever seen and the espId diff never ran. Confirmed via console capture: after `PUT /api/v1/cz/likes/{uuid}` with `{"rating":100}`, the page refetches `GET /api/v1/dm/briefs?...` and the new espId appears with `rating:100`. The like PUT uses an internal UUID, not the espId, so the diff approach is still needed.

### Fix
Match both paths with a regex; exclude sub-routes like `/api/v1/dm/briefs/interest-sync` (polled every ~5s, returns an object).

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
