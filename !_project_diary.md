# DeepMeta Never Sleep — Project Diary

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
