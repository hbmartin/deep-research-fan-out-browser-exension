# Deep Research Fan-Out

A local-first WXT extension that launches the same query in the deep-research modes of ChatGPT, Claude, Gemini, and Grok, monitors each provider, and saves normalized Markdown artifacts.

## Browser targets

- Chrome 145+, Manifest V3, packaged for a private Chrome Web Store listing.
- Firefox 142+, Manifest V2, packaged for a public AMO listing.

Both targets provide the address-bar keyword `dr`, side panel/sidebar dashboard, parallel tab groups, research-mode safety checks, completion notifications, Markdown capture, history, re-run, and settings import/export.

On Chromium, Options can connect a report destination through the File System Access API. The directory handle stays in local IndexedDB and is reused only while read/write permission is already granted; the background worker never opens a permission prompt. Firefox, unsupported contexts, revoked permission, and direct-write errors fall back immediately to the browser Downloads API. Downloads are organized as `<downloadRoot>/<48-character-query-slug>-<first-8-run-id>/`, while a connected directory receives the same run folder directly. Existing files are preserved with numbered copies.

Grok captures the complete Sources sidebar into a search index and globally deduplicated source catalog. Source titles and URLs are always included; snippets and outbound links are enabled by default and can be disabled in Options. If Grok reports more results than the extension can capture, the available sources are still saved with an explicit warning and degraded status.

While a provider is still running, use **Copy current** in its side-panel row or **Copy current response** in the provider page’s context menu. This copies normalized Markdown and visible references without saving a capture or changing the run state.

## Development

Requirements: Node.js 22 and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm dev:firefox
pnpm check
pnpm zip
```

Load `.output/chrome-mv3` as an unpacked Chrome extension. WXT launches a temporary Firefox profile for `pnpm dev:firefox`; production Firefox packages must be signed by AMO.

## Architecture

- `entrypoints/` contains the background coordinator, provider content script, cross-browser side panel, options page, and Chrome clipboard document.
- `src/` contains provider adapters, the guarded state machine, IndexedDB repository, platform adapter, typed messages, capture queue, citation reconciliation, and artifact generation.
- `tests/` contains state, settings, artifact, and citation tests plus the initial redacted 12-case provider corpus.

Run metadata and report captures remain in the extension’s IndexedDB. Small settings use browser sync storage. A chosen directory handle is stored separately in local IndexedDB and is not synced or included in settings exports. The background context is the only run/capture database writer, and the persisted capture queue can recover after Chrome suspends its service worker.

## Provider adapter maintenance

Provider sites change without notice. Update only the relevant selector chains and bump that adapter’s version in `src/adapters.ts`. A mode-confirmation selector must prove the research control is selected (`aria-pressed`, selected data state, or a dedicated selected chip). Never replace it with a loose text match: failure to prove research mode must degrade to manual operation, not submit a normal chat.

Before release, test each adapter using a research-entitled account in both browsers and replace the synthetic corpus cases with redacted real outputs. Verify login walls, quota notices, ChatGPT clarification, Gemini plan approval on and off, completion debounce, copy output, DOM fallback, and citation placement.

Before exposing chosen-folder saving in a release with a lower minimum Chrome version, complete the persisted-handle service-worker gate in [docs/chosen-folder-smoke-test.md](./docs/chosen-folder-smoke-test.md). The UI remains feature-detected, so unsupported browsers show Downloads as the active destination.

## Packaging

`pnpm zip` creates both store packages. Keep one shared extension version. Submit the Chrome archive privately and the Firefox XPI publicly through AMO using the Gecko ID in `wxt.config.ts`. Store credentials and signing secrets outside the repository.

See [PRIVACY.md](./PRIVACY.md) for data handling and [STORE_LISTING.md](./STORE_LISTING.md) for permission justifications and the manual release checklist.
