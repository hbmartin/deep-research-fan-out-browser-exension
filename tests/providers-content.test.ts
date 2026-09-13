import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADAPTERS, type SelectorChain } from '../src/adapters';
import type { BackgroundEvent, RuntimeRequest } from '../src/messages';
import { canTransition } from '../src/state';
import type { ProviderRunStatus } from '../src/types';

let listener: (event: BackgroundEvent) => Promise<unknown>;
let messages: RuntimeRequest[];
let storedStatus: ProviderRunStatus;
let invalidTransitions: string[];
let findResponseControl: (root: HTMLElement, roots: readonly HTMLElement[], selectors: SelectorChain, baseline?: ReadonlySet<HTMLElement>, allowHoverTransparent?: boolean) => HTMLElement | null;
const report = 'A completed research report. The available evidence supports the following detailed findings, with limitations and practical recommendations.';

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  messages = [];
  invalidTransitions = [];
  document.body.innerHTML = '';
  vi.stubGlobal('location', new URL('https://chatgpt.com/c/review'));
  vi.stubGlobal('defineContentScript', (value: unknown) => value);
  vi.stubGlobal('browser', { runtime: {
    onMessage: { addListener: (fn: typeof listener) => { listener = fn; } },
    sendMessage: vi.fn(async (message: RuntimeRequest) => {
      messages.push(message);
      const next = message.type === 'content:state' ? message.status : message.type === 'content:capture' ? 'capturing' : undefined;
      if (next) {
        if (!canTransition(storedStatus, next)) {
          invalidTransitions.push(`${storedStatus} -> ${next}`);
          return { ok: false, error: 'Invalid transition' };
        }
        storedStatus = next;
      }
      return { ok: true };
    }),
  } });
  const module = await import('../entrypoints/providers.content');
  findResponseControl = module.findResponseControl;
  (module.default as unknown as { main(): void }).main();
});

afterEach(async () => {
  await listener?.({ type: 'content:stop', runId: 'review-run' });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(invalidTransitions).toEqual([]);
});

function answer(text = report) {
  document.body.innerHTML = `<div style="position:fixed" data-message-author-role="assistant"><h2>${text}</h2><button style="position:fixed" aria-label="Copy response">Copy</button></div>`;
}

async function resume(status: 'researching' | 'capturing' | 'submitting', captureAccepted = false, submittedAt?: number) {
  storedStatus = status;
  await listener({
    type: 'content:start', runId: 'review-run', provider: 'chatgpt', query: 'Research topic', appendString: '',
    geminiAutoApprove: true, completionDebounceMs: 3000, resumeOnly: true, status, submittedAt, captureAccepted,
  });
}

function captures() { return messages.filter((message) => message.type === 'content:capture'); }

describe('provider content-script recovery', () => {
  it('control: resuming researching captures an already rendered report', async () => {
    answer();
    await resume('researching');
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'capturing' }));
    expect(storedStatus).toBe('capturing');
  });

  it('does not let quota-like page text discard a finished report during capture backoff', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sendMessage = vi.mocked(browser.runtime.sendMessage);
    const defaultImplementation = sendMessage.getMockImplementation() as (message: unknown) => Promise<unknown>;
    let failFirstCapture = true;
    sendMessage.mockImplementation(async (message: unknown) => {
      if ((message as RuntimeRequest).type === 'content:capture' && failFirstCapture) {
        failFirstCapture = false;
        messages.push(message as RuntimeRequest);
        return { ok: false, error: 'Capture delivery failed.' };
      }
      return defaultImplementation(message);
    });
    answer();
    await resume('researching');
    await vi.advanceTimersByTimeAsync(4000);
    expect(captures()).toHaveLength(1);
    expect(storedStatus).toBe('researching');

    // The first failed delivery backs off for five seconds.
    await vi.advanceTimersByTimeAsync(2000);
    expect(captures()).toHaveLength(1);
    const notice = document.createElement('div');
    notice.style.position = 'fixed';
    notice.textContent = 'You have reached your deep research limit.';
    document.body.append(notice);
    await vi.advanceTimersByTimeAsync(2000);

    expect(storedStatus).toBe('researching');
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'quota_exhausted' }));
    expect(captures()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(2);
  });

  it('still detects navigation away during capture backoff', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sendMessage = vi.mocked(browser.runtime.sendMessage);
    const defaultImplementation = sendMessage.getMockImplementation() as (message: unknown) => Promise<unknown>;
    let failFirstCapture = true;
    sendMessage.mockImplementation(async (message: unknown) => {
      if ((message as RuntimeRequest).type === 'content:capture' && failFirstCapture) {
        failFirstCapture = false;
        messages.push(message as RuntimeRequest);
        return { ok: false, error: 'Capture delivery failed.' };
      }
      return defaultImplementation(message);
    });
    answer();
    await resume('researching');
    await vi.advanceTimersByTimeAsync(4000);
    expect(captures()).toHaveLength(1);

    vi.stubGlobal('location', new URL('https://example.com/away'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(storedStatus).toBe('interrupted');
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
  });

  it('retries a rejected state update without committing it locally', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sendMessage = vi.mocked(browser.runtime.sendMessage);
    const defaultImplementation = sendMessage.getMockImplementation() as (message: unknown) => Promise<unknown>;
    let acceptAttention = false;
    sendMessage.mockImplementation(async (message: unknown) => {
      const request = message as RuntimeRequest;
      if (request.type === 'content:state' && request.status === 'awaiting_user' && !acceptAttention) {
        messages.push(request);
        return { ok: false, error: 'temporary rejection' };
      }
      return defaultImplementation(message);
    });
    await resume('researching');
    answer('Before I begin, could you specify the target market?');
    await vi.advanceTimersByTimeAsync(4000);
    expect(storedStatus).toBe('researching');
    expect(messages.some((message) => message.type === 'content:state' && message.status === 'awaiting_user')).toBe(true);
    acceptAttention = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(storedStatus).toBe('awaiting_user');
    expect(messages.filter((message) => message.type === 'content:state' && message.status === 'awaiting_user').length).toBeGreaterThanOrEqual(2);
  });

  it('redelivers a report when capturing was persisted without a durable job', async () => {
    answer();
    await resume('capturing');
    await vi.advanceTimersByTimeAsync(120000);
    expect(captures()).toHaveLength(1);
  });

  it('does not redeliver a report already accepted by the durable queue', async () => {
    answer();
    await resume('capturing', true);
    await vi.advanceTimersByTimeAsync(120000);
    expect(captures()).toHaveLength(0);
  });

  it('recovers an in-flight answer while resuming submitting', async () => {
    answer('An initial partial answer');
    const stop = document.createElement('button');
    stop.style.position = 'fixed';
    stop.setAttribute('aria-label', 'Stop generating');
    document.body.append(stop);
    await resume('submitting');
    expect(storedStatus).toBe('researching');
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'manual_required' }));
    document.querySelector('h2')!.textContent = report;
    stop.remove();
    await vi.advanceTimersByTimeAsync(120000);
    expect(captures()).toHaveLength(1);
  });

  it('does not treat a prior answer as proof that a reloaded submission was sent', async () => {
    answer('An answer from the previous query');
    await resume('submitting');
    expect(storedStatus).toBe('manual_required');
    await vi.advanceTimersByTimeAsync(120000);
    expect(captures()).toHaveLength(0);
  });

  it('times out a researching provider that never reaches a report', async () => {
    await resume('researching', false, Date.now() - 45 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(storedStatus).toBe('manual_required');
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'content:state', status: 'manual_required', detail: expect.stringContaining('45 minutes'),
    }));
  });

  it('captures an available final report before applying the research timeout', async () => {
    answer();
    await resume('researching', false, Date.now() - 45 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'manual_required' }));
  });

  it('requests manual confirmation for an uncertain submission and captures a later answer', async () => {
    await resume('submitting');
    await vi.advanceTimersByTimeAsync(10000);
    expect(storedStatus).toBe('manual_required');
    expect(captures()).toHaveLength(0);
    answer();
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
  });

  it('captures a finished short report whose title begins with Searching', async () => {
    answer('Searching for extraterrestrial intelligence. Radio surveys have examined nearby stars for artificial narrowband signals. No confirmed detection has been reported, and current limits remain sensitive to assumptions about transmitter power and duty cycle.');
    await resume('researching');
    await vi.advanceTimersByTimeAsync(120000);
    expect(captures()).toHaveLength(1);
  });

  it.each(["I'll start researching the requested topic now.", 'I’m researching the requested topic now.', 'Searching…'])('keeps monitoring genuine progress: %s', async (progress) => {
    answer();
    const paragraph = document.createElement('p');
    paragraph.textContent = progress;
    document.querySelector('h2')!.replaceWith(paragraph);
    await resume('researching');
    await vi.advanceTimersByTimeAsync(120000);
    expect(captures()).toHaveLength(0);
    document.querySelector('p')!.textContent = report;
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
  });

  it('uses a report body and copy control to distinguish a research title from progress', async () => {
    answer('Starting research in astronomy');
    const body = document.createElement('p');
    body.textContent = report;
    document.querySelector('h2')!.after(body);
    await resume('researching');
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
  });

  it('does not treat an unrelated page Copy button as response completion on resume', async () => {
    document.body.innerHTML = `
      <div style="position:fixed" data-message-author-role="assistant">An incomplete partial result.</div>
      <button style="position:fixed" aria-label="Copy prompt">Copy</button>
    `;
    await resume('researching');
    await vi.advanceTimersByTimeAsync(120000);
    expect(captures()).toHaveLength(0);
  });

  it('accepts a Copy control in a nearby single-response container', async () => {
    document.body.innerHTML = `
      <section>
        <div style="position:fixed" data-message-author-role="assistant">${report}</div>
        <button style="position:fixed" aria-label="Copy response">Copy</button>
      </section>
    `;
    await resume('researching');
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
  });

  it('associates a shared turn control with the nearest assistant response', () => {
    document.body.innerHTML = `
      <section>
        <div style="position:fixed" data-message-author-role="assistant">Progress</div>
        <div style="position:fixed" data-message-author-role="assistant">Final report</div>
        <button style="position:fixed;opacity:0" aria-label="Copy response">Copy</button>
      </section>
    `;
    const roots = Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]'));
    const selector = ADAPTERS.chatgpt.selectors.copyButton;
    expect(findResponseControl(roots[0]!, roots, selector)).toBeNull();
    expect(findResponseControl(roots[1]!, roots, selector, new Set(), true)).toBe(document.querySelector('button'));
  });

  it('rejects hidden and non-interactive decoy Copy controls', () => {
    document.body.innerHTML = `
      <section>
        <div style="position:fixed" data-message-author-role="assistant">Final report</div>
        <button id="real-copy" style="position:fixed;opacity:0" aria-label="Copy response">Copy</button>
        <button style="position:fixed;pointer-events:none" aria-label="Copy response">Copy</button>
        <div aria-hidden="true"><button style="position:fixed" aria-label="Copy response">Copy</button></div>
      </section>
    `;
    const roots = Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]'));
    expect(findResponseControl(roots[0]!, roots, ADAPTERS.chatgpt.selectors.copyButton, new Set(), true))
      .toBe(document.querySelector('#real-copy'));
  });

  it('prefers the response Copy control over a nested Copy code control', () => {
    document.body.innerHTML = `
      <section>
        <div style="position:fixed" data-message-author-role="assistant">
          <pre><button style="position:fixed" aria-label="Copy">Copy code</button></pre>
        </div>
        <button style="position:fixed" aria-label="Copy response">Copy</button>
      </section>
    `;
    const roots = Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]'));
    expect(findResponseControl(roots[0]!, roots, ADAPTERS.chatgpt.selectors.copyButton))
      .toBe(document.querySelector('[aria-label="Copy response"]'));
  });

  it('captures a response temporarily hidden behind an accessible modal layer', async () => {
    const longReport = report.repeat(10);
    document.body.innerHTML = `
      <main aria-hidden="true" style="opacity:0">
        <section>
          <div style="position:fixed" data-message-author-role="assistant"><h2>${longReport}</h2></div>
          <button style="position:fixed;opacity:0" aria-label="Copy response">Copy</button>
        </section>
      </main>
    `;
    await resume('researching');
    await vi.advanceTimersByTimeAsync(40000);
    expect(captures()).toHaveLength(1);
    expect(captures()[0]).toMatchObject({ domMarkdown: expect.stringContaining('completed research report') });
  });

  it('keeps the synchronous response snapshot when React replaces the node during source capture', async () => {
    document.body.innerHTML = `
      <section>
        <div style="position:fixed" data-message-author-role="assistant"><h2>${report}</h2></div>
        <button style="position:fixed" aria-label="Copy response">Copy</button>
        <button style="position:fixed" aria-label="Sources" aria-expanded="false">Sources</button>
      </section>
    `;
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Sources"]')!;
    toggle.addEventListener('click', () => {
      const replacement = document.createElement('div');
      replacement.style.position = 'fixed';
      replacement.setAttribute('data-message-author-role', 'assistant');
      document.querySelector('[data-message-author-role="assistant"]')!.replaceWith(replacement);
    }, { once: true });
    await resume('researching');
    await vi.advanceTimersByTimeAsync(15000);
    expect(captures()[0]).toMatchObject({ domMarkdown: expect.stringContaining('completed research report') });
  });

  it('finds a Grok Sources control beyond the former three-ancestor limit', () => {
    document.body.innerHTML = `
      <section>
        <div><div><div><article style="position:fixed">Final report</article></div></div></div>
        <button style="position:fixed" aria-label="4 sources">Sources</button>
      </section>
    `;
    const root = document.querySelector<HTMLElement>('article')!;
    expect(findResponseControl(root, [root], ADAPTERS.grok.selectors.sourcesPanelToggle!))
      .toBe(document.querySelector('button'));
  });

  it('does not attribute an earlier answer Sources control to the latest answer', () => {
    document.body.innerHTML = `
      <section><article id="earlier"></article><button style="position:fixed" aria-label="3 sources"></button></section>
      <section><article id="latest"></article></section>
    `;
    const roots = Array.from(document.querySelectorAll<HTMLElement>('article'));
    const selector = ADAPTERS.grok.selectors.sourcesPanelToggle!;
    expect(findResponseControl(roots[0]!, roots, selector)).toBe(document.querySelector('button'));
    expect(findResponseControl(roots[1]!, roots, selector)).toBeNull();
  });
});
