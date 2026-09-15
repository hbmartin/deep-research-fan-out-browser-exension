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

function captures(): RuntimeRequest[] {
  return messages.filter((message) => message.type === 'content:capture');
}

async function start(
  status: 'researching' | 'manual_required' | 'awaiting_user',
  timedOut = false,
  startedAt = Date.now() - 45 * 60 * 1000,
  autoApprove = true,
): Promise<void> {
  storedStatus = status;
  submittedAt = startedAt;
  researchTimedOutAt = timedOut ? Date.now() - 60_000 : undefined;
  await listener({
    type: 'content:start', runId: 'gemini-run', provider: 'gemini', query: 'Research topic', appendString: '',
    geminiAutoApprove: autoApprove, completionDebounceMs: 3000, resumeOnly: true,
    status, submittedAt, researchTimedOutAt, conversationKey: 'https://gemini.google.com/app/review',
  });
}

describe('Gemini plan timeout recovery', () => {
  it('handles a visible plan before a simultaneous Stop control', async () => {
    response('A research plan is ready for approval.');
    const plan = planButton();
    const click = vi.fn();
    plan.addEventListener('click', click);
    document.body.insertAdjacentHTML('beforeend', '<button style="position:fixed" aria-label="Stop response"></button>');

    await start('awaiting_user');
    await vi.advanceTimersByTimeAsync(500);

    expect(click).toHaveBeenCalledTimes(1);
    expect(storedStatus).toBe('awaiting_user');
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'researching' }));

    plan.remove();
    document.querySelector('[aria-label="Stop response"]')!.remove();
    await vi.advanceTimersByTimeAsync(2000);
    expect(storedStatus).toBe('researching');
  });

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

  it('preserves the per-plan retry limit across replacement elements', async () => {
    response('A research plan is ready for approval.');
    const firstPlan = planButton();
    const firstClick = vi.fn();
    firstPlan.addEventListener('click', firstClick);
    await start('awaiting_user');
    await vi.advanceTimersByTimeAsync(500);
    expect(firstClick).toHaveBeenCalledTimes(1);

    firstPlan.remove();
    const replacementPlan = planButton();
    const replacementClick = vi.fn();
    replacementPlan.addEventListener('click', replacementClick);
    await vi.advanceTimersByTimeAsync(6000);
    expect(firstClick).toHaveBeenCalledTimes(1);
    expect(replacementClick).toHaveBeenCalledTimes(2);
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

  it('starts research when an observed plan is removed without a streaming indicator', async () => {
    response('A research plan is ready for approval.');
    const plan = planButton();
    await start('awaiting_user');
    await vi.advanceTimersByTimeAsync(500);

    const resumedAt = Date.now();
    plan.remove();
    await vi.advanceTimersByTimeAsync(2000);

    const resumed = messages.find((message) => message.type === 'content:state' && message.status === 'researching');
    expect(resumed).toMatchObject({ submittedAt: expect.any(Number) });
    expect((resumed as Extract<RuntimeRequest, { type: 'content:state' }>).submittedAt).toBeGreaterThanOrEqual(resumedAt);
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

  it('never captures the recorded plan after one progress tick confirms approval', async () => {
    response(`A research plan is ready for approval. ${'Detailed proposed research step. '.repeat(45)}`);
    planButton();
    await start('manual_required');
    await vi.advanceTimersByTimeAsync(500);

    document.body.insertAdjacentHTML('beforeend', '<span id="progress" style="position:fixed">Researching · 1 source</span>');
    await vi.advanceTimersByTimeAsync(2000);
    document.querySelector('#progress')!.remove();
    document.querySelector('p')!.textContent = document.querySelector('p')!.textContent!.replace('approval', 'review');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(storedStatus).toBe('researching');
    expect(captures()).toHaveLength(0);
  });

  it('captures a report that replaces a guarded plan in the same response root', async () => {
    response(`A research plan is ready for approval. ${'Detailed proposed research step. '.repeat(45)}`);
    planButton();
    await start('manual_required');
    await vi.advanceTimersByTimeAsync(500);

    document.body.insertAdjacentHTML('beforeend', '<span id="progress" style="position:fixed">Researching · 1 source</span>');
    await vi.advanceTimersByTimeAsync(2000);
    document.querySelector('#progress')!.remove();
    document.querySelector('p')!.textContent = `Completed report. ${'Evidence and analysis support the final conclusion. '.repeat(35)}`;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(captures()).toContainEqual(expect.objectContaining({
      type: 'content:capture', domMarkdown: expect.stringContaining('Completed report.'),
    }));
  });

  it('treats a revised plan in a new response as a fresh approval episode and guards it', async () => {
    response(`First research plan. ${'Proposed first research step. '.repeat(45)}`);
    const firstPlan = planButton();
    const firstClick = vi.fn();
    firstPlan.addEventListener('click', firstClick);
    await start('awaiting_user');
    await vi.advanceTimersByTimeAsync(500);
    expect(firstClick).toHaveBeenCalledTimes(1);

    document.body.insertAdjacentHTML('beforeend', '<span id="progress" style="position:fixed">Researching · 1 source</span>');
    await vi.advanceTimersByTimeAsync(2000);
    expect(storedStatus).toBe('researching');

    document.body.innerHTML = `<model-response style="position:fixed"><p>Revised research plan. ${'Changed proposed research step. '.repeat(45)}</p></model-response>`;
    const revisedPlan = planButton();
    const revisedClick = vi.fn();
    revisedPlan.addEventListener('click', revisedClick);
    await vi.advanceTimersByTimeAsync(2000);

    expect(revisedClick).toHaveBeenCalled();
    expect(captures()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(revisedClick).toHaveBeenCalledTimes(3);
    expect(captures()).toHaveLength(0);
  });

  it('still times out when an observed plan control becomes hidden but remains connected', async () => {
    response('A research plan is ready for approval.');
    const plan = planButton();
    await start('researching', false, Date.now());
    await vi.advanceTimersByTimeAsync(500);
    plan.style.display = 'none';

    await vi.advanceTimersByTimeAsync(45 * 60 * 1000 + 2000);

    expect(plan.isConnected).toBe(true);
    expect(storedStatus).toBe('manual_required');
    expect(messages.filter((message) => message.type === 'content:state' && message.reason === 'research_timeout')).toHaveLength(1);
  });

  it('prioritizes a page-level quota notice over simultaneous streaming and plan controls', async () => {
    response('A partial response that must not hide the terminal page notice.');
    const plan = planButton();
    const click = vi.fn();
    plan.addEventListener('click', click);
    document.body.insertAdjacentHTML('beforeend', `
      <button style="position:fixed" aria-label="Stop response"></button>
      <span role="alert" style="position:fixed">Your deep research limit has been reached.</span>
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

  it('does not treat a ticking plain duration suffix as resumed activity', async () => {
    document.body.innerHTML = '<button style="position:fixed">Researching 44m 59s</button>';
    await start('manual_required', true);
    await vi.advanceTimersByTimeAsync(2000);

    for (let second = 58; second >= 50; second -= 1) {
      document.querySelector('button')!.textContent = `Researching 44m ${second}s`;
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(storedStatus).toBe('manual_required');
    expect(messages).not.toContainEqual(expect.objectContaining({ type: 'content:state', status: 'researching' }));
    expect(messages.filter((message) => message.type === 'content:state' && message.reason === 'research_timeout')).toHaveLength(0);
  });
});
