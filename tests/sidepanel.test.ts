import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundEvent } from '../src/messages';
import type { Run } from '../src/types';

describe('side-panel rendering', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('preserves the query node, draft, focus, and selection across data updates', async () => {
    let runtimeListener: ((event: BackgroundEvent) => void) | undefined;
    let storageListener: ((changes: unknown, areaName: string) => void) | undefined;
    vi.stubGlobal('browser', {
      runtime: {
        onMessage: { addListener: vi.fn((listener: (event: BackgroundEvent) => void) => { runtimeListener = listener; }) },
        sendMessage: vi.fn(async (request: { type: string }) => request.type === 'runs:list' ? { ok: true, runs: [] } : { ok: true }),
        openOptionsPage: vi.fn(async () => undefined),
      },
      storage: {
        sync: { get: vi.fn(async () => ({})) },
        onChanged: { addListener: vi.fn((listener: (changes: unknown, areaName: string) => void) => { storageListener = listener; }) },
      },
      action: { setBadgeText: vi.fn(async () => undefined) },
    });
    document.body.innerHTML = '<main id="app"></main>';
    await import('../entrypoints/sidepanel/main');
    await vi.waitFor(() => expect(document.querySelector('#query')).toBeInstanceOf(HTMLTextAreaElement));

    const textarea = document.querySelector<HTMLTextAreaElement>('#query')!;
    textarea.value = 'draft query';
    textarea.focus();
    textarea.setSelectionRange(2, 7);
    const update: Run = {
      id: 'run', query: 'existing', createdAt: 1, windowId: 1, providerRuns: {}, status: 'active', slug: 'run', downloadFolder: 'deep-research/run',
    };
    runtimeListener?.({ type: 'runs:changed', runs: [update] });
    storageListener?.({}, 'sync');
    await vi.waitFor(() => expect(document.querySelector('.history h2')?.textContent).toBe('Runs'));

    expect(document.querySelector('#query')).toBe(textarea);
    expect(textarea.value).toBe('draft query');
    expect(document.activeElement).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 7]);
  });
});
