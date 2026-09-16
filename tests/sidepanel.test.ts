import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundEvent } from '../src/messages';
import type { Run } from '../src/types';

function providerActionLabels(): string[] {
  const row = document.querySelector('.provider-row');
  expect(row).toBeInstanceOf(HTMLLIElement);
  return Array.from(row!.querySelectorAll('button'), (node) => node.textContent ?? '');
}

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
    expect(browser.action.setBadgeText).not.toHaveBeenCalled();

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
    expect(providerActionLabels()).toEqual(['Open', 'Copy current', 'End provider']);
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
          ...update.providerRuns.chatgpt!, status: 'complete', completedAt: 20, captureId: 'run:chatgpt',
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
    expect(providerActionLabels()).toEqual(['Open', 'Copy', 'Save again']);
    saveAgain!.click();
    await vi.waitFor(() => expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'provider:save', runId: 'run', provider: 'chatgpt',
    }));

    runtimeListener?.({ type: 'runs:changed', runs: [{ ...completed, providerRuns: {
      chatgpt: { ...completed.providerRuns.chatgpt!, status: 'interrupted' },
    } }] });
    expect(providerActionLabels()).toEqual(['Open', 'Copy', 'Save again']);
    const copyStored = Array.from(document.querySelectorAll<HTMLButtonElement>('.provider-row button')).find((node) => node.textContent === 'Copy');
    copyStored!.click();
    await vi.waitFor(() => expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'provider:copy', runId: 'run', provider: 'chatgpt',
    }));

    runtimeListener?.({ type: 'runs:changed', runs: [{ ...completed, providerRuns: {
      chatgpt: {
        ...completed.providerRuns.chatgpt!, status: 'failed', captureId: undefined,
        saveReceipt: undefined, captureRecoveryPending: true,
      },
    } }] });
    const retryReport = Array.from(document.querySelectorAll('button')).find((node) => node.textContent === 'Retry report');
    expect(retryReport).toBeInstanceOf(HTMLButtonElement);
    expect(providerActionLabels()).toEqual(['Open', 'Copy current', 'Retry report']);
    retryReport!.click();
    await vi.waitFor(() => expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'provider:retry-capture', runId: 'run', provider: 'chatgpt',
    }));

    runtimeListener?.({ type: 'runs:changed', runs: [{ ...completed, providerRuns: {
      chatgpt: {
        ...completed.providerRuns.chatgpt!, status: 'failed', captureId: undefined,
        saveReceipt: undefined, captureRecoveryPending: undefined,
      },
    } }] });
    expect(providerActionLabels()).toEqual(['Open', 'Copy current', 'Save again']);

    const reviewRun: Run = { ...completed, providerRuns: {
      chatgpt: {
        ...completed.providerRuns.chatgpt!, status: 'failed', captureId: undefined,
        saveReceipt: undefined, captureRecoveryPending: true, captureReviewPending: true,
      },
    } };
    runtimeListener?.({ type: 'runs:changed', runs: [reviewRun] });
    expect(providerActionLabels()).toEqual(['Open', 'Copy retained report', 'Discard blocked job']);
    Array.from(document.querySelectorAll<HTMLButtonElement>('.provider-row button'))
      .find((node) => node.textContent === 'Copy retained report')!.click();
    await vi.waitFor(() => expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'provider:copy-retained-job', runId: 'run', provider: 'chatgpt',
    }));

    runtimeListener?.({ type: 'runs:changed', runs: [reviewRun] });
    vi.stubGlobal('confirm', vi.fn(() => true));
    Array.from(document.querySelectorAll<HTMLButtonElement>('.provider-row button'))
      .find((node) => node.textContent === 'Discard blocked job')!.click();
    await vi.waitFor(() => expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'provider:discard-blocked-job', runId: 'run', provider: 'chatgpt',
    }));

    runtimeListener?.({ type: 'runs:changed', runs: [update] });
    const sendMessage = browser.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>;
    const original = sendMessage.getMockImplementation() as (request: unknown) => Promise<unknown>;
    sendMessage.mockImplementation(async (request: unknown) => (request as { type?: string }).type === 'provider:end'
      ? { ok: false, code: 'provider_terminal', error: 'Provider run has ended.' }
      : original(request));
    Array.from(document.querySelectorAll<HTMLButtonElement>('.provider-row button'))
      .find((node) => node.textContent === 'End provider')!.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
      type: 'provider:end', runId: 'run', provider: 'chatgpt',
    }));
    expect(document.querySelector('.notice')?.textContent).not.toBe('Provider run has ended.');
  });
});
