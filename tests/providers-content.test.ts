import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundEvent, RuntimeRequest } from '../src/messages';
import { canTransition } from '../src/state';
import type { ProviderRunStatus } from '../src/types';

let listener: (event: BackgroundEvent) => Promise<unknown>;
let messages: RuntimeRequest[];
let storedStatus: ProviderRunStatus;
let invalidTransitions: string[];
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
  (module.default as unknown as { main(): void }).main();
});

afterEach(async () => {
  await listener?.({ type: 'content:stop', runId: 'review-run' });
  vi.clearAllTimers();
  vi.useRealTimers();
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
});
