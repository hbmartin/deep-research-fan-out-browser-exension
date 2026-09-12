# Deep Research Fan-Out

A local-first WXT extension that launches the same query in the deep-research modes of ChatGPT, Claude, Gemini, and Grok, monitors each provider, and downloads normalized Markdown artifacts.

## Browser targets

- Chrome 116+, Manifest V3, packaged for a private Chrome Web Store listing.
- Firefox 142+, Manifest V2, packaged for a public AMO listing.

Both targets provide the address-bar keyword `dr`, side panel/sidebar dashboard, parallel tab groups, research-mode safety checks, completion notifications, Markdown capture, history, re-run, and settings import/export.

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

Run metadata and report captures remain in the extension’s IndexedDB. Small settings use browser sync storage. The background context is the only database writer, and the persisted capture queue can recover after Chrome suspends its service worker.

## Provider adapter maintenance

Provider sites change without notice. Update only the relevant selector chains and bump that adapter’s version in `src/adapters.ts`. A mode-confirmation selector must prove the research control is selected (`aria-pressed`, selected data state, or a dedicated selected chip). Never replace it with a loose text match: failure to prove research mode must degrade to manual operation, not submit a normal chat.

Before release, test each adapter using a research-entitled account in both browsers and replace the synthetic corpus cases with redacted real outputs. Verify login walls, quota notices, ChatGPT clarification, Gemini plan approval on and off, completion debounce, copy output, DOM fallback, and citation placement.

## Packaging

`pnpm zip` creates both store packages. Keep one shared extension version. Submit the Chrome archive privately and the Firefox XPI publicly through AMO using the Gecko ID in `wxt.config.ts`. Store credentials and signing secrets outside the repository.

See [PRIVACY.md](./PRIVACY.md) for data handling and [STORE_LISTING.md](./STORE_LISTING.md) for permission justifications and the manual release checklist.
