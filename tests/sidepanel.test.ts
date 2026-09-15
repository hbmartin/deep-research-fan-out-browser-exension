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
    let storedSettings = {
      'settings.provider.chatgpt.v1': { appendString: 'Initial suffix' },
    };
    vi.stubGlobal('browser', {
      runtime: {
        onMessage: { addListener: vi.fn((listener: (event: BackgroundEvent) => void) => { runtimeListener = listener; }) },
        sendMessage: vi.fn(async (request: { type: string }) => request.type === 'runs:list' ? { ok: true, runs: [] } : { ok: true }),
        openOptionsPage: vi.fn(async () => undefined),
      },
      storage: {
        sync: { get: vi.fn(async () => storedSettings) },
        onChanged: { addListener: vi.fn((listener: (changes: unknown, areaName: string) => void) => { storageListener = listener; }) },
      },
      action: { setBadgeText: vi.fn(async () => undefined) },
    });
    document.body.innerHTML = '<main id="app"></main>';
    await import('../entrypoints/sidepanel/main');
    await vi.waitFor(() => {
      expect(document.querySelector('#query')).toBeInstanceOf(HTMLTextAreaElement);
      expect(document.querySelector('.preview')?.textContent).toContain('Initial suffix');
    });

    const textarea = document.querySelector<HTMLTextAreaElement>('#query')!;
    textarea.value = 'draft query';
    textarea.focus();
    textarea.setSelectionRange(2, 7);
    const update: Run = {
      id: 'run', query: 'existing', createdAt: 1, windowId: 1, providerRuns: {
        chatgpt: {
          provider: 'chatgpt', tabId: 1, status: 'researching', submittedQuery: 'existing', appendString: '',
          startedAt: 1, attempts: 0, degraded: false, adapterVersion: 'test',
        },
      }, status: 'active', slug: 'run', reportFolder: 'run-00000000', downloadFolder: 'deep-research/run-00000000',
    };
    runtimeListener?.({ type: 'runs:changed', runs: [update] });
    storedSettings = {
      'settings.provider.chatgpt.v1': { appendString: 'Updated suffix' },
    };
    storageListener?.({}, 'sync');
    await vi.waitFor(() => {
      expect(document.querySelector('.history h2')?.textContent).toBe('Runs');
      expect(document.querySelector('.preview')?.textContent).toContain('Updated suffix');
    });

    expect(document.querySelector('#query')).toBe(textarea);
    expect(textarea.value).toBe('draft query');
    expect(document.activeElement).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([2, 7]);

    const copyCurrent = Array.from(document.querySelectorAll('button')).find((node) => node.textContent === 'Copy current');
    expect(copyCurrent).toBeInstanceOf(HTMLButtonElement);
    copyCurrent!.click();
    await vi.waitFor(() => expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'provider:copy-current', runId: 'run', provider: 'chatgpt',
    }));
    await vi.waitFor(() => expect(document.querySelector('.notice')?.textContent).toBe('ChatGPT current response copied.'));

    const completed: Run = {
      ...update,
      status: 'complete',
      completedAt: 20,
      providerRuns: {
        chatgpt: {
          ...update.providerRuns.chatgpt!, status: 'complete', completedAt: 20,
          saveReceipt: {
            destination: 'downloads', requestedRelativePath: 'deep-research/run/chatgpt.md', savedAt: 20,
            fallbackReason: 'permission_required', downloadId: 7,
          },
        },
      },
    };
    runtimeListener?.({ type: 'runs:changed', runs: [completed] });
    await vi.waitFor(() => expect(document.querySelector('.save-receipt')?.textContent).toContain('Downloads fallback'));
    const saveAgain = Array.from(document.querySelectorAll('button')).find((node) => node.textContent === 'Save again');
    saveAgain!.click();
    await vi.waitFor(() => expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'provider:save', runId: 'run', provider: 'chatgpt',
    }));
  });
});
