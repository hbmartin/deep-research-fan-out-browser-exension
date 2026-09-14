import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundEvent, RuntimeRequest } from '../src/messages';
import { canTransition } from '../src/state';
import type { ProviderRunStatus } from '../src/types';

let listener: (event: BackgroundEvent) => Promise<unknown>;
let messages: RuntimeRequest[];
let storedStatus: ProviderRunStatus;
let submittedAt: number | undefined;
let researchTimedOutAt: number | undefined;
let invalidTransitions: string[];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  messages = [];
  invalidTransitions = [];
  submittedAt = undefined;
  researchTimedOutAt = undefined;
  document.body.replaceChildren();
  vi.stubGlobal('location', new URL('https://gemini.google.com/app/review'));
  vi.stubGlobal('defineContentScript', (value: unknown) => value);
  vi.stubGlobal('browser', { runtime: {
    onMessage: { addListener: (fn: typeof listener) => { listener = fn; } },
    sendMessage: vi.fn(async (message: RuntimeRequest) => {
      messages.push(message);
      if (message.type !== 'content:state') return { ok: true };
      if (!canTransition(storedStatus, message.status)) {
        invalidTransitions.push(`${storedStatus} -> ${message.status}`);
        return { ok: false, error: 'Invalid transition' };
      }
      storedStatus = message.status;
      if (message.status === 'researching') {
        submittedAt = message.submittedAt;
        researchTimedOutAt = undefined;
      } else if (message.reason === 'research_timeout') {
        researchTimedOutAt ??= Date.now();
      }
      return { ok: true, providerState: { status: storedStatus, submittedAt, researchTimedOutAt } };
    }),
  } });
  const module = await import('../entrypoints/providers.content');
  (module.default as unknown as { main(): void }).main();
});

afterEach(async () => {
  await listener?.({ type: 'content:stop', runId: 'gemini-run' });
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(invalidTransitions).toEqual([]);
});

function response(text: string): void {
  document.body.innerHTML = `<model-response style="position:fixed"><p>${text}</p></model-response>`;
}

function planButton(): HTMLButtonElement {
  const button = document.createElement('button');
  button.style.position = 'fixed';
  button.setAttribute('aria-label', 'Start research');
  button.textContent = 'Start research';
  document.body.append(button);
  return button;
}

async function start(status: 'researching' | 'manual_required' | 'awaiting_user', timedOut = false): Promise<void> {
  storedStatus = status;
  submittedAt = Date.now() - 45 * 60 * 1000;
  researchTimedOutAt = timedOut ? Date.now() - 60_000 : undefined;
  await listener({
    type: 'content:start', runId: 'gemini-run', provider: 'gemini', query: 'Research topic', appendString: '',
    geminiAutoApprove: true, completionDebounceMs: 3000, resumeOnly: true,
    status, submittedAt, researchTimedOutAt, conversationKey: 'https://gemini.google.com/app/review',
  });
}

describe('Gemini plan timeout recovery', () => {
  it('times out, retries a persistent plan three times, then asks the user', async () => {
    response('A research plan is ready for approval.');
    const plan = planButton();
    const click = vi.fn();
    plan.addEventListener('click', click);

    await start('researching');
    await vi.advanceTimersByTimeAsync(20_000);

    expect(storedStatus).toBe('awaiting_user');
    expect(click).toHaveBeenCalledTimes(3);
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'content:state', status: 'manual_required', reason: 'research_timeout',
    }));
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'researching' }));
  });

  it('preserves per-element retry counts across visibility gaps and resets only for a new element', async () => {
    response('A research plan is ready for approval.');
    const firstPlan = planButton();
    const firstClick = vi.fn();
    firstPlan.addEventListener('click', firstClick);
    await start('awaiting_user');
    await vi.advanceTimersByTimeAsync(500);
    expect(firstClick).toHaveBeenCalledTimes(1);

    firstPlan.style.display = 'none';
    await vi.advanceTimersByTimeAsync(3000);
    firstPlan.style.display = '';
    await vi.advanceTimersByTimeAsync(4000);
    expect(firstClick).toHaveBeenCalledTimes(3);

    firstPlan.remove();
    const replacementPlan = planButton();
    const replacementClick = vi.fn();
    replacementPlan.addEventListener('click', replacementClick);
    await vi.advanceTimersByTimeAsync(6000);
    expect(replacementClick).toHaveBeenCalledTimes(3);
  });

  it('grants a fresh interval only after the plan disappears and verified progress begins', async () => {
    response('A research plan is ready for approval.');
    const plan = planButton();
    await start('manual_required', true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'researching' }));

    const resumedAt = Date.now();
    plan.remove();
    document.querySelector('p')!.textContent = 'Researching the requested topic now…';
    await vi.advanceTimersByTimeAsync(2000);

    const resumed = messages.find((message) => message.type === 'content:state' && message.status === 'researching');
    expect(resumed).toMatchObject({ submittedAt: expect.any(Number) });
    expect((resumed as Extract<RuntimeRequest, { type: 'content:state' }>).submittedAt).toBeGreaterThanOrEqual(resumedAt);
    expect(researchTimedOutAt).toBeUndefined();
  });

  it('confirms plan approval from new research activity even if the plan control remains mounted', async () => {
    response('A research plan is ready for approval.');
    const plan = planButton();
    const click = vi.fn();
    plan.addEventListener('click', click);
    await start('manual_required');
    await vi.advanceTimersByTimeAsync(500);
    expect(click).toHaveBeenCalledTimes(1);

    document.body.insertAdjacentHTML('beforeend', '<span style="position:fixed">Researching · 1 source</span>');
    await vi.advanceTimersByTimeAsync(2000);
    expect(storedStatus).toBe('researching');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('prioritizes a page-level quota notice over simultaneous streaming and plan controls', async () => {
    response('A partial response that must not hide the terminal page notice.');
    const plan = planButton();
    const click = vi.fn();
    plan.addEventListener('click', click);
    document.body.insertAdjacentHTML('beforeend', `
      <button style="position:fixed" aria-label="Stop response"></button>
      <span style="position:fixed">Your deep research limit has been reached.</span>
    `);
    await start('researching');
    await vi.advanceTimersByTimeAsync(2000);

    expect(storedStatus).toBe('quota_exhausted');
    expect(click).not.toHaveBeenCalled();
  });

  it('leaves awaiting-user state when a plain-text progress indicator appears', async () => {
    await start('awaiting_user');
    const resumedAt = Date.now();
    document.body.innerHTML = '<span style="position:fixed">Researching · 23 sources</span>';
    await vi.advanceTimersByTimeAsync(2000);

    expect(storedStatus).toBe('researching');
    expect(submittedAt).toBeGreaterThanOrEqual(resumedAt);
  });

  it('uses a progress-pill state change to recover a hydrated timeout without a response root', async () => {
    document.body.innerHTML = '<button style="position:fixed">Researching · 23 sources</button>';
    await start('manual_required', true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(storedStatus).toBe('manual_required');

    const resumedAt = Date.now();
    document.querySelector('button')!.textContent = 'Researching · 24 sources';
    await vi.advanceTimersByTimeAsync(2000);
    expect(storedStatus).toBe('researching');
    expect(submittedAt).toBeGreaterThanOrEqual(resumedAt);
  });
});
