// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADAPTERS } from '../src/adapters';
import { getCapture, getRun, MAX_CAPTURE_ATTEMPTS, nextCaptureJob, putJob, putRun } from '../src/db';
import type { ProviderId, ProviderRun, Run } from '../src/types';

const platform = vi.hoisted(() => ({
  configurePanelAction: vi.fn(async () => undefined),
  openPanel: vi.fn(async () => undefined),
  readClipboard: vi.fn(async () => ''),
  writeClipboard: vi.fn(async () => undefined),
  downloadText: vi.fn<(...args: unknown[]) => Promise<number>>(),
  notify: vi.fn(async () => undefined),
  setBadge: vi.fn(async () => undefined),
}));

vi.mock('../src/platform', () => ({
  createPlatform: () => platform,
  handleOffscreenResponse: () => false,
  sendTabEvent: vi.fn(async () => undefined),
}));

import { coordinatorTestHooks } from '../src/coordinator';

function provider(id: ProviderId, tabId: number, status: ProviderRun['status']): ProviderRun {
  return { provider: id, tabId, status, submittedQuery: 'query', appendString: '', attempts: 0, degraded: false, adapterVersion: 'test' };
}

function run(providerRuns: Run['providerRuns'], status: Run['status'] = 'active'): Run {
  const id = crypto.randomUUID();
  return { id, query: 'query', createdAt: Date.now(), windowId: 1, providerRuns, status, slug: id, downloadFolder: `deep-research/${id}` };
}

beforeEach(() => {
  let downloadId = 100;
  platform.downloadText.mockReset().mockImplementation(async () => downloadId++);
  platform.readClipboard.mockReset().mockResolvedValue('');
  platform.notify.mockClear();
  platform.setBadge.mockClear();
  vi.stubGlobal('browser', {
    runtime: { sendMessage: vi.fn(async () => undefined), getURL: vi.fn((path: string) => path) },
    storage: { sync: { get: vi.fn(async () => ({})) } },
    tabs: { update: vi.fn(async () => undefined), get: vi.fn(), query: vi.fn(async () => []) },
    tabGroups: { update: vi.fn(async () => undefined) },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('coordinator run guards', () => {
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

  it('removes exhausted capture jobs and fails providers left capturing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
      status: 'failed',
      statusDetail: `Capture failed after ${MAX_CAPTURE_ATTEMPTS} attempts.`,
    });
    log.mockRestore();
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
});
