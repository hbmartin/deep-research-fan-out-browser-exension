import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundEvent, RuntimeRequest } from '../src/messages';

let listener: (event: BackgroundEvent) => Promise<unknown>;

beforeEach(async () => {
  vi.resetModules();
  document.body.replaceChildren();
  vi.stubGlobal('location', new URL('https://claude.ai/chat/review'));
  vi.stubGlobal('defineContentScript', (value: unknown) => value);
  vi.stubGlobal('browser', { runtime: {
    onMessage: { addListener: (fn: typeof listener) => { listener = fn; } },
    sendMessage: vi.fn(async (_message: RuntimeRequest) => ({ ok: true })),
  } });
  const module = await import('../entrypoints/providers.content');
  (module.default as unknown as { main(): void }).main();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Claude current-response selection', () => {
  it('prefers the latest streaming response over an earlier finished selector match', async () => {
    document.body.innerHTML = `
      <div style="position:fixed" data-testid="assistant-message" data-is-streaming="false">Earlier finished answer</div>
      <div style="position:fixed" data-testid="assistant-message" data-is-streaming="true">Current streaming answer</div>
    `;

    await expect(listener({ type: 'capture:dom-current', provider: 'claude' })).resolves.toMatchObject({
      provider: 'claude',
      pageUrl: 'https://claude.ai/chat/review',
      domMarkdown: 'Current streaming answer',
    });
  });
});
