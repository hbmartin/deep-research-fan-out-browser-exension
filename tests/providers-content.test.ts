import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADAPTERS, type SelectorChain } from '../src/adapters';
import type { BackgroundEvent, RuntimeRequest } from '../src/messages';
import { canTransition } from '../src/state';
import type { ProviderRunStatus } from '../src/types';

let listener: (event: BackgroundEvent) => Promise<unknown>;
let messages: RuntimeRequest[];
let storedStatus: ProviderRunStatus;
let invalidTransitions: string[];
let findResponseControl: (root: HTMLElement, roots: readonly HTMLElement[], selectors: SelectorChain, baseline?: ReadonlySet<HTMLElement>) => HTMLElement | null;
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

async function resume(status: 'researching' | 'capturing' | 'submitting', captureAccepted = false) {
  storedStatus = status;
  await listener({ type: 'content:start', runId: 'review-run', provider: 'chatgpt', query: 'Research topic', appendString: '', geminiAutoApprove: true, completionDebounceMs: 3000, resumeOnly: true, status, captureAccepted });
}

function captures() { return messages.filter((message) => message.type === 'content:capture'); }

describe('provider content-script recovery', () => {
  it('control: resuming researching captures an already rendered report', async () => {
    answer();
    await resume('researching');
    await vi.advanceTimersByTimeAsync(10000);
    expect(captures()).toHaveLength(1);
    const capturingIndex = messages.findIndex((message) => message.type === 'content:state' && message.status === 'capturing');
    const captureIndex = messages.findIndex((message) => message.type === 'content:capture');
    expect(capturingIndex).toBeGreaterThanOrEqual(0);
    expect(capturingIndex).toBeLessThan(captureIndex);
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
    expect(storedStatus).toBe('capturing');

    // The first failed delivery backs off for five seconds.
    await vi.advanceTimersByTimeAsync(2000);
    expect(captures()).toHaveLength(1);
    const notice = document.createElement('div');
    notice.style.position = 'fixed';
    notice.textContent = 'You have reached your deep research limit.';
    document.body.append(notice);
    await vi.advanceTimersByTimeAsync(2000);

    expect(storedStatus).toBe('capturing');
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
    await resume('submitting');
    expect(storedStatus).toBe('researching');
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'manual_required' }));
    document.querySelector('h2')!.textContent = report;
    await vi.advanceTimersByTimeAsync(120000);
    expect(captures()).toHaveLength(1);
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
