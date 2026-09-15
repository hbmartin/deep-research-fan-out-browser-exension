import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderReporter } from '../src/provider-reporting';
import type { RuntimeRequest } from '../src/messages';

const request = (status: 'researching' | 'manual_required' = 'researching'): Extract<RuntimeRequest, { type: 'content:state' }> => ({
  type: 'content:state', runId: 'run', provider: 'chatgpt', status,
});
let reporters: ProviderReporter[];
beforeEach(() => { vi.useFakeTimers(); reporters = []; });
afterEach(() => { reporters.forEach((reporter) => reporter.cancel()); vi.useRealTimers(); vi.unstubAllGlobals(); });
function reporter(send: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('browser', { runtime: { sendMessage: send } });
  const accepted = vi.fn();
  const rejected = vi.fn();
  const instance = new ProviderReporter(accepted, rejected);
  reporters.push(instance);
  return { instance, accepted, rejected };
}

describe('serialized provider reporting', () => {
  it('deduplicates mutation-driven requests and retries on exponential deadlines', async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'));
    const { instance } = reporter(send);
    const pending = instance.report(request());
    for (let i = 0; i < 100; i++) expect(instance.report(request())).toBe(pending);
    await vi.advanceTimersByTimeAsync(999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(send).toHaveBeenCalledTimes(2);
    send.mockResolvedValue({ ok: true });
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('caps backoff at sixty seconds, independently of new inspections', async () => {
    const calls: number[] = [];
    const start = Date.now();
    const send = vi.fn(async () => { calls.push(Date.now() - start); throw new Error('offline'); });
    const { instance } = reporter(send);
    const pending = instance.report(request()).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(183_000);
    expect(calls).toEqual([0, 1000, 3000, 7000, 15000, 31000, 63000, 123000, 183000]);
    instance.cancel();
    await pending;
  });

  it('serializes subsequent states behind an unacknowledged state', async () => {
    let acknowledge!: (value: unknown) => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; })).mockResolvedValue({ ok: true });
    const { instance, accepted } = reporter(send);
    const first = instance.report(request());
    const second = instance.report(request('manual_required'));
    expect(send).toHaveBeenCalledTimes(1);
    acknowledge({ ok: true });
    await Promise.all([first, second, instance.idle()]);
    expect(accepted.mock.calls.map(([value]) => value.status)).toEqual(['researching', 'manual_required']);
  });

  it.each(['invalid_transition', 'provider_terminal', 'run_not_found'])('does not resend permanent %s rejections', async (code) => {
    const send = vi.fn().mockResolvedValue({ ok: false, code, error: 'rejected', providerState: { status: 'complete' } });
    const { instance, rejected } = reporter(send);
    await expect(instance.report(request())).rejects.toMatchObject({ code });
    for (let i = 0; i < 20; i++) await expect(instance.report(request())).rejects.toMatchObject({ code });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it('allows a later retry after a conversation mismatch rejection', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({
        ok: false, code: 'conversation_mismatch', error: 'page changed',
        providerState: { status: 'researching' },
      })
      .mockResolvedValue({ ok: true, providerState: { status: 'researching' } });
    const { instance, rejected } = reporter(send);

    await expect(instance.report(request())).rejects.toMatchObject({ code: 'conversation_mismatch' });
    await expect(instance.report(request())).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(2);
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it('cancels queued work and ignores a late acknowledgement', async () => {
    let acknowledge!: (value: unknown) => void;
    const send = vi.fn(() => new Promise((resolve) => { acknowledge = resolve; }));
    const { instance, accepted } = reporter(send);
    const first = instance.report(request()).catch(() => undefined);
    const second = instance.report(request('manual_required')).catch(() => undefined);
    instance.cancel();
    await Promise.all([first, second, instance.idle()]);
    acknowledge({ ok: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(accepted).not.toHaveBeenCalled();
  });
});
