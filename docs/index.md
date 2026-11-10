# DeepMeta Never Sleep

**DeepMeta Never Sleep** is a free, independent browser extension for contributors working on [DeepMeta](https://deepmeta.creativ.zone/) (creativ.zone). It is not affiliated with, endorsed by, or associated with DeepMeta, creativ.zone, or Google — it's a small unofficial tool built by a contributor, for contributors.

## What it does

- **Keeps your computer awake during uploads.** DeepMeta uploads can take a long time. The extension detects active uploads on `deepmeta.creativ.zone` and holds the system awake (the screen can still turn off) until the upload finishes, so long uploads don't get interrupted by the OS going to sleep.
- **Restores your place in the batch list.** When you open a brief and come back to the list, the extension restores your search filters, scroll position, and highlights the batch you were just looking at.
- **Optional Google Tasks reminders.** If you choose to connect a Google account, the extension can create a task in your own Google Tasks account whenever you like a brief on DeepMeta, so you have a reminder outside the browser.

Everything runs locally in your browser. Nothing is collected, sold, or sent to the developer.

## Install

[Get it from the Chrome Web Store](https://chromewebstore.google.com/detail/deepmeta-never-sleep/gnidnjajinpanehhpcakgdanaeffjekg) — works in Chrome, Edge, and other Chromium-based browsers.

## How it works

- **Upload detection** — a content script scoped only to `deepmeta.creativ.zone` and its Cloudflare Workers upload proxy watches network request lifecycle events (start/complete/fail) to know when to hold the system awake, via the browser's Power Management API (`chrome.power`).
- **Batch list restore** — a script running in the page observes navigation and DOM changes to restore your prior scroll position and search filters after you return from a brief.
- **Google Tasks (optional, off by default)** — only activates if you explicitly click "Connect Google Account" in the extension popup. It uses Chrome's built-in `chrome.identity` sign-in flow (Google's own account picker and consent screen — the extension never sees your password), requests the `https://www.googleapis.com/auth/tasks` scope, and writes a task (title, deadline, and a link back to the brief) to your own Google Tasks account only when you like a brief. The extension never reads your existing tasks or any other Google data.

## Permissions this extension requests

| Permission | Why |
|---|---|
| `tabs` | Detect open DeepMeta tabs |
| `power` | Prevent system sleep during an active upload |
| `webRequest` | Observe upload request lifecycle to know when to release the keep-awake lock |
| `alarms` | Schedule internal timers (e.g. settle delays for scroll restore) |
| `storage` | Save your feature toggles and Google Tasks list choice locally, on your device |
| `identity` | Google sign-in for the optional Google Tasks feature |
| Host access to `deepmeta.creativ.zone` and `*.workers.dev` | The site the extension operates on, and its Cloudflare Workers upload proxy |

## Privacy

DeepMeta Never Sleep does not collect, store, or transmit any personal data to the developer or any third party. See the full [Privacy Policy](privacy-policy.md) for details.

## Documents

- [Privacy Policy](privacy-policy.md)
- [Terms of Service](terms-of-service.md)

## Source code & support

[github.com/krakozavr/DeepMetaNeverSleep](https://github.com/krakozavr/DeepMetaNeverSleep) — MIT licensed. Open an issue there for bugs or questions.
