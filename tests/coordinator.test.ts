// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADAPTERS } from '../src/adapters';
import { deleteJob, getCapture, getJob, getRun, MAX_CAPTURE_ATTEMPTS, nextCaptureJob, putCapture, putJob, putRun } from '../src/db';
import type { CaptureJob, ProviderId, ProviderRun, Run } from '../src/types';

const platform = vi.hoisted(() => ({
  configurePanelAction: vi.fn(async () => undefined),
  openPanel: vi.fn(async () => undefined),
  readClipboard: vi.fn(async () => ''),
  writeClipboard: vi.fn(async (_text: string) => undefined),
  downloadText: vi.fn<(...args: unknown[]) => Promise<number>>(),
  notify: vi.fn(async () => undefined),
  setBadge: vi.fn(async () => undefined),
  sendTabEvent: vi.fn<(_tabId: number, _event: unknown) => Promise<unknown>>(async () => undefined),
}));
const tabsGet = vi.hoisted(() => vi.fn<(_tabId: number) => Promise<Browser.tabs.Tab>>());

vi.mock('../src/platform', () => ({
  createPlatform: () => platform,
  handleOffscreenResponse: () => false,
  sendTabEvent: platform.sendTabEvent,
}));

import { coordinatorTestHooks } from '../src/coordinator';

function provider(id: ProviderId, tabId: number, status: ProviderRun['status']): ProviderRun {
  return { provider: id, tabId, status, submittedQuery: 'query', appendString: '', attempts: 0, degraded: false, adapterVersion: 'test' };
}

function run(providerRuns: Run['providerRuns'], status: Run['status'] = 'active'): Run {
  const id = crypto.randomUUID();
  return { id, browserSessionId: 'current-session', query: 'query', createdAt: Date.now(), windowId: 1, providerRuns, status, slug: id, downloadFolder: `deep-research/${id}` };
}

beforeEach(() => {
  let downloadId = 100;
  platform.downloadText.mockReset().mockImplementation(async () => downloadId++);
  platform.readClipboard.mockReset().mockResolvedValue('');
  platform.writeClipboard.mockReset().mockResolvedValue(undefined);
  platform.notify.mockReset().mockResolvedValue(undefined);
  platform.setBadge.mockClear();
  platform.sendTabEvent.mockReset().mockResolvedValue(undefined);
  tabsGet.mockReset();
  vi.stubGlobal('browser', {
    runtime: { sendMessage: vi.fn(async () => undefined), getURL: vi.fn((path: string) => path) },
    storage: {
      sync: { get: vi.fn(async () => ({})) },
      session: {
        get: vi.fn(async () => ({ 'coordinator.browser-session.v1': 'current-session' })),
        set: vi.fn(async () => undefined),
      },
    },
    tabs: { update: vi.fn(async () => undefined), get: tabsGet, query: vi.fn(async () => []) },
    tabGroups: { update: vi.fn(async () => undefined) },
  });
  coordinatorTestHooks.resetBrowserSession();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('coordinator run guards', () => {
  it('serializes capture acceptance for the same capture ID', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const first = coordinatorTestHooks.serializeCapture('same:capture', async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    await vi.waitFor(() => expect(order).toEqual(['first:start']));
    const second = coordinatorTestHooks.serializeCapture('same:capture', async () => { order.push('second'); });
    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('serializes independent mutations without losing either provider update', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 1, 'capturing'), claude: provider('claude', 2, 'researching') });
    await putRun(stored);
    await Promise.all([
      coordinatorTestHooks.mutateStoredRun(stored.id, (current) => { current.providerRuns.chatgpt!.captureId = `${stored.id}:chatgpt`; }),
      coordinatorTestHooks.mutateStoredRun(stored.id, (current) => { current.providerRuns.claude!.statusDetail = 'still researching'; }),
    ]);
    const updated = await getRun(stored.id);
    expect(updated?.providerRuns.chatgpt?.captureId).toBe(`${stored.id}:chatgpt`);
    expect(updated?.providerRuns.claude?.statusDetail).toBe('still researching');
  });

  it('downloads each provider once when finalization is called concurrently', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 3, 'complete'), claude: provider('claude', 4, 'failed') });
    await putRun(stored);
    await Promise.all([
      coordinatorTestHooks.maybeFinalize(stored),
      coordinatorTestHooks.maybeFinalize(stored),
    ]);
    expect(platform.downloadText).toHaveBeenCalledTimes(2);
    const updated = await getRun(stored.id);
    expect(updated?.status).toBe('complete');
    expect(updated?.completedAt).toBeTypeOf('number');
  });

  it('resumes finalization without redownloading providers already persisted', async () => {
    const chatgpt = provider('chatgpt', 5, 'complete');
    chatgpt.downloadedAt = 123;
    chatgpt.downloadId = 99;
    const stored = run({ chatgpt, claude: provider('claude', 6, 'complete') }, 'finalizing');
    await putRun(stored);
    await coordinatorTestHooks.maybeFinalize(stored);
    expect(platform.downloadText).toHaveBeenCalledTimes(1);
    expect(await getRun(stored.id)).toMatchObject({ status: 'complete' });
  });

  it('interrupts only after three consecutive reconciliation failures and resets on success', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 7, 'researching') });
    await putRun(stored);
    await coordinatorTestHooks.recordReconcileCheck(stored.id, 'chatgpt', false);
    await coordinatorTestHooks.recordReconcileCheck(stored.id, 'chatgpt', false);
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({ status: 'researching', reconcileFailureCount: 2 });
    await coordinatorTestHooks.recordReconcileCheck(stored.id, 'chatgpt', true);
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.reconcileFailureCount).toBeUndefined();
    await coordinatorTestHooks.recordReconcileCheck(stored.id, 'chatgpt', false);
    await coordinatorTestHooks.recordReconcileCheck(stored.id, 'chatgpt', false);
    await coordinatorTestHooks.recordReconcileCheck(stored.id, 'chatgpt', false);
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.status).toBe('interrupted');
  });

  it('does not count a provider authentication redirect as a reconciliation failure', async () => {
    const stored = run({ gemini: provider('gemini', 8, 'researching') });
    stored.providerRuns.gemini!.reconcileFailureCount = 2;
    await putRun(stored);
    tabsGet.mockResolvedValue({ id: 8, url: 'https://accounts.google.com/v3/signin' } as Browser.tabs.Tab);
    await coordinatorTestHooks.reconcileRuns();
    expect((await getRun(stored.id))?.providerRuns.gemini).toMatchObject({ status: 'researching' });
    expect((await getRun(stored.id))?.providerRuns.gemini?.reconcileFailureCount).toBeUndefined();
    expect(platform.sendTabEvent).not.toHaveBeenCalled();
  });

  it('marks a positively removed provider tab interrupted immediately', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 808, 'researching') });
    await putRun(stored);
    await coordinatorTestHooks.interruptRemovedTab(808);
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.status).toBe('interrupted');
  });

  it('ignores extension-driven activation but records genuine non-run activation', () => {
    vi.useFakeTimers();
    coordinatorTestHooks.setKnownRunTabs([]);
    const baseline = coordinatorTestHooks.getLastNonRunInteractionAt();
    coordinatorTestHooks.markExpectedTabActivation(10, 1000);
    expect(coordinatorTestHooks.recordTabActivation(10, 1500)).toBe(false);
    expect(coordinatorTestHooks.getLastNonRunInteractionAt()).toBe(baseline);
    expect(coordinatorTestHooks.recordTabActivation(11, 2000)).toBe(true);
    expect(coordinatorTestHooks.getLastNonRunInteractionAt()).toBe(2000);
  });

  it('uses exact origins and follows adapter URL-resolution configuration', async () => {
    expect(coordinatorTestHooks.isProviderUrl('https://chatgpt.com/c/123', 'chatgpt')).toBe(true);
    expect(coordinatorTestHooks.isProviderUrl('https://chatgpt.com.evil.test/', 'chatgpt')).toBe(false);
    const prior = ADAPTERS.chatgpt.urlResolution;
    ADAPTERS.chatgpt.urlResolution = 'follow_redirect';
    vi.stubGlobal('fetch', vi.fn(async () => ({ url: 'https://canonical.test/article' })));
    try {
      const result = await coordinatorTestHooks.resolveCitationUrls('chatgpt', [{
        url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/test',
        contextBefore: '', contextAfter: '', domOrder: 0,
      }]);
      expect(result.resolved).toBe(1);
      expect(result.citations[0]?.url).toBe('https://canonical.test/article');
    } finally {
      ADAPTERS.chatgpt.urlResolution = prior;
    }
  });

  it('saves an exhausted job from its durable DOM fallback', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 909, 'capturing') });
    await putRun(stored);
    await putJob({
      id: `${stored.id}:chatgpt`,
      runId: stored.id,
      provider: 'chatgpt',
      tabId: 909,
      state: 'queued',
      createdAt: Date.now(),
      attempts: MAX_CAPTURE_ATTEMPTS,
      domMarkdown: 'A sufficiently long DOM report that will not be processed.',
      domCitations: [],
    });

    await coordinatorTestHooks.processCaptureQueue();
    expect(await nextCaptureJob()).toBeUndefined();
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({
      status: 'complete',
      degraded: true,
    });
    expect(await getCapture(`${stored.id}:chatgpt`)).toMatchObject({ captureMethod: 'dom_only' });
  });

  it('links a persisted capture without overwriting a terminal status that won concurrently', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 910, 'interrupted') });
    await putRun(stored);
    await coordinatorTestHooks.reconcilePersistedCaptureFailure(
      stored.id,
      'chatgpt',
      `${stored.id}:chatgpt`,
      true,
      new Error('completion transition lost'),
    );
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({
      status: 'interrupted',
      captureId: `${stored.id}:chatgpt`,
      degraded: true,
    });
  });

  it('persists a partial research trail and marks the completed provider degraded', async () => {
    const copiedReport = 'A sufficiently long copied research report for the capture pipeline.';
    platform.readClipboard.mockResolvedValue(copiedReport);
    const stored = run({ grok: provider('grok', 911, 'capturing') });
    await putRun(stored);
    await putJob({
      id: `${stored.id}:grok`,
      runId: stored.id,
      provider: 'grok',
      tabId: 911,
      state: 'queued',
      createdAt: Date.now(),
      attempts: 0,
      domMarkdown: copiedReport,
      domCitations: [],
      researchTrail: {
        reportedResultCount: 2,
        searches: [{
          kind: 'web',
          query: 'partial search',
          expectedResultCount: 2,
          results: [{ url: 'https://example.com/result', title: 'Captured result' }],
        }],
        openedPages: [],
        warnings: [],
      },
      tabUnavailable: true,
    });

    await coordinatorTestHooks.processCaptureQueue();

    const updated = await getRun(stored.id);
    expect(updated?.providerRuns.grok).toMatchObject({ status: 'complete', degraded: true });
    const capture = await getCapture(updated?.providerRuns.grok?.captureId);
    expect(capture?.researchTrail).toMatchObject({
      expectedResultCount: 2,
      capturedResultCount: 1,
      complete: false,
    });
    expect(capture?.researchTrail?.warnings).toContain('Search 1 expected 2 results but captured 1.');
  });

  it('rejects an unchanged clipboard and restores the sentinel without exposing prior text', async () => {
    vi.useFakeTimers();
    const privateText = 'Previously copied private material that must never become a report.';
    let clipboard = privateText;
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    const job: CaptureJob = {
      id: 'run:chatgpt', runId: 'run', provider: 'chatgpt', tabId: 1, state: 'queued',
      createdAt: 1, attempts: 0, tabUnavailable: true, domMarkdown: 'DOM fallback report', domCitations: [],
    };
    const pending = coordinatorTestHooks.clipboardCapture(platform, job);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(clipboard).toBe(privateText);
  });

  it('accepts a changed clipboard and restores the user snapshot after capture', async () => {
    vi.useFakeTimers();
    const privateText = 'Previously copied private material that should be restored after capture.';
    const report = 'A newly copied provider report with enough content to pass validation.';
    let clipboard = privateText;
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    platform.sendTabEvent.mockImplementation(async () => { clipboard = report; });
    const job: CaptureJob = {
      id: 'run:chatgpt', runId: 'run', provider: 'chatgpt', tabId: 1, state: 'queued',
      createdAt: 1, attempts: 0, domMarkdown: 'A newly rendered provider report with enough content to pass validation.', domCitations: [],
    };
    const pending = coordinatorTestHooks.clipboardCapture(platform, job);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ text: report, restored: true });
    expect(clipboard).toBe(privateText);
  });

  it('accepts copy-only capture after focusing an idle provider when DOM extraction is empty', async () => {
    vi.useFakeTimers();
    const privateText = 'Previously copied private material that should be restored.';
    const report = 'A complete provider report copied after the extension focused its idle tab.';
    let clipboard = privateText;
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    platform.sendTabEvent.mockImplementation(async () => {
      clipboard = report;
      return { ok: true, copyConfirmed: true };
    });
    const job: CaptureJob = {
      id: 'run:claude', runId: 'run', provider: 'claude', tabId: 2, state: 'queued',
      createdAt: 1, attempts: 0, domMarkdown: '', domCitations: [],
    };
    const pending = coordinatorTestHooks.clipboardCapture(platform, job);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ text: report, restored: true });
    expect(browser.tabs.update).toHaveBeenCalledWith(2, { active: true });
    expect(clipboard).toBe(privateText);
  });

  it('accepts a fresh provider copy identical to the original clipboard', async () => {
    vi.useFakeTimers();
    const report = 'A complete provider research report with sufficient content for a valid capture.';
    let clipboard = report;
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    platform.sendTabEvent.mockImplementation(async () => { clipboard = report; });
    const job: CaptureJob = {
      id: 'review:chatgpt', runId: 'review', provider: 'chatgpt', tabId: 1, state: 'queued',
      createdAt: 1, attempts: 0, domMarkdown: report, domCitations: [],
    };
    const pending = coordinatorTestHooks.clipboardCapture(platform, job);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ text: report, restored: true });
    expect(platform.sendTabEvent).toHaveBeenCalledTimes(1);
    expect(clipboard).toBe(report);
  });

  it('accepts a fresh copy-only report identical to the original clipboard', async () => {
    vi.useFakeTimers();
    const original = 'The original clipboard value is long enough to resemble a provider report.';
    let clipboard = original;
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    platform.sendTabEvent.mockImplementation(async () => {
      clipboard = original;
      return { ok: true, copyConfirmed: true };
    });
    const job: CaptureJob = {
      id: 'review:claude', runId: 'review', provider: 'claude', tabId: 2, state: 'queued',
      createdAt: 1, attempts: 0, domMarkdown: '', domCitations: [],
    };
    const pending = coordinatorTestHooks.clipboardCapture(platform, job);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ text: original, restored: true });
    expect(clipboard).toBe(original);
  });

  it('rejects stale copy-only clipboard data without provider confirmation', async () => {
    vi.useFakeTimers();
    const privateText = 'Previously copied private material that must not become a provider report.';
    let clipboard = privateText;
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    platform.sendTabEvent.mockImplementation(async () => {
      clipboard = privateText;
      return { ok: true, copyConfirmed: false };
    });
    const job: CaptureJob = {
      id: 'review:claude', runId: 'review', provider: 'claude', tabId: 2, state: 'queued',
      createdAt: 1, attempts: 0, domMarkdown: '', domCitations: [],
    };
    const pending = coordinatorTestHooks.clipboardCapture(platform, job);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(clipboard).toBe(privateText);
  });

  it.each([false, true])('reports durable capture acceptance as %s when resuming capturing', async (accepted) => {
    const stored = run({ chatgpt: provider('chatgpt', 930, 'capturing') });
    const id = `${stored.id}:chatgpt`;
    await putRun(stored);
    if (accepted) await putJob({
      id, runId: stored.id, provider: 'chatgpt', tabId: 930, state: 'queued',
      createdAt: Date.now(), attempts: 0, domMarkdown: 'A complete durable report available for recovery after a reload.', domCitations: [],
    });
    await coordinatorTestHooks.handleRequest(
      { type: 'content:hello', provider: 'chatgpt', url: 'https://chatgpt.com/c/1' },
      { tab: { id: 930 } } as Browser.runtime.MessageSender,
    );
    await vi.waitFor(() => expect(platform.sendTabEvent).toHaveBeenCalledWith(930, expect.objectContaining({
      status: 'capturing', resumeOnly: true, captureAccepted: accepted,
    })));
    await deleteJob(id);
    stored.providerRuns.chatgpt!.status = 'complete';
    stored.status = 'complete';
    await putRun(stored);
  });

  it('retains a leased job when capture delivery is retried after a lost acknowledgement', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 931, 'capturing') });
    const id = `${stored.id}:chatgpt`;
    const job: CaptureJob = {
      id, runId: stored.id, provider: 'chatgpt', tabId: 931, state: 'leased', leasedAt: Date.now(),
      createdAt: Date.now(), attempts: 2, domMarkdown: 'The original complete research report already accepted into the durable queue.', domCitations: [],
    };
    await putRun(stored);
    await putJob(job);
    await expect(coordinatorTestHooks.handleRequest({
      type: 'content:capture', runId: stored.id, provider: 'chatgpt', domMarkdown: 'Changed page', domCitations: [],
    }, {})).resolves.toEqual({ ok: true });
    expect(await getJob(id)).toEqual(job);
    await coordinatorTestHooks.processCaptureQueue();
    await deleteJob(id);
    stored.providerRuns.chatgpt!.status = 'complete';
    stored.status = 'complete';
    await putRun(stored);
  });

  it('restores capturing before accepting a duplicate delivery for an existing job', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 932, 'researching') });
    const id = `${stored.id}:chatgpt`;
    const job: CaptureJob = {
      id, runId: stored.id, provider: 'chatgpt', tabId: 932, state: 'leased', leasedAt: Date.now(),
      createdAt: Date.now(), attempts: 2, domMarkdown: 'The original durable report must not be replaced by a retried delivery.', domCitations: [],
    };
    await putRun(stored);
    await putJob(job);
    await expect(coordinatorTestHooks.handleRequest({
      type: 'content:capture', runId: stored.id, provider: 'chatgpt', domMarkdown: 'Changed page', domCitations: [],
    }, {})).resolves.toEqual({ ok: true });
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.status).toBe('capturing');
    expect(await getJob(id)).toEqual(job);
    await deleteJob(id);
    stored.providerRuns.chatgpt!.status = 'complete';
    stored.status = 'complete';
    await putRun(stored);
  });

  it('rejects unrelated clipboard text copied concurrently with provider capture', async () => {
    vi.useFakeTimers();
    const original = 'The original clipboard value that should survive the failed capture.';
    const unrelated = 'Different private text copied by the user while capture was attempted.';
    let clipboard = original;
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    platform.sendTabEvent.mockImplementation(async () => { clipboard = unrelated; });
    const job: CaptureJob = {
      id: 'run:chatgpt', runId: 'run', provider: 'chatgpt', tabId: 1, state: 'queued',
      createdAt: 1, attempts: 0, tabUnavailable: true,
      domMarkdown: 'A provider report about a completely separate research topic.', domCitations: [],
    };
    const pending = coordinatorTestHooks.clipboardCapture(platform, job);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(clipboard).toBe(unrelated);
  });

  it('finishes a queued report from DOM after its provider tab closes', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 912, 'capturing') });
    await putRun(stored);
    await putJob({
      id: `${stored.id}:chatgpt`, runId: stored.id, provider: 'chatgpt', tabId: 912,
      state: 'queued', createdAt: Date.now(), attempts: 0,
      domMarkdown: 'A complete DOM report that remains usable after its tab closes.', domCitations: [],
    });
    await coordinatorTestHooks.interruptRemovedTab(912);
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({ status: 'complete', degraded: true });
    expect(await getCapture(`${stored.id}:chatgpt`)).toMatchObject({ captureMethod: 'dom_only' });
  });

  it('links a capture persisted before an exhausted job could update the run', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 913, 'capturing') });
    const id = `${stored.id}:chatgpt`;
    await putRun(stored);
    await putCapture(id, {
      rawMarkdown: 'Persisted report', normalizedMarkdown: 'Persisted report', citations: [],
      captureMethod: 'copy_only', unplacedCitationCount: 0, capturedAt: Date.now(), urlsResolved: 0, urlsUnresolved: 0,
    });
    await putJob({
      id, runId: stored.id, provider: 'chatgpt', tabId: 913, state: 'queued',
      createdAt: Date.now(), attempts: MAX_CAPTURE_ATTEMPTS, domMarkdown: 'A durable DOM fallback report.', domCitations: [],
    });
    await coordinatorTestHooks.processCaptureQueue();
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({ status: 'complete', captureId: id });
    expect(await nextCaptureJob()).toBeUndefined();
  });

  it('does not redownload when idempotently relinking the same completed capture', async () => {
    const chatgpt = provider('chatgpt', 920, 'complete');
    const stored = run({ chatgpt }, 'complete');
    const id = `${stored.id}:chatgpt`;
    stored.completedAt = 123;
    chatgpt.captureId = id;
    chatgpt.downloadedAt = 123;
    chatgpt.downloadId = 99;
    await putRun(stored);
    await putCapture(id, {
      rawMarkdown: 'Persisted report', normalizedMarkdown: 'Persisted report', citations: [],
      captureMethod: 'copy_only', unplacedCitationCount: 0, capturedAt: 1, urlsResolved: 0, urlsUnresolved: 0,
    });
    await putJob({
      id, runId: stored.id, provider: 'chatgpt', tabId: 920, state: 'queued',
      createdAt: 1, attempts: 1, domMarkdown: 'Persisted report', domCitations: [],
    });
    await coordinatorTestHooks.processCaptureQueue();
    expect(platform.downloadText).not.toHaveBeenCalled();
    expect(platform.notify).not.toHaveBeenCalled();
    expect(await getRun(stored.id)).toMatchObject({ completedAt: 123, providerRuns: { chatgpt: { downloadedAt: 123, downloadId: 99 } } });
  });

  it('leases an existing capture job before retrying a failed link', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 921, 'capturing') });
    const id = `${stored.id}:chatgpt`;
    await putRun(stored);
    await putCapture(id, {
      rawMarkdown: 'Persisted report', normalizedMarkdown: 'Persisted report', citations: [],
      captureMethod: 'copy_only', unplacedCitationCount: 0, capturedAt: 1, urlsResolved: 0, urlsUnresolved: 0,
    });
    await putJob({
      id, runId: stored.id, provider: 'chatgpt', tabId: 921, state: 'queued',
      createdAt: 1, attempts: 1, domMarkdown: 'Persisted report', domCitations: [],
    });
    platform.notify.mockRejectedValueOnce(new Error('Notification failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await coordinatorTestHooks.processCaptureQueue();
    consoleError.mockRestore();
    expect(await nextCaptureJob()).toBeUndefined();
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.status).toBe('complete');
  });

  it('fails and removes a persistently invalid capture job after the attempt limit', async () => {
    const stored = run({ grok: provider('grok', 922, 'capturing') });
    const id = `${stored.id}:grok`;
    await putRun(stored);
    await putJob({
      id, runId: stored.id, provider: 'grok', tabId: 922, state: 'queued',
      createdAt: 1, attempts: MAX_CAPTURE_ATTEMPTS - 1, tabUnavailable: true,
      domMarkdown: 'A long enough DOM report whose malformed source metadata cannot be normalized.', domCitations: [],
      researchTrail: { searches: null, openedPages: [], warnings: [] } as unknown as NonNullable<CaptureJob['researchTrail']>,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await coordinatorTestHooks.processCaptureQueue();
    consoleError.mockRestore();
    expect(await nextCaptureJob()).toBeUndefined();
    expect((await getRun(stored.id))?.providerRuns.grok?.status).toBe('failed');
  });

  it('processes later queued providers when an earlier one requires DOM fallback', async () => {
    const stored = run({
      chatgpt: provider('chatgpt', 914, 'capturing'),
      claude: provider('claude', 915, 'capturing'),
    });
    await putRun(stored);
    for (const providerId of ['chatgpt', 'claude'] as const) {
      await putJob({
        id: `${stored.id}:${providerId}`, runId: stored.id, provider: providerId,
        tabId: stored.providerRuns[providerId]!.tabId, state: 'queued', createdAt: Date.now(), attempts: 0,
        tabUnavailable: true, domMarkdown: `A sufficiently long ${providerId} DOM report for fallback capture.`, domCitations: [],
      });
    }
    await coordinatorTestHooks.processCaptureQueue();
    expect((await getRun(stored.id))?.providerRuns).toMatchObject({
      chatgpt: { status: 'complete' },
      claude: { status: 'complete' },
    });
  });

  it('marks prior-browser-session work interrupted without restarting provider automation', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 916, 'researching') });
    stored.browserSessionId = 'prior-session';
    await putRun(stored);
    await coordinatorTestHooks.reconcileRuns();
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({
      status: 'interrupted',
      statusDetail: 'Browser restarted before completion.',
    });
    expect(platform.sendTabEvent).not.toHaveBeenCalledWith(916, expect.objectContaining({ type: 'content:start' }));
  });

  it('links a prior-session persisted capture through the serialized completion path', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 925, 'researching') });
    const id = `${stored.id}:chatgpt`;
    stored.browserSessionId = 'prior-session';
    await putRun(stored);
    await putCapture(id, {
      rawMarkdown: 'Recovered report', normalizedMarkdown: 'Recovered report', citations: [],
      captureMethod: 'copy_only', unplacedCitationCount: 0, capturedAt: 1, urlsResolved: 0, urlsUnresolved: 0,
    });
    await coordinatorTestHooks.reconcileRuns();
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({ status: 'complete', captureId: id });
    expect(platform.notify).toHaveBeenCalledWith(`complete:${stored.id}:chatgpt`, 'ChatGPT finished', expect.any(String));
  });

  it('uses monitor-only resume when a provider content script reloads', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 917, 'researching') });
    await putRun(stored);
    await coordinatorTestHooks.handleRequest(
      { type: 'content:hello', provider: 'chatgpt', url: 'https://chatgpt.com/c/1' },
      { tab: { id: 917 } } as Browser.runtime.MessageSender,
    );
    await vi.waitFor(() => expect(platform.sendTabEvent).toHaveBeenCalledWith(917, expect.objectContaining({
      type: 'content:start', resumeOnly: true, status: 'researching',
    })));
  });

  it('retries automation when an opening provider content script says hello', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 923, 'opening') });
    await putRun(stored);
    await coordinatorTestHooks.handleRequest(
      { type: 'content:hello', provider: 'chatgpt', url: 'https://chatgpt.com/' },
      { tab: { id: 923 } } as Browser.runtime.MessageSender,
    );
    await vi.waitFor(() => expect(platform.sendTabEvent).toHaveBeenCalledWith(923, expect.objectContaining({
      type: 'content:start', resumeOnly: false, status: 'opening',
    })));
  });

  it('reattaches monitor-only capture using the persisted researching phase during reconciliation', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 919, 'researching') });
    await putRun(stored);
    tabsGet.mockResolvedValue({ id: 919, url: 'https://chatgpt.com/c/1' } as Browser.tabs.Tab);
    await coordinatorTestHooks.reconcileRuns();
    expect(platform.sendTabEvent).toHaveBeenCalledWith(919, expect.objectContaining({
      type: 'content:start', resumeOnly: true, status: 'researching',
    }));
  });

  it('does not send a stale resume after the provider becomes terminal during reconciliation', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 924, 'researching') });
    await putRun(stored);
    tabsGet.mockImplementation(async () => {
      await coordinatorTestHooks.mutateStoredRun(stored.id, (current) => {
        current.providerRuns.chatgpt!.status = 'complete';
        current.providerRuns.chatgpt!.completedAt = 1;
        current.status = 'complete';
        current.completedAt = 1;
      });
      return { id: 924, url: 'https://chatgpt.com/c/1' } as Browser.tabs.Tab;
    });
    await coordinatorTestHooks.reconcileRuns();
    expect(platform.sendTabEvent).not.toHaveBeenCalledWith(924, expect.objectContaining({ type: 'content:start' }));
  });

  it('returns a terminal error code when an ended provider retries capture delivery', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 918, 'abandoned') }, 'complete');
    await putRun(stored);
    await expect(coordinatorTestHooks.handleRequest({
      type: 'content:capture', runId: stored.id, provider: 'chatgpt',
      domMarkdown: 'A report that arrived after the provider was ended.', domCitations: [],
    }, {} as Browser.runtime.MessageSender)).resolves.toMatchObject({
      ok: false, code: 'provider_terminal',
    });
  });
});
