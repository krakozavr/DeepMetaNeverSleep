# Privacy Policy — DeepMeta Never Sleep

**Last updated: 2026-06-02**

## Summary

DeepMeta Never Sleep does not collect, store, or transmit any personal data to the developer or any third party.

## Data handling

**Local storage only.** The extension stores user preferences (feature toggles) and Google Tasks list identifiers in `chrome.storage.local` on the user's own device. This data never leaves the device and is not accessible to the developer.

**Google Tasks integration.** When the user explicitly connects a Google account and likes a brief on DeepMeta, the extension writes brief metadata (title, deadline, and a link to the brief) to the user's own Google Tasks account via the Google Tasks API. This data is written solely on the user's behalf to the user's own account. The developer has no access to this data.

**OAuth token.** Authentication with Google is handled entirely by the Chrome browser via `chrome.identity`. The extension never sees, stores, or transmits the OAuth token.

**Network monitoring.** The extension observes upload request lifecycle events (start, complete, fail) on `deepmeta.creativ.zone` and its Cloudflare Workers proxy endpoints solely to control the system keep-awake state. No request content, response data, or URLs are stored or transmitted.

## What we do not do

- We do not collect any personal information.
- We do not use analytics or telemetry.
- We do not share any data with third parties.
- We do not transmit any data to developer-controlled servers.

## Contact

For questions, open an issue at [github.com/krakozavr/DeepMetaNeverSleep](https://github.com/krakozavr/DeepMetaNeverSleep).
