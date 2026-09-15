# Privacy Policy

Deep Research Fan-Out processes research queries and reports locally in the user’s browser.

## Data handled

The extension handles queries entered by the user, per-provider instruction suffixes, provider-page research reports, citation URLs and titles, run status, timestamps, and extension preferences. It does not collect provider passwords, authentication cookies, payment information, or analytics.

## Storage and transmission

Settings are stored through the browser’s sync-storage feature. Run history and captured reports are stored locally in extension-scoped IndexedDB and are deleted when evicted from the 20-run history or when the extension is removed. If the user selects a report directory, its directory handle, display name, and configuration time are stored only in local IndexedDB. The handle is never synced or included in settings exports.

Queries are sent only by entering them into the user’s authenticated sessions at ChatGPT, Claude, Gemini, and Grok. The extension has no backend and transmits no information to its developer. Gemini citation wrapper URLs on `vertexaisearch.cloud.google.com` are followed to determine their canonical source URL; no report text is included in those requests.

## Clipboard and report files

The extension temporarily reads provider-generated report text from the clipboard. When enabled, it restores the prior clipboard value only if the clipboard still contains the provider-copied report, so newer user clipboard activity is never overwritten. On supported Chromium browsers, the user can explicitly select a local directory for Markdown artifacts. The extension writes new files there but does not read, move, or delete existing reports. If that directory is unavailable or permission is not already granted, artifacts are saved immediately through the browser download manager. Firefox uses the download manager.

## Permissions

Host access is limited to the four named provider sites and Gemini’s citation redirect host. The extension does not request access to all websites. See `STORE_LISTING.md` for a permission-by-permission explanation.
