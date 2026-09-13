import { afterEach, describe, expect, it, vi } from 'vitest';

describe('options validation', () => {
  afterEach(() => {
    vi.resetModules();
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

    const input = document.querySelector<HTMLInputElement>('#debounce-chatgpt')!;
    expect(input.required).toBe(true);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('form')!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(set).toHaveBeenCalled());
    const saved = set.mock.calls.at(-1)?.[0] as Record<string, { completionDebounceMs?: number }>;
    expect(saved['settings.provider.chatgpt.v1']?.completionDebounceMs).toBe(10_000);
  });
});
