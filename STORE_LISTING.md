# Store listing and release notes

## Permission justifications

- `tabs` and `tabGroups`: open, monitor, focus, and group the four research tabs created by an explicit user run.
- `scripting` (Chrome): restore the bundled provider observer if Chrome discarded its content-script context.
- Provider host access: engage research mode, insert the query, observe completion, and capture the user’s generated report on the four named services only.
- Gemini redirect host: resolve expiring Gemini citation wrappers to canonical source URLs.
- `storage` and `unlimitedStorage`: retain settings plus the newest 20 potentially large research runs and their captures. On supported Chromium browsers, local IndexedDB also retains the directory handle explicitly selected by the user.
- `alarms`: reconcile long-running work after a background context sleeps.
- `notifications`: identify completed providers and providers requiring user input.
- `contextMenus`: offer an explicit “Copy current response” action on the four supported provider sites.
- `downloads`: save one Markdown status/report artifact per enabled provider on Firefox and whenever a selected Chromium folder is unavailable. The permission remains required because Downloads is the automatic fallback.
- `clipboardRead` and `clipboardWrite`: read provider copy-button output and safely restore the prior clipboard value.
- `offscreen` (Chrome): provide the DOM context needed for clipboard and Blob URL operations from an MV3 service worker.
- `sidePanel` (Chrome): provide the launch, monitoring, and history interface. Firefox uses its separate sidebar API.

## Store description

Run one query across the deep-research modes of ChatGPT, Claude, Gemini, and Grok. Deep Research Fan-Out uses your existing signed-in browser sessions, monitors each run, preserves and normalizes citations, and saves one Markdown artifact per provider. Chromium users can connect a local report folder; Firefox and unavailable folders use automatic Downloads fallback. Processing stays on your device and the extension has no developer-operated backend or telemetry.

## Manual release checklist

1. Run `pnpm check` and `pnpm zip` from a clean checkout.
2. Install both generated packages in clean browser profiles and verify the generated manifest permissions.
3. Complete the live provider matrix documented in `README.md` using research-entitled test accounts.
4. Verify clipboard restoration while another tab changes the clipboard during capture.
5. Verify browser restart, closed-tab interruption, manual handoff, four-file partial completion, chosen-folder saving, permission-revocation fallback, and Save again.
6. Update screenshots, privacy-policy URL, support contact, and version notes for both stores.
7. Submit the Chrome package with private visibility and the Firefox package as a public AMO listing.
