# Privacy Policy — DeepMeta Never Sleep

**Last updated: 2026-08-10**

_Also published at [docs/privacy-policy.md](docs/privacy-policy.md) — keep both in sync when editing._

## Summary

DeepMeta Never Sleep does not collect, store, or transmit any personal data to the developer or any third party.

## Data handling

**Local storage only.** The extension stores user preferences (feature toggles) and Google Tasks list identifiers in `chrome.storage.local` on the user's own device. This data never leaves the device and is not accessible to the developer.

**Google Tasks integration.** When the user explicitly connects a Google account and likes a brief on DeepMeta, the extension writes brief metadata (title, deadline, and a link to the brief) to the user's own Google Tasks account via the Google Tasks API. This data is written solely on the user's behalf to the user's own account. The developer has no access to this data.

**OAuth token.** Authentication with Google is handled entirely by the Chrome browser via `chrome.identity`. The extension never sees, stores, or transmits the OAuth token.

## Data protection and security

**Encryption in transit.** All communication with Google Tasks and DeepMeta uses HTTPS/TLS. The extension does not send Google user data through a developer-controlled server or intermediary.

**Access controls and storage isolation.** Local settings and Google Tasks list identifiers remain in Chrome's extension-scoped `chrome.storage.local`, isolated from ordinary web pages and accessible only to this installed extension in the user's browser profile. The extension does not store OAuth tokens, passwords, or credentials.

**Data minimization.** The Google Tasks integration uses only the task-list metadata needed to let the user choose a destination and the brief title, deadline, and ESP link needed to create the requested reminder. The extension does not read existing task contents, use analytics, or retain Google user data on any developer-controlled system.

**Network monitoring.** The extension observes upload request lifecycle events (start, complete, fail) on `deepmeta.creativ.zone` and its Cloudflare Workers proxy endpoints solely to control the system keep-awake state. No request content, response data, or URLs are stored or transmitted.

## What we do not do

- We do not collect any personal information.
- We do not use analytics or telemetry.
- We do not share any data with third parties.
- We do not transmit any data to developer-controlled servers.

## Contact

For questions, open an issue at [github.com/krakozavr/DeepMetaNeverSleep](https://github.com/krakozavr/DeepMetaNeverSleep).
