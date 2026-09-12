import { afterEach, describe, expect, it, vi } from 'vitest';

function browserStub(createDocument: ReturnType<typeof vi.fn>, getContexts = vi.fn(async () => [])) {
  return {
    offscreen: { createDocument, closeDocument: vi.fn(async () => undefined) },
    runtime: {
      getContexts,
      getURL: vi.fn((path: string) => `chrome-extension://test${path}`),
      sendMessage: vi.fn(async () => undefined),
    },
  };
}

describe('offscreen platform lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('recreates a cached offscreen document when its runtime context disappeared', async () => {
    const createDocument = vi.fn(async () => undefined);
    const getContexts = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    vi.stubGlobal('browser', browserStub(createDocument, getContexts));
    const { platformTestHooks } = await import('../src/platform');

    await platformTestHooks.ensureOffscreen();
    await platformTestHooks.ensureOffscreen();
    await platformTestHooks.ensureOffscreen();
    expect(createDocument).toHaveBeenCalledTimes(2);
  });

  it('clears failed initialization so a later request can retry', async () => {
    const createDocument = vi.fn()
      .mockRejectedValueOnce(new Error('creation failed'))
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal('browser', browserStub(createDocument));
    const { platformTestHooks } = await import('../src/platform');

    await expect(platformTestHooks.ensureOffscreen()).rejects.toThrow('creation failed');
    await expect(platformTestHooks.ensureOffscreen()).resolves.toBeUndefined();
    expect(createDocument).toHaveBeenCalledTimes(2);
  });

  it('removes and rejects an offscreen waiter when message delivery fails', async () => {
    vi.useFakeTimers();
    const stub = browserStub(vi.fn(async () => undefined));
    stub.runtime.sendMessage.mockRejectedValueOnce(new Error('worker unavailable'));
    vi.stubGlobal('browser', stub);
    const { platformTestHooks } = await import('../src/platform');

    await expect(platformTestHooks.offscreenRequest({ type: 'capture:clipboard-read' })).rejects.toThrow('worker unavailable');
    expect(platformTestHooks.getOffscreenWaiterCount()).toBe(0);
    await vi.runAllTimersAsync();
  });
});
