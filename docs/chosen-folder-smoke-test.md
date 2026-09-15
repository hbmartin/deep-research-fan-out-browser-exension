# Chosen-folder compatibility gate

Run this gate in the minimum supported stable Chrome before shipping chosen-folder saving. If any direct-write step fails, hide the chosen-folder controls for that Chrome range and ship Downloads-only behavior. Do not add native messaging as a workaround.

1. Build and load the MV3 extension, open Options, select an empty report directory, and confirm the UI reports `granted` permission.
2. Close Options and the side panel, then wait long enough for Chrome to suspend the extension service worker.
3. Restart Chrome, complete one provider report, and confirm the restored IndexedDB directory handle writes `<query-slug>-<first-8-run-id>/<provider>.md` without a picker or permission prompt.
4. Confirm the Markdown contains front matter, normalized inline citations, a clickable `## References` list, and any captured Grok research trail.
5. Revoke the directory permission, complete another provider, and confirm `FAILED-<provider>.md` or `<provider>.md` appears immediately under the configured Downloads fallback subfolder. Options must say that reconnection is needed.
6. Reconnect from Options, use **Save again**, and confirm a new direct file is written. Existing files must produce ` (1)`, ` (2)`, and so on.
7. Disconnect the destination and confirm no existing files are read, moved, or deleted.

Also repeat the fallback path in Firefox, where folder selection must not be shown.
