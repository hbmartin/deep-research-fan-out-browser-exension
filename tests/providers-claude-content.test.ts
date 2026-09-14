import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundEvent, RuntimeRequest } from '../src/messages';

let listener: (event: BackgroundEvent) => Promise<unknown>;
let messages: RuntimeRequest[];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  messages = [];
  document.body.replaceChildren();
  vi.stubGlobal('location', new URL('https://claude.ai/chat/review'));
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
  await listener?.({ type: 'content:stop', runId: 'claude-run' });
  vi.clearAllTimers();
  vi.useRealTimers();
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

  it('uses the final-selector guard for automatic capture while a newer candidate streams', async () => {
    document.body.innerHTML = `
      <div style="position:fixed" data-testid="assistant-message" data-is-streaming="false">Earlier finished answer</div>
      <div id="current" style="position:fixed" data-testid="assistant-message" data-is-streaming="true">
        Current streaming answer
        <button style="position:fixed" aria-label="Copy response">Copy</button>
      </div>
    `;
    await listener({
      type: 'content:start', runId: 'claude-run', provider: 'claude', query: 'Research topic', appendString: '',
      geminiAutoApprove: true, completionDebounceMs: 3000, resumeOnly: true, status: 'researching',
      conversationKey: 'https://claude.ai/chat/review',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:capture' }));

    document.querySelector('#current')!.remove();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:capture' }));

    document.body.insertAdjacentHTML('beforeend', `
      <div id="current" style="position:fixed" data-testid="assistant-message" data-is-streaming="false">
        Current finished answer
        <button style="position:fixed" aria-label="Copy response">Copy</button>
      </div>
    `);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'content:capture', domMarkdown: expect.stringContaining('Current finished answer'),
    }));
  });

  it('collapses nested selector matches to the outer response for manual capture', async () => {
    document.body.innerHTML = `
      <div style="position:fixed" data-is-streaming="false">
        Outer report text
        <div style="position:fixed" data-testid="assistant-message">Nested report text</div>
      </div>
    `;
    const snapshot = await listener({ type: 'capture:dom-current', provider: 'claude' }) as { domMarkdown: string };
    expect(snapshot.domMarkdown).toContain('Outer report text');
    expect(snapshot.domMarkdown.match(/Nested report text/g)).toHaveLength(1);
  });
});
