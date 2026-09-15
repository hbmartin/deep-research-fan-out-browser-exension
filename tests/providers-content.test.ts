import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADAPTERS, type SelectorChain } from '../src/adapters';
import type { BackgroundEvent, RuntimeRequest } from '../src/messages';
import copyFeedback from './fixtures/chatgpt-copy-feedback.json';
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
    conversationKey: 'https://chatgpt.com/c/review',
  });
}

function captures() { return messages.filter((message) => message.type === 'content:capture'); }

describe('provider content-script recovery', () => {
  it('returns the latest normalized DOM snapshot without an active run', async () => {
    answer('Current response with supporting evidence.');
    document.querySelector('h2')!.insertAdjacentHTML('beforeend', ' <a style="position:fixed" href="https://example.com/source">Source</a>');
    const result = await listener({ type: 'capture:dom-current', provider: 'chatgpt' });
    expect(result).toMatchObject({
      domMarkdown: expect.stringContaining('Current response with supporting evidence.'),
      domCitations: [expect.objectContaining({ url: 'https://example.com/source' })],
    });
    expect(captures()).toHaveLength(0);
  });

  it('reports a useful error when no current response exists', async () => {
    await expect(listener({ type: 'capture:dom-current', provider: 'chatgpt' }))
      .rejects.toThrow('No ChatGPT response is available to copy.');
  });

  it('control: resuming researching captures an already rendered report', async () => {
    answer();
    await resume('researching');
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'capturing' }));
    expect(storedStatus).toBe('capturing');
  });

  it('builds one anonymous response snapshot during a non-streaming inspection', async () => {
    answer(report.repeat(10));
    document.querySelector('[aria-label="Copy response"]')!.remove();
    const root = document.querySelector<HTMLElement>('[data-message-author-role="assistant"]')!;
    const clone = vi.spyOn(root, 'cloneNode');

    await resume('researching');
    await vi.advanceTimersByTimeAsync(0);

    expect(clone).toHaveBeenCalledTimes(1);
    expect(captures()).toHaveLength(0);
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

  it.each([
    'https://chatgpt.com/',
    'https://chatgpt.com/library',
  ])('defers a bound run after recoverable provider navigation to %s', async (url) => {
    await resume('researching');
    vi.stubGlobal('location', new URL(url));

    await vi.advanceTimersByTimeAsync(2000);

    expect(storedStatus).toBe('manual_required');
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'content:state', status: 'manual_required', reason: 'provider_navigation',
      conversationKey: 'https://chatgpt.com/c/review',
    }));
    expect(messages).not.toContainEqual(expect.objectContaining({ reason: 'research_timeout' }));
  });

  it('interrupts a bound run after navigation to a different conversation', async () => {
    await resume('researching');
    vi.stubGlobal('location', new URL('https://chatgpt.com/c/other'));

    await vi.advanceTimersByTimeAsync(2000);

    expect(storedStatus).toBe('interrupted');
    expect(messages).not.toContainEqual(expect.objectContaining({ reason: 'provider_navigation' }));
  });

  it('keeps overdue research recoverable when navigation hides provider progress', async () => {
    await resume('researching', false, Date.now() - 45 * 60 * 1000);
    vi.stubGlobal('location', new URL('https://chatgpt.com/settings'));

    await vi.advanceTimersByTimeAsync(2000);

    expect(storedStatus).toBe('manual_required');
    expect(messages).toContainEqual(expect.objectContaining({ reason: 'provider_navigation' }));
    expect(messages).not.toContainEqual(expect.objectContaining({ reason: 'research_timeout' }));
  });

  it('reports each timeout-latched library detachment once and rearms after returning', async () => {
    storedStatus = 'manual_required';
    await listener({
      type: 'content:start', runId: 'review-run', provider: 'chatgpt', query: 'Research topic', appendString: '',
      geminiAutoApprove: true, completionDebounceMs: 3000, resumeOnly: true,
      status: 'manual_required', submittedAt: Date.now() - 46 * 60 * 1000,
      researchTimedOutAt: Date.now() - 60_000, conversationKey: 'https://chatgpt.com/c/review',
    });
    vi.stubGlobal('location', new URL('https://chatgpt.com/library'));
    await vi.advanceTimersByTimeAsync(10_000);
    const navigationMessages = () => messages.filter((message) => message.type === 'content:state' && message.reason === 'provider_navigation');
    expect(navigationMessages()).toHaveLength(1);
    expect(messages).not.toContainEqual(expect.objectContaining({ reason: 'research_timeout' }));

    vi.stubGlobal('location', new URL('https://chatgpt.com/c/review'));
    await vi.advanceTimersByTimeAsync(2000);
    vi.stubGlobal('location', new URL('https://chatgpt.com/library'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(navigationMessages()).toHaveLength(2);
    expect(storedStatus).toBe('manual_required');
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
    await vi.advanceTimersByTimeAsync(5000);
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

  it.each([
    'Before I begin, could you specify the target market?',
    'Your deep research limit has been reached.',
  ])('does not classify partial response text while a streaming indicator is present: %s', async (text) => {
    answer(text);
    document.body.insertAdjacentHTML('beforeend', '<button style="position:fixed" aria-label="Stop generating"></button>');
    await resume('researching');
    const root = document.querySelector<HTMLElement>('[data-message-author-role="assistant"]')!;
    const clone = vi.spyOn(root, 'cloneNode');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(storedStatus).toBe('researching');
    expect(captures()).toHaveLength(0);
    expect(clone).not.toHaveBeenCalled();
  });

  it('ignores quota-like text in the user turn and sidebar while streaming', async () => {
    document.body.innerHTML = `
      <aside style="position:fixed">Upgrade for more deep research</aside>
      <div style="position:fixed" data-message-author-role="user">Compare Upgrade research plans</div>
      <div style="position:fixed" data-message-author-role="assistant">Partial answer</div>
      <button style="position:fixed" aria-label="Stop generating"></button>
    `;
    await resume('researching');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(storedStatus).toBe('researching');
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'quota_exhausted' }));
  });

  it.each([
    '<div role="alert" style="position:fixed">You\'ve reached your deep research limit.</div>',
    '<form role="dialog" style="position:fixed"><div style="position:fixed">You\'ve reached your deep research limit.</div></form>',
  ])('detects a reached quota notice in a semantic region: %s', async (markup) => {
    document.body.innerHTML = `${markup}<button style="position:fixed" aria-label="Stop generating"></button>`;
    await resume('researching');
    await vi.advanceTimersByTimeAsync(2000);

    expect(storedStatus).toBe('quota_exhausted');
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'content:state', status: 'quota_exhausted',
    }));
  });

  it('ignores a standalone upsell and non-semantic limit text while a response streams', async () => {
    document.body.innerHTML = `
      <aside style="position:fixed">Upgrade to SuperGrok for more DeepSearch.</aside>
      <div style="position:fixed">You've reached your deep research limit.</div>
      <div style="position:fixed" data-message-author-role="assistant">The report is still streaming.</div>
      <button style="position:fixed" aria-label="Stop generating"></button>
    `;
    await resume('researching');
    await vi.advanceTimersByTimeAsync(2000);

    expect(storedStatus).toBe('researching');
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'quota_exhausted' }));
  });

  it('still accepts a completed assistant quota response without a page-level alert', async () => {
    await resume('researching');
    answer("You've reached your deep research limit. Please try again later.");
    await vi.advanceTimersByTimeAsync(4000);

    expect(storedStatus).toBe('quota_exhausted');
    expect(messages).toContainEqual(expect.objectContaining({ type: 'content:state', status: 'quota_exhausted' }));
  });

  it('ignores an exact quota sentence inside the composer', async () => {
    document.body.innerHTML = `
      <div id="prompt-textarea" contenteditable="true">You've reached your deep research limit.</div>
      <button style="position:fixed" aria-label="Stop generating"></button>
    `;
    await resume('researching');
    await vi.advanceTimersByTimeAsync(2000);

    expect(storedStatus).toBe('researching');
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'quota_exhausted' }));
  });

  it('does not treat a prior answer as proof that a reloaded submission was sent', async () => {
    answer('An answer from the previous query');
    await resume('submitting');
    expect(storedStatus).toBe('manual_required');
    await vi.advanceTimersByTimeAsync(120000);
    expect(captures()).toHaveLength(0);
  });

  it('binds the current conversation before reporting an uncertain resumed submission', async () => {
    storedStatus = 'submitting';
    await listener({
      type: 'content:start', runId: 'review-run', provider: 'chatgpt', query: 'Research topic', appendString: '',
      geminiAutoApprove: true, completionDebounceMs: 3000, resumeOnly: true, status: 'submitting',
    });

    expect(messages).toContainEqual(expect.objectContaining({
      type: 'content:state', status: 'manual_required', conversationKey: 'https://chatgpt.com/c/review',
    }));
  });

  it('does not use an ancestor-hidden historical Stop control to confirm a reloaded submission', async () => {
    answer('An answer from the previous query');
    document.body.insertAdjacentHTML('afterbegin', '<div aria-hidden="true"><button style="position:fixed" aria-label="Stop generating"></button></div>');
    await resume('submitting');
    expect(storedStatus).toBe('manual_required');
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'researching' }));
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

  it('rejects hidden and disabled decoy Copy controls', () => {
    document.body.innerHTML = `
      <section>
        <div style="position:fixed" data-message-author-role="assistant">Final report</div>
        <button id="real-copy" style="position:fixed;opacity:0" aria-label="Copy response">Copy</button>
        <button style="position:fixed" disabled aria-label="Copy response">Copy</button>
        <div aria-hidden="true"><button style="position:fixed" aria-label="Copy response">Copy</button></div>
      </section>
    `;
    const roots = Array.from(document.querySelectorAll<HTMLElement>('[data-message-author-role="assistant"]'));
    expect(findResponseControl(roots[0]!, roots, ADAPTERS.chatgpt.selectors.copyButton, new Set(), true))
      .toBe(document.querySelector('#real-copy'));
  });

  it('confirms a Copy action only after observing provider copy feedback', async () => {
    answer();
    await resume('researching');
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Copy response"]')!;
    button.addEventListener('click', () => document.dispatchEvent(new Event('copy')));
    await expect(listener({ type: 'capture:copy-now', jobId: 'review-run:chatgpt', conversationKey: 'https://chatgpt.com/c/review' }))
      .resolves.toEqual({ ok: true, copyConfirmed: true });
  });

  it('accepts a changed Copy field containing a copied-success phrase', async () => {
    answer();
    await resume('researching');
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Copy response"]')!;
    button.addEventListener('click', () => button.setAttribute('title', 'Response copied to the clipboard successfully'));
    await expect(listener({ type: 'capture:copy-now', jobId: 'review-run:chatgpt', conversationKey: 'https://chatgpt.com/c/review' }))
      .resolves.toEqual({ ok: true, copyConfirmed: true });
  });

  it('accepts a non-empty short DOM response only with owned Copy evidence', async () => {
    answer('OK');
    await resume('researching');
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
    expect(captures()[0]).toMatchObject({ domMarkdown: '## OK', copyControlObserved: true });
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

  it('uses hover-transparent Sources controls without stalling capture', async () => {
    document.body.innerHTML = `
      <section>
        <div style="position:fixed" data-message-author-role="assistant"><h2>${report}</h2></div>
        <button style="position:fixed" aria-label="Copy response">Copy</button>
        <button style="position:fixed;opacity:0" aria-label="Sources" aria-expanded="false">Sources</button>
      </section>
    `;
    const click = vi.fn();
    document.querySelector<HTMLButtonElement>('[aria-label="Sources"]')!.addEventListener('click', click);
    await resume('researching');
    await vi.advanceTimersByTimeAsync(10000);
    expect(click).toHaveBeenCalledTimes(2);
    expect(captures()).toHaveLength(1);
  });

  it('ignores a hidden optional Sources control outside the response layer', async () => {
    document.body.innerHTML = `
      <section>
        <div style="position:fixed" data-message-author-role="assistant"><h2>${report}</h2></div>
        <button style="position:fixed" aria-label="Copy response">Copy</button>
        <div aria-hidden="true"><button style="position:fixed" aria-label="Sources">Sources</button></div>
      </section>
    `;
    const click = vi.fn();
    document.querySelector<HTMLButtonElement>('[aria-label="Sources"]')!.addEventListener('click', click);
    await resume('researching');
    await vi.advanceTimersByTimeAsync(10000);
    expect(click).not.toHaveBeenCalled();
    expect(captures()).toHaveLength(1);
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

describe('provider reliability regressions', () => {
  function setupPage() {
    document.body.innerHTML = `<div id="prompt-textarea" contenteditable="true" role="textbox" style="position:fixed"></div><button data-testid="deep-research-pill" style="position:fixed"></button><button data-testid="send-button" style="position:fixed">Send</button>`;
    const composer = document.querySelector<HTMLElement>('#prompt-textarea')!;
    composer.addEventListener('paste', (event) => { composer.textContent = (event as ClipboardEvent).clipboardData!.getData('text/plain'); });
    const send = vi.fn(() => { composer.textContent = ''; answer(); });
    document.querySelector('[data-testid="send-button"]')!.addEventListener('click', send);
    return send;
  }
  function setupEvent() {
    return { type: 'content:start', runId: 'review-run', provider: 'chatgpt', query: 'Research topic', appendString: '', geminiAutoApprove: true, completionDebounceMs: 3000, resumeOnly: false, status: 'setting_mode' } as const;
  }
  it('resumes setting_mode without rewinding setup or submitting twice', async () => {
    storedStatus = 'setting_mode';
    const send = setupPage();
    await listener(setupEvent());
    await listener(setupEvent());
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'awaiting_ready' }));
    expect(captures()).toHaveLength(1);
  });
  it('latches manual setup synchronously while its report acknowledgement is delayed', async () => {
    storedStatus = 'setting_mode';
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true" role="textbox" style="position:fixed"></div>';
    const composer = document.querySelector<HTMLElement>('#prompt-textarea')!;
    const paste = vi.fn((event: Event) => { composer.textContent = (event as ClipboardEvent).clipboardData!.getData('text/plain'); });
    composer.addEventListener('paste', paste);
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => { acknowledge = resolve; });
    const sendMessage = vi.mocked(browser.runtime.sendMessage);
    const original = sendMessage.getMockImplementation() as (message: unknown) => Promise<unknown>;
    sendMessage.mockImplementation(async (message: unknown) => {
      const request = message as RuntimeRequest;
      if (request.type !== 'content:state' || request.status !== 'manual_required') return original(message);
      messages.push(request);
      await acknowledgement;
      storedStatus = 'manual_required';
      return { ok: true };
    });
    await listener(setupEvent());
    await vi.advanceTimersByTimeAsync(0);
    expect(paste).toHaveBeenCalledTimes(1);
    await listener(setupEvent());
    await vi.advanceTimersByTimeAsync(2000);
    expect(paste).toHaveBeenCalledTimes(1);
    acknowledge();
    await vi.advanceTimersByTimeAsync(0);
  });
  it('keeps monitoring after the first post-submit report fails', async () => {
    storedStatus = 'setting_mode';
    const send = setupPage();
    const sendMessage = vi.mocked(browser.runtime.sendMessage);
    const original = sendMessage.getMockImplementation() as (message: unknown) => Promise<unknown>;
    let failed = false;
    sendMessage.mockImplementation(async (message: unknown) => {
      if ((message as RuntimeRequest).type === 'content:state' && (message as {status?:string}).status === 'researching' && !failed) {
        failed = true;
        return { ok:false, error:'temporary transport failure' };
      }
      return original(message);
    });
    await listener(setupEvent());
    await listener(setupEvent());
    await vi.advanceTimersByTimeAsync(15000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(captures()).toHaveLength(1);
  });
  it('reattaches monitoring while a resumed-submission state report retries', async () => {
    answer();
    document.body.insertAdjacentHTML('beforeend','<button style="position:fixed" aria-label="Stop generating"></button>');
    vi.mocked(browser.runtime.sendMessage).mockImplementationOnce(async () => ({ok:false,error:'temporary failure'}));
    await resume('submitting');
    document.querySelector('[aria-label="Stop generating"]')!.remove();
    await resume('submitting');
    await vi.advanceTimersByTimeAsync(15000);
    expect(captures()).toHaveLength(1);
  });
  it('latches timeout, preserves submittedAt, and still captures a late report', async () => {
    document.body.innerHTML = '<button style="position:fixed" aria-label="Stop generating"></button>';
    const submittedAt = Date.now() - 45 * 60 * 1000;
    await resume('researching', false, submittedAt);
    await vi.advanceTimersByTimeAsync(46 * 60 * 1000);
    expect(storedStatus).toBe('manual_required');
    expect(messages.filter((m) => m.type === 'content:state' && m.status === 'manual_required')).toHaveLength(1);
    expect(messages).not.toContainEqual(expect.objectContaining({type:'content:state',status:'researching'}));
    expect(messages).toContainEqual(expect.objectContaining({type:'content:state',reason:'research_timeout',submittedAt}));
    answer();
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
  });
  it('restores a timeout latch on reload without re-reporting attention', async () => {
    document.body.innerHTML = '<button style="position:fixed" aria-label="Stop generating"></button>';
    storedStatus = 'manual_required';
    await listener({...setupEvent(), resumeOnly:true, status:'manual_required', submittedAt:Date.now()-3600000, researchTimedOutAt:Date.now()-60000});
    await vi.advanceTimersByTimeAsync(120000);
    expect(messages.filter((m) => m.type === 'content:state')).toHaveLength(0);
    answer();
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
  });
  it('does not arm timeout recovery from empty pre-hydration DOM', async () => {
    storedStatus = 'manual_required';
    await listener({...setupEvent(), resumeOnly:true, status:'manual_required', submittedAt:Date.now()-3600000, researchTimedOutAt:Date.now()-60000});
    await vi.advanceTimersByTimeAsync(10000);
    document.body.innerHTML = `
      <div style="position:fixed" data-message-author-role="assistant"><p>Researching the requested topic now…</p></div>
      <button style="position:fixed" aria-label="Stop generating"></button>
    `;
    await vi.advanceTimersByTimeAsync(10000);
    expect(messages).not.toContainEqual(expect.objectContaining({type:'content:state',status:'researching'}));

    document.querySelector('button')!.remove();
    await vi.advanceTimersByTimeAsync(6000);
    document.querySelector('p')!.textContent = 'Searching the requested topic now…';
    await vi.advanceTimersByTimeAsync(2000);
    expect(messages).toContainEqual(expect.objectContaining({type:'content:state',status:'researching',submittedAt:expect.any(Number)}));
  });
  it('ignores ticking elapsed counters and modal-only mutations after a quiet timeout checkpoint', async () => {
    document.body.innerHTML = `
      <main><div style="position:fixed" data-message-author-role="assistant">
        <p>Researching the requested topic now… <a id="late-citation" href="https://example.com/1">[1]</a></p>
        <p><span aria-label="Elapsed time">00:30</span></p>
        <li id="inline-timer">Progress details — elapsed time: 1m 30s</li>
      </div></main>
    `;
    storedStatus = 'manual_required';
    await listener({...setupEvent(), resumeOnly:true, status:'manual_required', submittedAt:Date.now()-3600000, researchTimedOutAt:Date.now()-60000});
    await vi.advanceTimersByTimeAsync(4000);
    for (let second = 31; second <= 36; second++) {
      document.querySelector('[aria-label="Elapsed time"]')!.textContent = `00:${second}`;
      document.querySelector('#inline-timer')!.textContent = `Progress details — elapsed time: 1m ${second}s`;
      document.querySelector('#late-citation')!.textContent = `[${second}]`;
      document.querySelector('#late-citation')!.setAttribute('href', `https://example.com/${second}`);
      document.querySelector('main')!.toggleAttribute('aria-hidden');
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(messages).not.toContainEqual(expect.objectContaining({type:'content:state',status:'researching'}));

    const resumedAt = Date.now();
    document.querySelector('p')!.textContent = 'Searching the requested topic now…';
    await vi.advanceTimersByTimeAsync(2000);
    const resumed = messages.find((message) => message.type === 'content:state' && message.status === 'researching');
    expect(resumed).toMatchObject({submittedAt:expect.any(Number)});
    expect((resumed as Extract<RuntimeRequest,{type:'content:state'}>).submittedAt).toBeGreaterThanOrEqual(resumedAt);
  });
  it('treats a newly appearing Stop control as post-timeout activity', async () => {
    answer('Researching the requested topic now…');
    storedStatus = 'manual_required';
    await listener({...setupEvent(), resumeOnly:true, status:'manual_required', submittedAt:Date.now()-3600000, researchTimedOutAt:Date.now()-60000});
    await vi.advanceTimersByTimeAsync(4000);

    const resumedAt = Date.now();
    document.body.insertAdjacentHTML('beforeend', '<button style="position:fixed" aria-label="Stop generating"></button>');
    await vi.advanceTimersByTimeAsync(2000);

    const resumed = messages.find((message) => message.type === 'content:state' && message.status === 'researching');
    expect(resumed).toMatchObject({submittedAt:expect.any(Number)});
    expect((resumed as Extract<RuntimeRequest,{type:'content:state'}>).submittedAt).toBeGreaterThanOrEqual(resumedAt);
  });
  it('keeps a timeout checkpoint through a missing root and an identical restoration', async () => {
    answer('Researching the requested topic now…');
    document.body.insertAdjacentHTML('beforeend', '<button style="position:fixed" aria-label="Stop generating" aria-valuenow="10"></button>');
    storedStatus = 'manual_required';
    await listener({...setupEvent(), resumeOnly:true, status:'manual_required', submittedAt:Date.now()-3600000, researchTimedOutAt:Date.now()-60000});
    await vi.advanceTimersByTimeAsync(3000);

    const originalHtml = document.body.innerHTML;
    document.body.replaceChildren();
    await vi.advanceTimersByTimeAsync(3000);
    document.body.innerHTML = originalHtml;
    document.querySelector('[aria-label="Stop generating"]')!.setAttribute('aria-valuenow', '11');
    await vi.advanceTimersByTimeAsync(3000);
    expect(messages).not.toContainEqual(expect.objectContaining({type:'content:state',status:'researching'}));

    document.querySelector('h2')!.textContent = 'Searching the requested topic now…';
    await vi.advanceTimersByTimeAsync(2000);
    expect(messages).toContainEqual(expect.objectContaining({type:'content:state',status:'researching'}));
  });
  it('lets a text-only streaming selector block capture without promoting timeout state', async () => {
    const activeAdapters = (await import('../src/adapters')).ADAPTERS;
    const selectors = activeAdapters.chatgpt.selectors.streamingIndicator;
    activeAdapters.chatgpt.selectors.streamingIndicator = [{kind:'text',value:/^working on it…$/i}];
    try {
      document.body.innerHTML = `
        <div style="position:fixed" data-message-author-role="assistant"><p>${report.repeat(10)}</p></div>
        <span style="position:fixed">Working on it…</span>
      `;
      storedStatus = 'manual_required';
      await listener({...setupEvent(), resumeOnly:true, status:'manual_required', submittedAt:Date.now()-3600000, researchTimedOutAt:Date.now()-60000});
      await vi.advanceTimersByTimeAsync(40000);
      expect(messages).not.toContainEqual(expect.objectContaining({type:'content:state',status:'researching'}));
      expect(captures()).toHaveLength(0);
    } finally {
      activeAdapters.chatgpt.selectors.streamingIndicator = selectors;
    }
  });
  it('serializes a delayed timeout acknowledgement before verified resumed research', async () => {
    const firstInterval = Date.now() - 45 * 60 * 1000;
    document.body.innerHTML = '<div style="position:fixed" data-message-author-role="assistant"><p>Researching the requested topic now…</p></div>';
    let releaseTimeout!: () => void;
    let releaseResume!: () => void;
    const timeoutGate = new Promise<void>((resolve) => { releaseTimeout = resolve; });
    const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
    const sendMessage = vi.mocked(browser.runtime.sendMessage);
    const original = sendMessage.getMockImplementation() as (message: unknown) => Promise<unknown>;
    sendMessage.mockImplementation(async (message: unknown) => {
      const request = message as RuntimeRequest;
      if (request.type === 'content:state' && request.reason === 'research_timeout') {
        messages.push(request);
        await timeoutGate;
        storedStatus = 'manual_required';
        return {ok:true,providerState:{status:'manual_required',submittedAt:firstInterval,researchTimedOutAt:Date.now()}};
      }
      if (request.type === 'content:state' && request.status === 'researching') {
        messages.push(request);
        await resumeGate;
        storedStatus = 'researching';
        return {ok:true,providerState:{status:'researching',submittedAt:request.submittedAt,researchTimedOutAt:undefined}};
      }
      return original(message);
    });

    await resume('researching', false, firstInterval);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(messages.some((message) => message.type === 'content:state' && message.reason === 'research_timeout')).toBe(true));
    await vi.advanceTimersByTimeAsync(10_000);
    const resumedAt = Date.now();
    document.querySelector('p')!.textContent = 'Searching the requested topic now…';
    await vi.advanceTimersByTimeAsync(2000);
    expect(messages.filter((message) => message.type === 'content:state' && message.status === 'researching')).toHaveLength(0);

    releaseTimeout();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(messages.some((message) => message.type === 'content:state' && message.status === 'researching')).toBe(true));
    await listener({...setupEvent(), resumeOnly:true, status:'manual_required', submittedAt:firstInterval, researchTimedOutAt:Date.now()-1000});
    releaseResume();
    await vi.advanceTimersByTimeAsync(0);
    const resumed = messages.filter((message) => message.type === 'content:state' && message.status === 'researching').at(-1)!;
    expect((resumed as Extract<RuntimeRequest,{type:'content:state'}>).submittedAt).toBeGreaterThanOrEqual(resumedAt);
    await vi.advanceTimersByTimeAsync(44 * 60 * 1000);
    expect(storedStatus).toBe('researching');
    await vi.advanceTimersByTimeAsync(65 * 1000);
    expect(storedStatus).toBe('manual_required');
  });
  it('pauses timeout during clarification and grants a fresh interval when research resumes', async () => {
    answer('Before I begin, could you specify the target market?');
    const firstInterval = Date.now() - 45 * 60 * 1000;
    await resume('researching', false, firstInterval);
    await vi.advanceTimersByTimeAsync(2000);
    expect(storedStatus).toBe('awaiting_user');
    expect(messages).not.toContainEqual(expect.objectContaining({ reason: 'research_timeout' }));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(storedStatus).toBe('awaiting_user');

    const resumedAt = Date.now();
    document.querySelector('h2')!.textContent = 'Researching the requested topic now…';
    await vi.advanceTimersByTimeAsync(2000);
    expect(storedStatus).toBe('researching');
    const resumed = messages.filter((message) => message.type === 'content:state' && message.status === 'researching').at(-1);
    expect(resumed).toMatchObject({ submittedAt: expect.any(Number) });
    expect((resumed as Extract<RuntimeRequest, { type: 'content:state' }>).submittedAt).toBeGreaterThanOrEqual(resumedAt);
    await vi.advanceTimersByTimeAsync(44 * 60 * 1000);
    expect(storedStatus).toBe('researching');
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(storedStatus).toBe('manual_required');
  });
  it('stops monitoring when the coordinator rejects a terminal report permanently', async () => {
    const sendMessage = vi.mocked(browser.runtime.sendMessage);
    const original = sendMessage.getMockImplementation() as (message: unknown) => Promise<unknown>;
    let rejected = 0;
    sendMessage.mockImplementation(async (message: unknown) => {
      if ((message as RuntimeRequest).type === 'content:state') {
        rejected++;
        return {ok:false,code:'provider_terminal',error:'ended',providerState:{status:'complete'}};
      }
      return original(message);
    });
    await resume('researching');
    vi.stubGlobal('location',new URL('https://example.com/away'));
    await vi.advanceTimersByTimeAsync(2000);
    for (let i=0;i<10;i++) { document.body.append(document.createElement('div')); await vi.advanceTimersByTimeAsync(2000); }
    expect(rejected).toBe(1);
  });
  it('does not capture a labeled progress pill even when an unrelated Copy exists', async () => {
    document.body.innerHTML = '<main><div style="position:fixed" data-message-author-role="assistant"><button>Researching…</button><span>Elapsed 00:30</span></div></main><dialog open><button style="position:fixed" aria-label="Copy">Copy</button></dialog>';
    await resume('researching');
    await vi.advanceTimersByTimeAsync(120000);
    expect(captures()).toHaveLength(0);
  });
  it('keeps citation inventory behind a modal and prunes hidden descendant citations', async () => {
    document.body.innerHTML = `<main aria-hidden="true" style="opacity:0"><div style="position:fixed" data-message-author-role="assistant"><p>${report.repeat(10)}</p><a style="position:fixed" href="https://example.com/source">Evidence</a><span aria-hidden="true"><a style="position:fixed" href="https://example.com/hidden">Hidden</a></span></div></main>`;
    await resume('researching');
    await vi.advanceTimersByTimeAsync(40000);
    expect(captures()[0]).toMatchObject({domMarkdown:expect.stringContaining('https://example.com/source'),domCitations:[expect.objectContaining({url:'https://example.com/source'})]});
  });
  it('does not capture a stable partial response while streaming is behind a modal', async () => {
    document.body.innerHTML = `<main aria-hidden="true"><div style="position:fixed" data-message-author-role="assistant"><p>${report.repeat(10)}</p></div><button style="position:fixed" aria-label="Stop generating"></button></main>`;
    await resume('researching');
    await vi.advanceTimersByTimeAsync(40000);
    expect(captures()).toHaveLength(0);
    document.querySelector('button')!.remove();
    await vi.advanceTimersByTimeAsync(40000);
    expect(captures()).toHaveLength(1);
  });
  it('does not baseline a stable-id response when same-layer hidden streaming confirms a resumed submission', async () => {
    document.body.innerHTML = `
      <main aria-hidden="true">
        <section>
          <div data-message-id="stable-answer" style="position:fixed" data-message-author-role="assistant"><p>Initial partial answer</p></div>
          <button style="position:fixed" aria-label="Stop generating"></button>
          <button style="position:fixed" aria-label="Copy response">Copy</button>
        </section>
      </main>
    `;
    await resume('submitting');
    expect(storedStatus).toBe('researching');
    document.querySelector('[aria-label="Stop generating"]')!.remove();
    document.querySelector('main')!.removeAttribute('aria-hidden');
    document.querySelector('p')!.textContent = report;
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
  });
  it('ignores an ancestor-hidden historical streaming indicator in another response layer', async () => {
    document.body.innerHTML = `
      <section aria-hidden="true">
        <div style="position:fixed" data-message-author-role="assistant">Historical response</div>
        <button style="position:fixed" aria-label="Stop generating"></button>
      </section>
      <section>
        <div style="position:fixed" data-message-author-role="assistant"><p>${report.repeat(10)}</p></div>
        <button style="position:fixed" aria-label="Copy response">Copy</button>
      </section>
    `;
    await resume('researching');
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
  });
  it('defers Sources clicks until a modal unblocks the response', async () => {
    document.body.innerHTML = `<main aria-hidden="true"><section><div style="position:fixed" data-message-author-role="assistant"><p>${report.repeat(10)}</p></div><button style="position:fixed" aria-label="Sources">Sources</button></section></main>`;
    const click = vi.fn();
    document.querySelector('button')!.addEventListener('click',click);
    await resume('researching');
    await vi.advanceTimersByTimeAsync(40000);
    expect(captures()).toHaveLength(0);
    expect(click).not.toHaveBeenCalled();
    document.querySelector('main')!.removeAttribute('aria-hidden');
    await vi.advanceTimersByTimeAsync(10000);
    expect(click).toHaveBeenCalledTimes(2);
    expect(captures()).toHaveLength(1);
  });
  it('retries after synchronous inspection snapshot setup throws', async () => {
    vi.spyOn(console,'error').mockImplementation(() => undefined);
    answer();
    const root = document.querySelector<HTMLElement>('[data-message-author-role="assistant"]')!;
    const clone = root.cloneNode.bind(root);
    let clones = 0;
    vi.spyOn(root,'cloneNode').mockImplementation((deep) => { if (++clones === 1) throw new Error('snapshot failed'); return clone(deep); });
    await resume('researching');
    await vi.advanceTimersByTimeAsync(20000);
    expect(captures()).toHaveLength(1);
    expect(clones).toBeGreaterThan(1);
  });
  it('does not clone response snapshots inside the citation polling loop', async () => {
    answer();
    const root = document.querySelector<HTMLElement>('[data-message-author-role="assistant"]')!;
    root.insertAdjacentHTML('beforeend', '<button style="position:fixed" aria-label="Sources" aria-expanded="false">Sources</button>');
    const toggle = root.querySelector<HTMLButtonElement>('[aria-label="Sources"]')!;
    let clonesAtOpen = 0;
    const clone = root.cloneNode.bind(root);
    const cloneSpy = vi.spyOn(root, 'cloneNode').mockImplementation((deep) => clone(deep));
    toggle.addEventListener('click', () => { clonesAtOpen ||= cloneSpy.mock.calls.length; });
    await resume('researching');
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
    expect(cloneSpy.mock.calls.length - clonesAtOpen).toBeLessThanOrEqual(2);
  });
  it('does not confirm arbitrary icon changes as Copy success', async () => {
    answer();
    await resume('researching');
    document.querySelector('button')!.addEventListener('click', () => { document.querySelector('button')!.innerHTML = '<svg><path d="M0 0"></path></svg>'; });
    const result = listener({type:'capture:copy-now',jobId:'review-run:chatgpt',conversationKey:'https://chatgpt.com/c/review'});
    await vi.advanceTimersByTimeAsync(600);
    await expect(result).resolves.toEqual({ok:true,copyConfirmed:false});
  });
});


describe('verified ChatGPT Copy feedback', () => {
  it.each(['observed', 'icon-only'] as const)('confirms %s success using the captured ChatGPT glyph', async (mode) => {
    answer();
    const root = document.querySelector('[data-message-author-role="assistant"]')!;
    document.querySelector('button')!.outerHTML = copyFeedback.before;
    const button = root.querySelector<HTMLButtonElement>('button')!;
    button.style.position = 'fixed';
    const success = document.createElement('div');
    success.innerHTML = copyFeedback.after;
    button.addEventListener('click', () => {
      button.innerHTML = success.querySelector('button')!.innerHTML;
      if (mode === 'observed') {
        button.setAttribute('aria-label','Response copied');
        button.setAttribute('data-copy-state','copied');
      }
    });
    await resume('researching');
    await expect(listener({type:'capture:copy-now',jobId:'review-run:chatgpt',conversationKey:'https://chatgpt.com/c/review'})).resolves.toEqual({ok:true,copyConfirmed:true});
  });
  it('does not accept a success icon that was already present before the click', async () => {
    answer();
    const button = document.querySelector('button')!;
    button.innerHTML = '<svg><use href="#lightweight-conversation-check"></use></svg>';
    await resume('researching');
    const result = listener({type:'capture:copy-now',jobId:'review-run:chatgpt',conversationKey:'https://chatgpt.com/c/review'});
    await vi.advanceTimersByTimeAsync(600);
    await expect(result).resolves.toEqual({ok:true,copyConfirmed:false});
  });
});

describe('capture cancellation and setup exceptions', () => {
  it('releases the guard after citation setup throws', async () => {
    vi.spyOn(console,'error').mockImplementation(() => undefined);
    answer();
    const root=document.querySelector<HTMLElement>('[data-message-author-role="assistant"]')!;
    root.insertAdjacentHTML('beforeend','<a style="position:fixed" href="https://example.com/source">Evidence</a>');
    const anchor=root.querySelector('a')!;
    const href=anchor.href;
    let reads=0;
    Object.defineProperty(anchor,'href',{configurable:true,get:()=> {if (++reads===1) throw new Error('citation failed'); return href;}});
    await resume('researching');
    await vi.advanceTimersByTimeAsync(20000);
    expect(captures()).toHaveLength(1);
    expect(reads).toBeGreaterThan(1);
  });
  it('releases the capture guard after synchronous Sources-control setup throws', async () => {
    vi.spyOn(console,'error').mockImplementation(() => undefined);
    const {ResponseControlIndex}=await import('../src/response-controls');
    const find=ResponseControlIndex.prototype.find;
    const copySelectors=(await import('../src/adapters')).ADAPTERS.chatgpt.selectors.copyButton;
    const sourceSelectors=(await import('../src/adapters')).ADAPTERS.chatgpt.selectors.sourcesPanelToggle;
    let failed=false;
    let inspectionIndex: InstanceType<typeof ResponseControlIndex> | undefined;
    vi.spyOn(ResponseControlIndex.prototype,'find').mockImplementation(function(this: InstanceType<typeof ResponseControlIndex>,root,selectors,baseline,hover,includeBlocked){
      if (selectors===copySelectors) inspectionIndex=this;
      if (!failed && selectors===sourceSelectors && inspectionIndex && this!==inspectionIndex) {
        failed=true;
        throw new Error('source control failed');
      }
      return find.call(this,root,selectors,baseline,hover,includeBlocked);
    });
    answer();
    await resume('researching');
    await vi.advanceTimersByTimeAsync(20000);
    expect(failed).toBe(true);
    expect(captures()).toHaveLength(1);
  });
  it('rebuilds Sources ownership after pending state-report retries', async () => {
    answer('Before I begin, could you specify the target market?');
    const sendMessage = vi.mocked(browser.runtime.sendMessage);
    const original = sendMessage.getMockImplementation() as (message: unknown) => Promise<unknown>;
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => { acknowledge = resolve; });
    sendMessage.mockImplementation(async (message: unknown) => {
      const request = message as RuntimeRequest;
      if (request.type !== 'content:state' || request.status !== 'awaiting_user') return original(message);
      messages.push(request);
      await acknowledgement;
      storedStatus = 'awaiting_user';
      return { ok: true };
    });
    await resume('researching');
    await vi.advanceTimersByTimeAsync(2000);
    document.querySelector('h2')!.textContent = report;
    const oldToggle = document.createElement('button');
    oldToggle.style.position = 'fixed';
    oldToggle.setAttribute('aria-label', 'Sources');
    const oldClick = vi.fn();
    oldToggle.addEventListener('click', oldClick);
    document.querySelector('[data-message-author-role="assistant"]')!.append(oldToggle);
    await vi.advanceTimersByTimeAsync(4000);
    oldToggle.remove();
    acknowledge();
    await vi.advanceTimersByTimeAsync(2000);
    expect(oldClick).not.toHaveBeenCalled();
    expect(captures()).toHaveLength(1);
  });
  it('cancels old source capture without blocking or clearing a newer run', async () => {
    vi.spyOn(console,'error').mockImplementation(() => undefined);
    answer();
    document.querySelector('[data-message-author-role="assistant"]')!.insertAdjacentHTML('beforeend','<button style="position:fixed" aria-label="Sources">Sources</button>');
    await resume('researching');
    await vi.advanceTimersByTimeAsync(4100);
    expect(captures()).toHaveLength(0);
    answer('A newer complete response with substantial evidence and a different conclusion.');
    storedStatus='researching';
    await listener({type:'content:start',runId:'newer-run',provider:'chatgpt',query:'New topic',appendString:'',geminiAutoApprove:true,completionDebounceMs:3000,resumeOnly:true,status:'researching'});
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
    expect(captures()[0]).toMatchObject({runId:'newer-run',domMarkdown:expect.stringContaining('newer complete response')});
    await listener({type:'content:stop',runId:'newer-run'});
  });
  it('does not use an unrelated asynchronous copy event as provider confirmation', async () => {
    answer();
    await resume('researching');
    const result=listener({type:'capture:copy-now',jobId:'review-run:chatgpt',conversationKey:'https://chatgpt.com/c/review'});
    document.dispatchEvent(new Event('copy'));
    await vi.advanceTimersByTimeAsync(600);
    await expect(result).resolves.toEqual({ok:true,copyConfirmed:false});
  });
  it('starts a fresh interval only after a timed-out response genuinely changes', async () => {
    answer('A short partial response that is not yet complete.');
    document.querySelector('button')!.remove();
    await resume('researching',false,Date.now()-3600000);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(storedStatus).toBe('manual_required');
    expect(captures()).toHaveLength(0);

    const resumedAt = Date.now();
    document.querySelector('h2')!.textContent = 'A genuinely changed partial response with a new research result.';
    await vi.advanceTimersByTimeAsync(2000);
    const resumed = messages.find((message) => message.type === 'content:state' && message.status === 'researching');
    expect(resumed).toMatchObject({submittedAt:expect.any(Number)});
    expect((resumed as Extract<RuntimeRequest,{type:'content:state'}>).submittedAt).toBeGreaterThanOrEqual(resumedAt);
  });
});
