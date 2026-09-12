import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendContentMessage } from '../src/content-messaging';

afterEach(() => vi.unstubAllGlobals());

describe('provider content messaging', () => {
  it('propagates rejected capture delivery and coordinator errors', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('no receiver'))
      .mockResolvedValueOnce({ ok: false, error: 'capture queue failed' });
    vi.stubGlobal('browser', { runtime: { sendMessage } });
    const capture = {
      type: 'content:capture' as const,
      runId: 'run',
      provider: 'chatgpt' as const,
      domMarkdown: 'report',
      domCitations: [],
    };
    await expect(sendContentMessage(capture)).rejects.toThrow('no receiver');
    await expect(sendContentMessage(capture)).rejects.toThrow('capture queue failed');
  });

  it('continues suppressing non-capture message delivery failures', async () => {
    vi.stubGlobal('browser', { runtime: { sendMessage: vi.fn(async () => { throw new Error('worker asleep'); }) } });
    await expect(sendContentMessage({ type: 'content:hello', provider: 'chatgpt', url: 'https://chatgpt.com/' })).resolves.toBeUndefined();
  });

  it('preserves terminal-provider error codes for non-retryable capture rejection', async () => {
    vi.stubGlobal('browser', {
      runtime: { sendMessage: vi.fn(async () => ({ ok: false, error: 'ended', code: 'provider_terminal' })) },
    });
    const delivery = sendContentMessage({
      type: 'content:capture', runId: 'run', provider: 'chatgpt', domMarkdown: 'report', domCitations: [],
    });
    await expect(delivery).rejects.toMatchObject({ code: 'provider_terminal' });
  });
});
