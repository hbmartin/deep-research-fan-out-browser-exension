import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundEvent, RuntimeRequest } from '../src/messages';

let listener: (event: BackgroundEvent) => Promise<unknown>;
let messages: RuntimeRequest[];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  messages = [];
  document.body.replaceChildren();
  vi.stubGlobal('location', new URL('https://grok.com/c/review'));
  vi.stubGlobal('defineContentScript', (value: unknown) => value);
  vi.stubGlobal('browser', { runtime: {
    onMessage: { addListener: (fn: typeof listener) => { listener = fn; } },
    sendMessage: vi.fn(async (message: RuntimeRequest) => {
      messages.push(message);
      return { ok: true };
    }),
  } });
  const module = await import('../entrypoints/providers.content');
  (module.default as unknown as { main(): void }).main();
});

afterEach(async () => {
  await listener?.({ type: 'content:stop', runId: 'grok-run' });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Grok response-root selection', () => {
  it('captures the outer fallback wrapper when it contains the completed primary root', async () => {
    document.body.innerHTML = `
      <article style="position:fixed">
        Outer report framing
        <div data-testid="assistant-message">Completed nested report with evidence and conclusions.</div>
        <button style="position:fixed" aria-label="Copy response">Copy response</button>
      </article>
    `;
    await listener({
      type: 'content:start', runId: 'grok-run', provider: 'grok', query: 'Research topic', appendString: '',
      geminiAutoApprove: true, completionDebounceMs: 3000, resumeOnly: true, status: 'researching',
      conversationKey: 'https://grok.com/c/review',
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(messages).toContainEqual(expect.objectContaining({
      type: 'content:capture',
      domMarkdown: expect.stringContaining('Outer report framing'),
    }));
  });
});
