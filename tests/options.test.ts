import { afterEach, describe, expect, it, vi } from 'vitest';

describe('options validation', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../src/report-storage');
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('keeps the prior debounce when the required number field is cleared', async () => {
    const set = vi.fn<(items: Record<string, unknown>) => Promise<void>>(async () => undefined);
    vi.stubGlobal('browser', {
      storage: { sync: { get: vi.fn(async () => ({})), set } },
    });
    document.body.innerHTML = '<main id="app"></main>';
    await import('../entrypoints/options/main');
    await vi.waitFor(() => expect(document.querySelector('#debounce-chatgpt')).toBeInstanceOf(HTMLInputElement));
    expect(document.querySelector<HTMLInputElement>('#source-snippets')?.checked).toBe(true);
    expect(document.querySelector('.destination')?.textContent).toContain('Folder selection is unavailable');
    expect(Array.from(document.querySelectorAll('button')).some((button) => button.textContent === 'Connect')).toBe(false);

    const input = document.querySelector<HTMLInputElement>('#debounce-chatgpt')!;
    expect(input.required).toBe(true);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(set).toHaveBeenCalled());
    const saved = set.mock.calls.at(-1)?.[0] as Record<string, { completionDebounceMs?: number }>;
    expect(saved['settings.provider.chatgpt.v1']?.completionDebounceMs).toBe(10_000);
  });

  it('connects, reconnects, changes, and disconnects a local-only destination', async () => {
    let config: { handle: FileSystemDirectoryHandle; displayName: string; configuredAt: number; needsReconnect: boolean } | undefined;
    let permission: PermissionState = 'prompt';
    let selectedName = 'Reports';
    const choose = vi.fn(async () => {
      config = { handle: { name: selectedName } as FileSystemDirectoryHandle, displayName: selectedName, configuredAt: 1, needsReconnect: true };
      return config;
    });
    const reconnect = vi.fn(async () => {
      permission = 'granted';
      config = config ? { ...config, needsReconnect: false } : undefined;
      return permission;
    });
    const disconnect = vi.fn(async () => { config = undefined; permission = 'prompt'; });
    vi.doMock('../src/report-storage', () => ({
      chooseReportDirectory: choose,
      disconnectReportDirectory: disconnect,
      getReportDirectoryConfig: vi.fn(async () => config),
      isDirectoryPickerSupported: () => true,
      queryDirectoryPermission: vi.fn(async () => permission),
      reconnectReportDirectory: reconnect,
    }));
    vi.stubGlobal('browser', { storage: { sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } } });
    document.body.innerHTML = '<main id="app"></main>';
    await import('../entrypoints/options/main');
    await vi.waitFor(() => expect(buttonNamed('Connect')).toBeInstanceOf(HTMLButtonElement));

    buttonNamed('Connect')!.click();
    await vi.waitFor(() => expect(document.querySelector('.destination')?.textContent).toContain('Reports'));
    expect(buttonNamed('Reconnect')).toBeInstanceOf(HTMLButtonElement);

    buttonNamed('Reconnect')!.click();
    await vi.waitFor(() => expect(document.querySelector('.destination')?.textContent).toContain('Folder reconnected'));
    expect(reconnect).toHaveBeenCalled();

    selectedName = 'Archive';
    buttonNamed('Change')!.click();
    await vi.waitFor(() => expect(document.querySelector('.destination')?.textContent).toContain('Archive'));
    expect(choose).toHaveBeenCalledTimes(2);

    buttonNamed('Export')!.click();
    await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>('#settings-json')?.value).toContain('downloadRoot'));
    expect(document.querySelector<HTMLTextAreaElement>('#settings-json')?.value).not.toContain('Archive');

    buttonNamed('Disconnect')!.click();
    await vi.waitFor(() => expect(document.querySelector('.destination')?.textContent).toContain('Folder disconnected'));
    expect(buttonNamed('Connect')).toBeInstanceOf(HTMLButtonElement);
    expect(disconnect).toHaveBeenCalled();
  });

  it('retains the current destination when changing folders is canceled', async () => {
    const config = { handle: { name: 'Reports' } as FileSystemDirectoryHandle, displayName: 'Reports', configuredAt: 1, needsReconnect: false };
    const choose = vi.fn(async () => { throw new DOMException('Canceled', 'AbortError'); });
    vi.doMock('../src/report-storage', () => ({
      chooseReportDirectory: choose,
      disconnectReportDirectory: vi.fn(async () => undefined),
      getReportDirectoryConfig: vi.fn(async () => config),
      isDirectoryPickerSupported: () => true,
      queryDirectoryPermission: vi.fn(async () => 'granted'),
      reconnectReportDirectory: vi.fn(async () => 'granted'),
    }));
    vi.stubGlobal('browser', { storage: { sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } } });
    document.body.innerHTML = '<main id="app"></main>';
    await import('../entrypoints/options/main');
    await vi.waitFor(() => expect(buttonNamed('Change')).toBeInstanceOf(HTMLButtonElement));

    buttonNamed('Change')!.click();
    await vi.waitFor(() => expect(document.querySelector('.destination')?.textContent).toContain('Folder selection canceled'));
    expect(document.querySelector('.destination')?.textContent).toContain('Reports');
  });

  it('refreshes only destination state on focus and preserves unsaved form interaction', async () => {
    const config = { handle: { name: 'Reports' } as FileSystemDirectoryHandle, displayName: 'Reports', configuredAt: 1, needsReconnect: false };
    let permission: PermissionState = 'granted';
    vi.doMock('../src/report-storage', () => ({
      chooseReportDirectory: vi.fn(async () => config),
      disconnectReportDirectory: vi.fn(async () => undefined),
      getReportDirectoryConfig: vi.fn(async () => config),
      isDirectoryPickerSupported: () => true,
      queryDirectoryPermission: vi.fn(async () => permission),
      reconnectReportDirectory: vi.fn(async () => permission),
    }));
    vi.stubGlobal('browser', { storage: { sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } } });
    document.body.innerHTML = '<main id="app"></main>';
    await import('../entrypoints/options/main');
    await vi.waitFor(() => expect(buttonNamed('Change')).toBeInstanceOf(HTMLButtonElement));

    const json = document.querySelector<HTMLTextAreaElement>('#settings-json')!;
    const debounce = document.querySelector<HTMLInputElement>('#debounce-chatgpt')!;
    const advanced = debounce.closest('details')!;
    json.value = '{ "unfinished": true }';
    json.focus();
    json.setSelectionRange(2, 15);
    debounce.value = '1234';
    debounce.dispatchEvent(new Event('input', { bubbles: true }));
    advanced.open = true;
    const originalJson = json;

    permission = 'prompt';
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(document.querySelector('.destination')?.textContent).toContain('Permission is prompt'));

    expect(document.querySelector('#settings-json')).toBe(originalJson);
    expect(json.value).toBe('{ "unfinished": true }');
    expect(json.selectionStart).toBe(2);
    expect(json.selectionEnd).toBe(15);
    expect(document.activeElement).toBe(json);
    expect(debounce.value).toBe('1234');
    expect(advanced.open).toBe(true);
  });

  it('explains non-permission write failures without suggesting reconnect', async () => {
    const config = {
      handle: { name: 'Reports' } as FileSystemDirectoryHandle,
      displayName: 'Reports', configuredAt: 1, needsReconnect: false, lastWriteFailureAt: 2,
    };
    vi.doMock('../src/report-storage', () => ({
      chooseReportDirectory: vi.fn(async () => config),
      disconnectReportDirectory: vi.fn(async () => undefined),
      getReportDirectoryConfig: vi.fn(async () => config),
      isDirectoryPickerSupported: () => true,
      queryDirectoryPermission: vi.fn(async () => 'granted'),
      reconnectReportDirectory: vi.fn(async () => 'granted'),
    }));
    vi.stubGlobal('browser', { storage: { sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } } });
    document.body.innerHTML = '<main id="app"></main>';
    await import('../entrypoints/options/main');
    await vi.waitFor(() => expect(document.querySelector('.destination')?.textContent).toContain('last write failed'));

    expect(buttonNamed('Reconnect')).toBeUndefined();
    expect(document.querySelector('.destination')?.textContent).toContain('Check free space');
    expect(buttonNamed('Change')).toBeInstanceOf(HTMLButtonElement);
  });
});

function buttonNamed(name: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((button) => button.textContent === name);
}
