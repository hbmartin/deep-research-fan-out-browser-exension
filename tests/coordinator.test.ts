// @vitest-environment node
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADAPTERS } from '../src/adapters';
import { acceptCaptureJob, deleteJob, getCapture, getJob, getRun, MAX_CAPTURE_ATTEMPTS, nextCaptureJob, ORPHAN_JOB_RETENTION_MS, putCapture, putJob, putRun } from '../src/db';
import type { Capture, CaptureJob, ProviderId, ProviderRun, Run } from '../src/types';

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
const reportStorage = vi.hoisted(() => ({
  config: undefined as { handle: FileSystemDirectoryHandle; displayName: string; configuredAt: number; needsReconnect: boolean } | undefined,
  permission: 'granted' as PermissionState,
  writeUniqueMarkdown: vi.fn(async (_handle: FileSystemDirectoryHandle, folder: string, filename: string, _artifact: string) => ({
    requestedRelativePath: `${folder}/${filename}`,
    actualRelativePath: `${folder}/${filename}`,
  })),
  markNeedsReconnect: vi.fn(async () => undefined),
  markWriteFailure: vi.fn(async () => undefined),
}));

vi.mock('../src/platform', () => ({
  createPlatform: () => platform,
  handleOffscreenResponse: () => false,
  sendTabEvent: platform.sendTabEvent,
}));

vi.mock('../src/report-storage', () => ({
  classifyDirectoryError: () => 'write_failed',
  getReportDirectoryConfig: async () => reportStorage.config,
  markReportDirectoryNeedsReconnect: reportStorage.markNeedsReconnect,
  markReportDirectoryWriteFailure: reportStorage.markWriteFailure,
  queryDirectoryPermission: async () => reportStorage.permission,
  writeUniqueMarkdown: reportStorage.writeUniqueMarkdown,
}));

import { coordinatorTestHooks } from '../src/coordinator';

function provider(id: ProviderId, tabId: number, status: ProviderRun['status']): ProviderRun {
  return { provider: id, tabId, status, submittedQuery: 'query', appendString: '', attempts: 0, degraded: false, adapterVersion: 'test' };
}

function run(providerRuns: Run['providerRuns'], status: Run['status'] = 'active'): Run {
  const id = crypto.randomUUID();
  const reportFolder = `query-${id.replaceAll('-', '').slice(0, 8)}`;
  return { id, browserSessionId: 'current-session', query: 'query', createdAt: Date.now(), windowId: 1, providerRuns, status, slug: 'query', reportFolder, downloadFolder: `deep-research/${reportFolder}` };
}

function contentSender(tabId = 1, url = 'https://chatgpt.com/'): Browser.runtime.MessageSender {
  return { tab: { id: tabId, url } as Browser.tabs.Tab, url };
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
  reportStorage.config = undefined;
  reportStorage.permission = 'granted';
  reportStorage.writeUniqueMarkdown.mockReset().mockImplementation(async (_handle, folder, filename, _artifact) => ({
    requestedRelativePath: `${folder}/${filename}`,
    actualRelativePath: `${folder}/${filename}`,
  }));
  reportStorage.markNeedsReconnect.mockReset().mockResolvedValue(undefined);
  reportStorage.markWriteFailure.mockReset().mockResolvedValue(undefined);
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
    contextMenus: {
      remove: vi.fn(async () => undefined),
      create: vi.fn(),
    },
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

  it.each(['finalizing', 'complete'] as const)('reconciles a terminal run left %s without completedAt after worker restart', async (status) => {
    const stored = run({ chatgpt: provider('chatgpt', 60, 'complete'), claude: provider('claude', 61, 'failed') }, status);
    await putRun(stored);

    await coordinatorTestHooks.reconcileRuns();
    expect(await getRun(stored.id)).toMatchObject({ status: 'complete', completedAt: expect.any(Number) });
    const ownWrites = () => platform.downloadText.mock.calls.filter(([path]) => String(path).startsWith(`${stored.downloadFolder}/`));
    expect(ownWrites()).toHaveLength(2);
    await coordinatorTestHooks.reconcileRuns();
    expect(ownWrites()).toHaveLength(2);
  });

  it('finalizes simultaneous provider completions only once', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 65, 'researching'), claude: provider('claude', 66, 'researching') });
    await putRun(stored);
    await Promise.all([
      coordinatorTestHooks.handleRequest({ type: 'content:state', runId: stored.id, provider: 'chatgpt', status: 'failed' }, contentSender(65)),
      coordinatorTestHooks.handleRequest({ type: 'content:state', runId: stored.id, provider: 'claude', status: 'failed' },
        { tab: { id: 66, url: 'https://claude.ai/new' } as Browser.tabs.Tab, url: 'https://claude.ai/new' }),
    ]);
    await coordinatorTestHooks.reconcileRuns();
    expect((await getRun(stored.id))?.completedAt).toBeTypeOf('number');
    expect(platform.downloadText).toHaveBeenCalledTimes(2);
  });

  it('saves a terminal provider immediately with a FAILED filename when no capture exists', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 61, 'researching') });
    await putRun(stored);

    const response = await coordinatorTestHooks.handleRequest({
      type: 'content:state', runId: stored.id, provider: 'chatgpt', status: 'failed', detail: 'Provider failed.',
    }, contentSender(61));

    expect(response.ok).toBe(true);
    expect(platform.downloadText).toHaveBeenCalledTimes(1);
    expect(platform.downloadText.mock.calls[0]?.[0]).toBe(`${stored.downloadFolder}/FAILED-chatgpt.md`);
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.saveReceipt).toMatchObject({ destination: 'downloads' });
  });

  it('writes to a persistently granted directory without invoking Downloads', async () => {
    reportStorage.config = { handle: {} as FileSystemDirectoryHandle, displayName: 'Reports', configuredAt: 1, needsReconnect: false };
    const stored = run({ claude: provider('claude', 62, 'failed') });
    await putRun(stored);

    await coordinatorTestHooks.saveProviderArtifact(stored.id, 'claude');

    expect(reportStorage.writeUniqueMarkdown).toHaveBeenCalledWith(
      reportStorage.config.handle, stored.reportFolder, 'FAILED-claude.md', expect.stringContaining('# Claude report unavailable'),
    );
    expect(platform.downloadText).not.toHaveBeenCalled();
    expect((await getRun(stored.id))?.providerRuns.claude?.saveReceipt).toMatchObject({
      destination: 'directory', actualRelativePath: `${stored.reportFolder}/FAILED-claude.md`,
    });
  });

  it('does not fall back or request reconnect when receipt persistence fails after a directory write', async () => {
    reportStorage.config = { handle: {} as FileSystemDirectoryHandle, displayName: 'Reports', configuredAt: 1, needsReconnect: false };
    const stored = run({ chatgpt: provider('chatgpt', 621, 'failed') });
    await putRun(stored);
    reportStorage.writeUniqueMarkdown.mockImplementationOnce(async (_handle, folder, filename) => {
      const raw = await openDB('deep-research-fan-out', 2);
      await raw.delete('runs', stored.id);
      raw.close();
      return {
        requestedRelativePath: `${folder}/${filename}`,
        actualRelativePath: `${folder}/${filename}`,
      };
    });

    await expect(coordinatorTestHooks.saveProviderArtifact(stored.id, 'chatgpt')).rejects.toThrow('Run not found');

    expect(reportStorage.writeUniqueMarkdown).toHaveBeenCalledTimes(1);
    expect(platform.downloadText).not.toHaveBeenCalled();
    expect(reportStorage.markNeedsReconnect).not.toHaveBeenCalled();
    expect(reportStorage.markWriteFailure).not.toHaveBeenCalled();
  });

  it('falls back immediately when directory permission is no longer granted', async () => {
    reportStorage.config = { handle: {} as FileSystemDirectoryHandle, displayName: 'Reports', configuredAt: 1, needsReconnect: false };
    reportStorage.permission = 'prompt';
    const stored = run({ gemini: provider('gemini', 63, 'failed') });
    await putRun(stored);

    await coordinatorTestHooks.saveProviderArtifact(stored.id, 'gemini');

    expect(reportStorage.writeUniqueMarkdown).not.toHaveBeenCalled();
    expect(platform.downloadText).toHaveBeenCalledWith(`${stored.downloadFolder}/FAILED-gemini.md`, expect.any(String));
    expect(reportStorage.markNeedsReconnect).toHaveBeenCalledWith(reportStorage.config, true);
    expect(reportStorage.markWriteFailure).not.toHaveBeenCalled();
    expect((await getRun(stored.id))?.providerRuns.gemini?.saveReceipt).toMatchObject({
      destination: 'downloads', fallbackReason: 'permission_required',
    });
  });

  it('leaves a provider retryable when both the directory and Downloads fail', async () => {
    reportStorage.config = { handle: {} as FileSystemDirectoryHandle, displayName: 'Reports', configuredAt: 1, needsReconnect: false };
    reportStorage.writeUniqueMarkdown.mockRejectedValueOnce(new Error('disk full'));
    platform.downloadText.mockRejectedValueOnce(new Error('downloads unavailable'));
    const stored = run({ grok: provider('grok', 64, 'failed') });
    await putRun(stored);

    await expect(coordinatorTestHooks.saveProviderArtifact(stored.id, 'grok')).rejects.toThrow('downloads unavailable');
    expect((await getRun(stored.id))?.providerRuns.grok?.saveReceipt).toBeUndefined();
    expect(reportStorage.markNeedsReconnect).not.toHaveBeenCalledWith(reportStorage.config, true);
    expect(reportStorage.markWriteFailure).toHaveBeenCalledWith(reportStorage.config);
  });

  it('reports unsaved retryable providers in the run-complete notification', async () => {
    reportStorage.config = { handle: {} as FileSystemDirectoryHandle, displayName: 'Reports', configuredAt: 1, needsReconnect: false };
    reportStorage.writeUniqueMarkdown.mockRejectedValue(new Error('disk full'));
    platform.downloadText.mockRejectedValue(new Error('downloads unavailable'));
    const stored = run({ grok: provider('grok', 641, 'failed') });
    await putRun(stored);

    await coordinatorTestHooks.maybeFinalize(stored);

    expect(await getRun(stored.id)).toMatchObject({ status: 'complete', providerRuns: { grok: { status: 'failed' } } });
    expect((await getRun(stored.id))?.providerRuns.grok?.saveReceipt).toBeUndefined();
    expect(platform.notify).toHaveBeenCalledWith(
      `run:${stored.id}`, 'Research run complete', expect.stringMatching(/0 of 1 files saved.*Retry failed saves/),
    );
  });

  it('uses a reconnected directory only for an explicit Save again after fallback', async () => {
    const chatgpt = provider('chatgpt', 642, 'failed');
    const stored = run({ chatgpt });
    chatgpt.saveReceipt = {
      destination: 'downloads', requestedRelativePath: `${stored.downloadFolder}/FAILED-chatgpt.md`, savedAt: 1,
      fallbackReason: 'permission_required', downloadId: 8,
    };
    reportStorage.config = { handle: {} as FileSystemDirectoryHandle, displayName: 'Reports', configuredAt: 1, needsReconnect: false };
    await putRun(stored);

    await expect(coordinatorTestHooks.saveProviderArtifact(stored.id, 'chatgpt')).resolves.toMatchObject({ saved: false });
    expect(reportStorage.writeUniqueMarkdown).not.toHaveBeenCalled();
    await expect(coordinatorTestHooks.saveProviderArtifact(stored.id, 'chatgpt', true)).resolves.toMatchObject({ saved: true });
    expect(reportStorage.writeUniqueMarkdown).toHaveBeenCalledTimes(1);
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.saveReceipt?.destination).toBe('directory');
  });

  it('keeps the failure artifact and saves a normal filename for a late capture', async () => {
    const chatgpt = provider('chatgpt', 65, 'failed');
    const stored = run({ chatgpt });
    await putRun(stored);
    await coordinatorTestHooks.saveProviderArtifact(stored.id, 'chatgpt');
    const id = `${stored.id}:chatgpt`;
    await putCapture(id, {
      rawMarkdown: 'Late report', normalizedMarkdown: 'Late report', citations: [], captureMethod: 'copy_only',
      unplacedCitationCount: 0, capturedAt: 1, urlsResolved: 0, urlsUnresolved: 0,
    });

    await coordinatorTestHooks.completeProviderCapture(stored.id, 'chatgpt', id, false);

    expect(platform.downloadText.mock.calls.map((call) => call[0])).toEqual([
      `${stored.downloadFolder}/FAILED-chatgpt.md`,
      `${stored.downloadFolder}/chatgpt.md`,
    ]);
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.saveReceipt?.requestedRelativePath).toBe(`${stored.downloadFolder}/chatgpt.md`);
  });

  it('assigns a new revision when capture content changes under the same key', async () => {
    const id = `revision:${crypto.randomUUID()}`;
    const capture: Capture = {
      rawMarkdown: 'First report', normalizedMarkdown: 'First report', citations: [], captureMethod: 'copy_only',
      unplacedCitationCount: 0, capturedAt: 1, urlsResolved: 0, urlsUnresolved: 0,
    };
    await putCapture(id, capture);
    const firstRevision = (await getCapture(id))!.revision;
    await putCapture(id, { ...capture, normalizedMarkdown: 'Revised report' });
    const secondRevision = (await getCapture(id))!.revision;

    expect(secondRevision).toBeTypeOf('string');
    expect(secondRevision).not.toBe(firstRevision);
  });

  it('preserves a stale in-flight file and commits a second file for the latest capture revision', async () => {
    reportStorage.config = { handle: {} as FileSystemDirectoryHandle, displayName: 'Reports', configuredAt: 1, needsReconnect: false };
    const chatgpt = provider('chatgpt', 651, 'complete');
    const stored = run({ chatgpt });
    const id = `${stored.id}:chatgpt`;
    const firstCapture: Capture = {
      rawMarkdown: 'First report', normalizedMarkdown: 'First report', citations: [], captureMethod: 'copy_only' as const,
      unplacedCitationCount: 0, capturedAt: 1, urlsResolved: 0, urlsUnresolved: 0,
    };
    await putCapture(id, firstCapture);
    chatgpt.captureId = id;
    chatgpt.artifactRevision = firstCapture.revision;
    await putRun(stored);

    let releaseFirst!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let writeCount = 0;
    reportStorage.writeUniqueMarkdown.mockImplementation(async (_handle, folder, filename) => {
      writeCount += 1;
      if (writeCount === 1) await firstWriteBlocked;
      const suffix = writeCount === 1 ? filename : filename.replace('.md', ' (1).md');
      return { requestedRelativePath: `${folder}/${filename}`, actualRelativePath: `${folder}/${suffix}` };
    });

    const firstSave = coordinatorTestHooks.saveProviderArtifact(stored.id, 'chatgpt');
    await vi.waitFor(() => expect(reportStorage.writeUniqueMarkdown).toHaveBeenCalledTimes(1));
    const revisedCapture: Capture = {
      rawMarkdown: 'Revised report', normalizedMarkdown: 'Revised report', citations: [], captureMethod: 'copy_only' as const,
      unplacedCitationCount: 0, capturedAt: 2, urlsResolved: 0, urlsUnresolved: 0,
    };
    await putCapture(id, revisedCapture);
    const attachment = coordinatorTestHooks.completeProviderCapture(
      stored.id, 'chatgpt', id, false, revisedCapture.revision,
    );
    await vi.waitFor(async () => expect((await getRun(stored.id))?.providerRuns.chatgpt?.artifactRevision)
      .toBe(revisedCapture.revision));
    releaseFirst();
    await Promise.all([firstSave, attachment]);

    expect(reportStorage.writeUniqueMarkdown).toHaveBeenCalledTimes(2);
    expect(reportStorage.writeUniqueMarkdown.mock.calls[0]?.[3]).toContain('First report');
    expect(reportStorage.writeUniqueMarkdown.mock.calls[1]?.[3]).toContain('Revised report');
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.saveReceipt).toMatchObject({
      artifactRevision: revisedCapture.revision,
      actualRelativePath: `${stored.reportFolder}/chatgpt (1).md`,
    });
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
    expect((await getRun(stored.id))?.providerRuns.gemini).toMatchObject({ status: 'manual_required' });
    expect((await getRun(stored.id))?.providerRuns.gemini?.reconcileFailureCount).toBeUndefined();
    expect(platform.sendTabEvent).not.toHaveBeenCalled();
  });

  it('restores pre-submission setup after a Gemini authentication redirect', async () => {
    const stored = run({ gemini: provider('gemini', 81, 'opening') });
    await putRun(stored);
    tabsGet.mockResolvedValue({ id: 81, url: 'https://accounts.google.com/v3/signin' } as Browser.tabs.Tab);
    await coordinatorTestHooks.reconcileRuns();
    expect((await getRun(stored.id))?.providerRuns.gemini).toMatchObject({
      status: 'manual_required', detachedSetupStatus: 'opening', detachedAt: expect.any(Number),
    });

    tabsGet.mockResolvedValue({ id: 81, url: 'https://gemini.google.com/app' } as Browser.tabs.Tab);
    await coordinatorTestHooks.reconcileRuns();
    expect((await getRun(stored.id))?.providerRuns.gemini).toMatchObject({
      status: 'opening', detachedSetupStatus: undefined, detachedAt: undefined,
    });
    expect(platform.sendTabEvent).toHaveBeenCalledWith(81, expect.objectContaining({
      type: 'content:start', status: 'opening', resumeOnly: false,
    }));
  });

  it('restores setup when returning content says hello and rejects unmarked setup resumption', async () => {
    const gemini = provider('gemini', 82, 'manual_required');
    gemini.detachedAt = Date.now();
    gemini.detachedSetupStatus = 'setting_mode';
    const stored = run({ gemini });
    await putRun(stored);
    await coordinatorTestHooks.handleRequest({ type: 'content:hello', provider: 'gemini', url: 'https://gemini.google.com/app' }, {
      tab: { id: 82, url: 'https://gemini.google.com/app' } as Browser.tabs.Tab,
      url: 'https://gemini.google.com/app',
    });
    expect((await getRun(stored.id))?.providerRuns.gemini?.status).toBe('setting_mode');
    await vi.waitFor(() => expect(platform.sendTabEvent).toHaveBeenCalledWith(82, expect.objectContaining({
      type: 'content:start', status: 'setting_mode', resumeOnly: false,
    })));

    gemini.status = 'manual_required';
    gemini.detachedSetupStatus = undefined;
    await putRun({ ...stored, providerRuns: { gemini } });
    const result = await coordinatorTestHooks.handleRequest({
      type: 'content:state', runId: stored.id, provider: 'gemini', status: 'awaiting_ready',
    }, { tab: { id: 82, url: 'https://gemini.google.com/app' } as Browser.tabs.Tab, url: 'https://gemini.google.com/app' });
    expect(result).toMatchObject({ ok: false, code: 'invalid_transition' });
  });

  it('interrupts a bound run after three reconciliation checks in another conversation', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 9, 'researching') });
    stored.providerRuns.chatgpt!.conversationKey = 'https://chatgpt.com/c/bound';
    await putRun(stored);
    tabsGet.mockResolvedValue({ id: 9, url: 'https://chatgpt.com/c/other' } as Browser.tabs.Tab);

    await coordinatorTestHooks.reconcileRuns();
    await coordinatorTestHooks.reconcileRuns();
    await coordinatorTestHooks.reconcileRuns();

    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({ status: 'interrupted' });
    expect(platform.downloadText).toHaveBeenCalledWith(
      `${stored.downloadFolder}/FAILED-chatgpt.md`, expect.any(String),
    );
    expect(platform.sendTabEvent).not.toHaveBeenCalledWith(9, expect.anything());
  });

  it('keeps an auxiliary page recoverable without reconciliation failures', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 9, 'researching') });
    stored.providerRuns.chatgpt!.conversationKey = 'https://chatgpt.com/c/bound';
    await putRun(stored);
    tabsGet.mockResolvedValue({ id: 9, url: 'https://chatgpt.com/library' } as Browser.tabs.Tab);

    await coordinatorTestHooks.reconcileRuns();
    await coordinatorTestHooks.reconcileRuns();
    await coordinatorTestHooks.reconcileRuns();

    expect((await getRun(stored.id))?.providerRuns.chatgpt?.status).toBe('manual_required');
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.reconcileFailureCount).toBeUndefined();
    expect(platform.downloadText).not.toHaveBeenCalledWith(
      `${stored.downloadFolder}/FAILED-chatgpt.md`, expect.any(String),
    );
  });

  it('does not broadcast unchanged runs during repeated auxiliary-page reconciliation', async () => {
    const chatgpt = provider('chatgpt', 90, 'manual_required');
    chatgpt.conversationKey = 'https://chatgpt.com/c/bound';
    chatgpt.detachedAt = Date.now();
    const stored = run({ chatgpt });
    await putRun(stored);
    tabsGet.mockResolvedValue({ id: 90, url: 'https://chatgpt.com/library' } as Browser.tabs.Tab);

    await coordinatorTestHooks.reconcileRuns();
    await coordinatorTestHooks.reconcileRuns();
    await coordinatorTestHooks.reconcileRuns();

    expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'runs:changed' }));
    expect(platform.setBadge).toHaveBeenCalled();
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.status).toBe('manual_required');
  });

  it('acknowledges repeated detached-page reports without repeated notifications or broadcasts', async () => {
    const chatgpt = provider('chatgpt', 901, 'researching');
    chatgpt.conversationKey = 'https://chatgpt.com/c/bound';
    const stored = run({ chatgpt });
    await putRun(stored);
    const message = { type: 'content:state', runId: stored.id, provider: 'chatgpt',
      status: 'manual_required', detail: 'Return to the original ChatGPT conversation to continue monitoring.',
      reason: 'provider_navigation', conversationKey: chatgpt.conversationKey } as const;
    const sender = contentSender(901, 'https://chatgpt.com/library');

    for (let index = 0; index < 4; index += 1) {
      expect((await coordinatorTestHooks.handleRequest(message, sender)).ok).toBe(true);
    }

    expect(platform.notify).toHaveBeenCalledTimes(1);
    expect(browser.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.detachedAt).toBeTypeOf('number');
  });

  it('defers a queued capture on an auxiliary provider page and resumes it on the original conversation', async () => {
    const chatgpt = provider('chatgpt', 91, 'capturing');
    chatgpt.conversationKey = 'https://chatgpt.com/c/bound';
    const stored = run({ chatgpt });
    const id = `${stored.id}:chatgpt`;
    const report = 'A complete visible report retained while the user visits the library.';
    await putRun(stored);
    await putJob({
      id, runId: stored.id, provider: 'chatgpt', tabId: 91, state: 'queued',
      createdAt: Date.now(), attempts: 0,
      domMarkdown: report, domCitations: [],
    });
    tabsGet.mockResolvedValue({ id: 91, url: 'https://chatgpt.com/library' } as Browser.tabs.Tab);

    await coordinatorTestHooks.processCaptureQueue();
    expect(await getJob(id)).toMatchObject({ state: 'queued', attempts: 0, deferredForNavigation: true });
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({
      status: 'manual_required', detachedAt: expect.any(Number), conversationKey: 'https://chatgpt.com/c/bound',
    });
    expect(platform.sendTabEvent).not.toHaveBeenCalledWith(91, expect.objectContaining({ type: 'capture:copy' }));

    await coordinatorTestHooks.reconcileRuns();
    await coordinatorTestHooks.reconcileRuns();
    await coordinatorTestHooks.reconcileRuns();
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.status).toBe('manual_required');
    expect((await getJob(id))?.attempts).toBe(0);

    let clipboard = 'private clipboard';
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    platform.sendTabEvent.mockImplementation(async (_tabId, event) => {
      if ((event as { type?: string }).type === 'capture:copy-now') clipboard = report;
      return { ok: true, copyConfirmed: true };
    });
    tabsGet.mockResolvedValue({ id: 91, url: 'https://chatgpt.com/c/bound' } as Browser.tabs.Tab);
    await coordinatorTestHooks.reconcileRuns();

    expect(await getJob(id)).toBeUndefined();
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({
      status: 'complete', detachedAt: undefined,
    });
    expect(await getCapture(id)).toMatchObject({ captureMethod: 'copy_only' });
  });

  it('defers a verified report during authentication and saves DOM-only after two minutes', async () => {
    const gemini = provider('gemini', 93, 'capturing');
    gemini.conversationKey = 'https://gemini.google.com/app/bound';
    const stored = run({ gemini });
    const id = `${stored.id}:gemini`;
    await putRun(stored);
    await putJob({ id, runId: stored.id, provider: 'gemini', tabId: 93, state: 'queued',
      createdAt: Date.now(), attempts: 0, domMarkdown: 'A verified Gemini report retained during sign-in.', domCitations: [] });
    tabsGet.mockResolvedValue({ id: 93, url: 'https://accounts.google.com/v3/signin' } as Browser.tabs.Tab);

    await coordinatorTestHooks.processCaptureQueue();
    const deferred = await getJob(id);
    expect(deferred).toMatchObject({ state: 'queued', deferredForNavigation: true, deferredAt: expect.any(Number), attempts: 0 });
    await putJob({ ...deferred!, deferredAt: Date.now() - 120_001 });
    await coordinatorTestHooks.processCaptureQueue();

    expect(await getJob(id)).toBeUndefined();
    expect(await getCapture(id)).toMatchObject({ captureMethod: 'dom_only' });
    expect((await getRun(stored.id))?.providerRuns.gemini?.status).toBe('complete');
    expect(platform.sendTabEvent).not.toHaveBeenCalledWith(93, expect.objectContaining({ type: 'capture:copy-now' }));
  });

  it('saves a deferred DOM report immediately when its provider terminalizes', async () => {
    const chatgpt = provider('chatgpt', 94, 'quota_exhausted');
    chatgpt.conversationKey = 'https://chatgpt.com/c/bound';
    const stored = run({ chatgpt });
    const id = `${stored.id}:chatgpt`;
    await putRun(stored);
    await putJob({ id, runId: stored.id, provider: 'chatgpt', tabId: 94, state: 'queued',
      createdAt: Date.now(), attempts: 0, deferredForNavigation: true, deferredAt: Date.now(),
      domMarkdown: 'A verified report saved despite a later quota outcome.', domCitations: [] });
    tabsGet.mockResolvedValue({ id: 94, url: 'https://chatgpt.com/library' } as Browser.tabs.Tab);

    await coordinatorTestHooks.processCaptureQueue();

    expect(await getJob(id)).toBeUndefined();
    expect(await getCapture(id)).toMatchObject({ captureMethod: 'dom_only' });
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({ status: 'quota_exhausted', captureId: id });
  });

  it('links an already-persisted report before handling navigation to another conversation', async () => {
    const chatgpt = provider('chatgpt', 95, 'capturing');
    chatgpt.conversationKey = 'https://chatgpt.com/c/bound';
    const stored = run({ chatgpt });
    const id = `${stored.id}:chatgpt`;
    await putRun(stored);
    await putCapture(id, { rawMarkdown: 'Durably accepted report', normalizedMarkdown: 'Durably accepted report',
      citations: [], captureMethod: 'copy_only', unplacedCitationCount: 0, capturedAt: Date.now(), urlsResolved: 0, urlsUnresolved: 0 });
    await putJob({ id, runId: stored.id, provider: 'chatgpt', tabId: 95, state: 'queued',
      createdAt: Date.now(), attempts: 0, domMarkdown: 'Verified DOM report', domCitations: [] });
    tabsGet.mockResolvedValue({ id: 95, url: 'https://chatgpt.com/c/other' } as Browser.tabs.Tab);

    await coordinatorTestHooks.processCaptureQueue();

    expect(await getJob(id)).toBeUndefined();
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({ status: 'complete', captureId: id });
    expect(platform.downloadText).toHaveBeenCalledWith(`${stored.downloadFolder}/chatgpt.md`, expect.any(String));
  });

  it.each([
    'https://chatgpt.com/c/other',
    'https://example.com/away',
  ])('preserves a verified queued capture without unsafe copying after navigation to %s', async (url) => {
    const chatgpt = provider('chatgpt', 92, 'capturing');
    chatgpt.conversationKey = 'https://chatgpt.com/c/bound';
    const stored = run({ chatgpt });
    const id = `${stored.id}:chatgpt`;
    await putRun(stored);
    await putJob({
      id, runId: stored.id, provider: 'chatgpt', tabId: 92, state: 'queued', createdAt: Date.now(), attempts: 0,
      domMarkdown: 'A report from the original conversation must not be copied from a different conversation.', domCitations: [],
    });
    tabsGet.mockResolvedValue({ id: 92, url } as Browser.tabs.Tab);

    await coordinatorTestHooks.processCaptureQueue();

    expect(await getJob(id)).toBeUndefined();
    expect(await getCapture(id)).toMatchObject({ captureMethod: 'dom_only' });
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({
      status: 'interrupted', captureId: id,
      saveReceipt: { requestedRelativePath: `${stored.downloadFolder}/chatgpt.md` },
    });
    expect(platform.sendTabEvent).not.toHaveBeenCalledWith(92, expect.objectContaining({ type: 'capture:copy-now' }));
  });

  it('settles and broadcasts an interrupted provider when navigation leaves no usable DOM report', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 9201, 'capturing') });
    const id = `${stored.id}:chatgpt`;
    await putRun(stored);
    await putJob({ id, runId: stored.id, provider: 'chatgpt', tabId: 9201, state: 'queued',
      createdAt: Date.now(), attempts: MAX_CAPTURE_ATTEMPTS - 1,
      domMarkdown: 'short', domCitations: [] });
    tabsGet.mockResolvedValue({ id: 9201, url: 'https://example.com/other' } as Browser.tabs.Tab);
    await coordinatorTestHooks.processCaptureQueue();
    expect(await getJob(id)).toBeUndefined();
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.status).toBe('interrupted');
    expect(platform.downloadText).toHaveBeenCalledWith(`${stored.downloadFolder}/FAILED-chatgpt.md`, expect.any(String));
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'runs:changed' }));
  });

  it('interrupts an invalid legacy binding instead of rebinding it during reconciliation', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 10, 'researching') });
    stored.providerRuns.chatgpt!.conversationKey = 'legacy-conversation-key';
    await putRun(stored);
    tabsGet.mockResolvedValue({ id: 10, url: 'https://chatgpt.com/c/current' } as Browser.tabs.Tab);

    await coordinatorTestHooks.reconcileRuns();
    await coordinatorTestHooks.reconcileRuns();
    await coordinatorTestHooks.reconcileRuns();

    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({
      status: 'interrupted', conversationKey: 'legacy-conversation-key',
    });
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

  it('ignores redirect-cache read and write failures without losing the canonical URL', async () => {
    const previous = ADAPTERS.chatgpt.urlResolution;
    ADAPTERS.chatgpt.urlResolution = 'follow_redirect';
    vi.stubGlobal('fetch', vi.fn(async () => ({ url: 'https://canonical.test/recovered' })));
    const citation = { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/cache-error',
      contextBefore: '', contextAfter: '', domOrder: 0 };
    const originalGet = IDBObjectStore.prototype.get;
    const originalPut = IDBObjectStore.prototype.put;
    const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      if (this.name === 'redirects') throw new Error('temporary cache read failure');
      return originalGet.call(this, key);
    });
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'redirects') throw new Error('temporary cache write failure');
      return originalPut.call(this, value, key);
    });
    try {
      const result = await coordinatorTestHooks.resolveCitationUrls('chatgpt', [citation]);
      expect(result).toMatchObject({ resolved: 1, unresolved: 0,
        citations: [{ url: 'https://canonical.test/recovered' }] });
    } finally {
      getSpy.mockRestore();
      putSpy.mockRestore();
      ADAPTERS.chatgpt.urlResolution = previous;
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

  it('pauses repeated capture writes, ends the run, and upgrades only an explicit DOM retry', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 9091, 'capturing') });
    const id = `${stored.id}:chatgpt`;
    await putRun(stored);
    await putJob({ id, runId: stored.id, provider: 'chatgpt', tabId: 9091, state: 'queued',
      createdAt: Date.now(), attempts: MAX_CAPTURE_ATTEMPTS - 1, tabUnavailable: true,
      domMarkdown: 'A verified DOM report retained through a capture-storage failure.', domCitations: [] });
    const originalPut = IDBObjectStore.prototype.put;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'captures') throw new DOMException('storage full', 'QuotaExceededError');
      return originalPut.call(this, value, key);
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try { await coordinatorTestHooks.processCaptureQueue(); }
    finally { putSpy.mockRestore(); consoleError.mockRestore(); }
    expect(await getJob(id)).toMatchObject({ state: 'paused', tabUnavailable: true });
    expect(await nextCaptureJob()).toBeUndefined();
    expect(await getRun(stored.id)).toMatchObject({ status: 'complete', completedAt: expect.any(Number),
      providerRuns: { chatgpt: { status: 'failed', captureRecoveryPending: true } } });
    expect(platform.downloadText).toHaveBeenCalledWith(`${stored.downloadFolder}/FAILED-chatgpt.md`, expect.any(String));
    expect(platform.notify).toHaveBeenCalledWith(`attention:${stored.id}:chatgpt`, expect.stringContaining('retry'), expect.any(String));

    platform.sendTabEvent.mockClear();
    const response = await coordinatorTestHooks.handleRequest({ type: 'provider:retry-capture', runId: stored.id, provider: 'chatgpt' }, {});
    expect(response.ok).toBe(true);
    expect(platform.sendTabEvent).not.toHaveBeenCalled();
    expect(await getJob(id)).toBeUndefined();
    expect(await getCapture(id)).toMatchObject({ captureMethod: 'dom_only' });
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({
      status: 'complete', captureRecoveryPending: undefined, degraded: true,
      saveReceipt: { requestedRelativePath: `${stored.downloadFolder}/chatgpt.md` },
    });
  });

  it('reconciles a paused storage failure when its first state write failed', async () => {
    const stored = run({ claude: provider('claude', 9092, 'capturing') });
    const id = `${stored.id}:claude`;
    await putRun(stored);
    await putJob({ id, runId: stored.id, provider: 'claude', tabId: 9092, state: 'queued',
      createdAt: Date.now(), attempts: MAX_CAPTURE_ATTEMPTS - 1, tabUnavailable: true,
      domMarkdown: 'A verified Claude DOM report retained while state writes fail.', domCitations: [] });
    const originalPut = IDBObjectStore.prototype.put;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'captures' || (this.name === 'runs' && (value as Run).providerRuns.claude?.status === 'failed')) {
        throw new DOMException('storage full', 'QuotaExceededError');
      }
      return originalPut.call(this, value, key);
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try { await coordinatorTestHooks.processCaptureQueue(); }
    finally { putSpy.mockRestore(); consoleError.mockRestore(); }
    expect(await getJob(id)).toMatchObject({ state: 'paused' });
    expect((await getRun(stored.id))?.providerRuns.claude?.status).toBe('capturing');
    await coordinatorTestHooks.reconcileRuns();
    expect((await getRun(stored.id))?.providerRuns.claude).toMatchObject({ status: 'failed', captureRecoveryPending: true });
  });

  it('persists a short DOM-backed reply when an owned Copy control established completion', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 909, 'capturing') });
    await putRun(stored);
    await putJob({
      id: `${stored.id}:chatgpt`, runId: stored.id, provider: 'chatgpt', tabId: 909,
      state: 'queued', createdAt: Date.now(), attempts: MAX_CAPTURE_ATTEMPTS,
      tabUnavailable: true, domMarkdown: 'OK', domCitations: [], copyControlObserved: true,
    });
    await coordinatorTestHooks.processCaptureQueue();
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.status).toBe('complete');
    expect(await getCapture(`${stored.id}:chatgpt`)).toMatchObject({ rawMarkdown: 'OK', captureMethod: 'dom_only' });
  });

  it('treats a durable report as complete despite a late timeout or navigation attention state', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 9101, 'manual_required') }, 'needs_attention');
    const id = `${stored.id}:chatgpt`;
    stored.providerRuns.chatgpt!.researchTimedOutAt = Date.now();
    stored.providerRuns.chatgpt!.detachedAt = Date.now();
    await putRun(stored);
    await putCapture(id, { rawMarkdown: 'Saved report', normalizedMarkdown: 'Saved report', citations: [],
      captureMethod: 'dom_only', unplacedCitationCount: 0, capturedAt: Date.now(), urlsResolved: 0, urlsUnresolved: 0 });

    await coordinatorTestHooks.completeProviderCapture(stored.id, 'chatgpt', id, true);

    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({ status: 'complete', captureId: id, degraded: true });
    expect(platform.downloadText).toHaveBeenCalledWith(`${stored.downloadFolder}/chatgpt.md`, expect.any(String));
  });

  it('retains an orphaned verified capture job instead of deleting its report', async () => {
    const id = `missing-${crypto.randomUUID()}:chatgpt`;
    await putJob({ id, runId: id.split(':')[0]!, provider: 'chatgpt', tabId: 9102,
      state: 'queued', createdAt: Date.now(), attempts: 0,
      domMarkdown: 'A verified report waiting for its run record to be recovered.', domCitations: [] });

    await coordinatorTestHooks.processCaptureQueue();

    expect(await getJob(id)).toMatchObject({ state: 'orphaned', orphanedAt: expect.any(Number),
      domMarkdown: expect.stringContaining('verified report') });
    expect(await nextCaptureJob()).toBeUndefined();
    await deleteJob(id);
  });

  it('resumes an orphan when its run reappears and expires one after seven days', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 9103, 'capturing') });
    const id = `${stored.id}:chatgpt`;
    await putJob({ id, runId: stored.id, provider: 'chatgpt', tabId: 9103, state: 'orphaned',
      createdAt: Date.now() - ORPHAN_JOB_RETENTION_MS, orphanedAt: Date.now() - ORPHAN_JOB_RETENTION_MS + 1000,
      attempts: 0, tabUnavailable: true, domMarkdown: 'A restored orphan DOM report with enough text to be usable.', domCitations: [] });
    expect(await nextCaptureJob()).toBeUndefined();
    await putRun(stored);
    await coordinatorTestHooks.processCaptureQueue();
    expect(await getJob(id)).toBeUndefined();
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.status).toBe('complete');

    const expiredId = `expired-${crypto.randomUUID()}:chatgpt`;
    await putJob({ id: expiredId, runId: expiredId.split(':')[0]!, provider: 'chatgpt', tabId: 9104,
      state: 'orphaned', createdAt: Date.now() - ORPHAN_JOB_RETENTION_MS,
      orphanedAt: Date.now() - ORPHAN_JOB_RETENTION_MS - 1, attempts: 0,
      domMarkdown: 'An expired verified orphan report with enough report text.', domCitations: [] });
    await coordinatorTestHooks.processCaptureQueue();
    expect(await getJob(expiredId)).toBeUndefined();
  });

  it('does not classify a reused tab ID once browser recovery marked its job unavailable', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 9105, 'capturing') });
    const id = `${stored.id}:chatgpt`;
    await putRun(stored);
    await putJob({ id, runId: stored.id, provider: 'chatgpt', tabId: 9105, state: 'queued',
      createdAt: Date.now(), attempts: 0, tabUnavailable: true,
      domMarkdown: 'A verified report recovered from DOM after browser restart.', domCitations: [] });
    tabsGet.mockResolvedValue({ id: 9105, url: 'https://example.com/unrelated' } as Browser.tabs.Tab);
    await coordinatorTestHooks.processCaptureQueue();
    expect(tabsGet).not.toHaveBeenCalled();
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.status).toBe('complete');
    expect(await getCapture(id)).toMatchObject({ captureMethod: 'dom_only' });
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

  it('accepts confirmed short copy-only clipboard data and restores the original clipboard', async () => {
    vi.useFakeTimers();
    const original = 'Original clipboard material that should not be mistaken for a report.';
    let clipboard = original;
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    platform.sendTabEvent.mockImplementation(async () => {
      clipboard = 'Too short';
      return { ok: true, copyConfirmed: true };
    });
    const job: CaptureJob = {
      id: 'run:claude-short', runId: 'run', provider: 'claude', tabId: 2, state: 'queued',
      createdAt: 1, attempts: 0, domMarkdown: '', domCitations: [],
    };
    const pending = coordinatorTestHooks.clipboardCapture(platform, job);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ text: 'Too short', restored: true });
    expect(clipboard).toBe(original);
  });

  it('rejects unconfirmed short clipboard data without overwriting the changed clipboard', async () => {
    vi.useFakeTimers();
    const original = 'Original clipboard material that should be restored after a rejected copy.';
    let clipboard = original;
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    platform.sendTabEvent.mockImplementation(async () => {
      clipboard = 'Too short';
      return { ok: true, copyConfirmed: false };
    });
    const job: CaptureJob = {
      id: 'run:claude-short-rejected', runId: 'run', provider: 'claude', tabId: 2, state: 'queued',
      createdAt: 1, attempts: 0, domMarkdown: '', domCitations: [],
    };
    const pending = coordinatorTestHooks.clipboardCapture(platform, job);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(clipboard).toBe('Too short');
  });

  it('restores a confirmed provider value when validation rejects it', async () => {
    vi.useFakeTimers();
    const original = 'Original clipboard material that should be restored after a rejected copy.';
    let clipboard = original;
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    platform.sendTabEvent.mockImplementation(async () => {
      clipboard = 'A different provider response that does not match the visible report.';
      return { ok: true, copyConfirmed: true };
    });
    const job: CaptureJob = {
      id: 'run:claude-mismatch', runId: 'run', provider: 'claude', tabId: 2, state: 'queued',
      createdAt: 1, attempts: 0,
      domMarkdown: 'The visible provider report has unrelated content and must be used for validation.',
      domCitations: [],
    };
    const pending = coordinatorTestHooks.clipboardCapture(platform, job);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(clipboard).toBe(original);
  });

  it('retains a confirmed provider value after failed validation when clipboard restoration is disabled', async () => {
    vi.useFakeTimers();
    (browser.storage.sync.get as unknown as { mockResolvedValue(value: Record<string, unknown>): void }).mockResolvedValue({
      'settings.general.v1': { restoreClipboard: false },
    });
    const original = 'Original clipboard material that should be replaced by the confirmed provider copy.';
    const providerValue = 'A different confirmed provider response that does not match the visible report.';
    let clipboard = original;
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    platform.sendTabEvent.mockImplementation(async () => {
      clipboard = providerValue;
      return { ok: true, copyConfirmed: true };
    });
    const pending = coordinatorTestHooks.clipboardCapture(platform, {
      id: 'run:claude-no-restore', runId: 'run', provider: 'claude', tabId: 2, state: 'queued',
      createdAt: 1, attempts: 0, tabUnavailable: true,
      domMarkdown: 'The visible provider report has unrelated content and must be used for validation.', domCitations: [],
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(clipboard).toBe(providerValue);
  });

  it('never leaves an internal clipboard sentinel when restoration is disabled', async () => {
    vi.useFakeTimers();
    (browser.storage.sync.get as unknown as { mockResolvedValue(value: Record<string, unknown>): void }).mockResolvedValue({
      'settings.general.v1': { restoreClipboard: false },
    });
    const original = 'Original clipboard material that must survive a provider copy that never arrives.';
    let clipboard = original;
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    const pending = coordinatorTestHooks.clipboardCapture(platform, {
      id: 'run:sentinel', runId: 'run', provider: 'chatgpt', tabId: 1, state: 'queued',
      createdAt: 1, attempts: 0, tabUnavailable: true,
      domMarkdown: 'A sufficiently long visible provider response for validation.', domCitations: [],
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(clipboard).toBe(original);
    expect(clipboard).not.toMatch(/^__DRFO_COPY_/);
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

  it('copies a normalized current response without changing provider state', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 44, 'researching') });
    stored.providerRuns.chatgpt!.submittedAt = 1234;
    stored.providerRuns.chatgpt!.conversationKey = 'https://chatgpt.com/c/current';
    await putRun(stored);
    tabsGet.mockResolvedValue({ id: 44, url: 'https://chatgpt.com/c/current' } as Browser.tabs.Tab);
    platform.sendTabEvent.mockImplementation(async (_tabId, event) => {
      if ((event as { type: string }).type === 'content:ping') return { ok: true };
      return {
        provider: 'chatgpt', pageUrl: 'https://chatgpt.com/c/current',
        activeRunId: stored.id, conversationKey: 'https://chatgpt.com/c/current',
        domMarkdown: 'Current report with [Evidence](https://example.com/source).',
        domCitations: [{
          url: 'https://example.com/source', markerText: 'Evidence', domOrder: 0,
          contextBefore: 'Current report with ', contextAfter: '.',
        }],
      };
    });

    await expect(coordinatorTestHooks.handleRequest(
      { type: 'provider:copy-current', runId: stored.id, provider: 'chatgpt' },
      {} as Browser.runtime.MessageSender,
    )).resolves.toEqual({ ok: true });

    expect(platform.writeClipboard).toHaveBeenCalledWith(expect.stringContaining('Current report with'));
    expect(platform.writeClipboard).toHaveBeenCalledWith(expect.stringContaining('## References'));
    expect(platform.writeClipboard).toHaveBeenCalledWith(expect.not.stringContaining('run_id:'));
    expect(await getRun(stored.id)).toEqual(stored);
  });

  it('serializes Copy current behind capture restoration and emits one References section', async () => {
    vi.useFakeTimers();
    const conversationKey = 'https://chatgpt.com/c/current';
    const copiedReport = 'Current report with [Evidence](https://example.com/source).';
    let clipboard = 'User clipboard before capture.';
    let copyStarted!: () => void;
    let releaseProviderCopy!: () => void;
    const providerCopyStarted = new Promise<void>((resolve) => { copyStarted = resolve; });
    const providerCopyGate = new Promise<void>((resolve) => { releaseProviderCopy = resolve; });
    platform.readClipboard.mockImplementation(async () => clipboard);
    platform.writeClipboard.mockImplementation(async (text: string) => { clipboard = text; });
    tabsGet.mockResolvedValue({ id: 44, url: conversationKey } as Browser.tabs.Tab);
    platform.sendTabEvent.mockImplementation(async (_tabId, event) => {
      const request = event as { type: string };
      if (request.type === 'capture:copy-now') {
        clipboard = copiedReport;
        copyStarted();
        await providerCopyGate;
        return { ok: true, copyConfirmed: true };
      }
      if (request.type === 'content:ping') return { ok: true };
      return {
        provider: 'chatgpt', pageUrl: conversationKey, activeRunId: 'run', conversationKey,
        domMarkdown: copiedReport,
        domCitations: [{
          url: 'https://example.com/source', markerText: 'Evidence', domOrder: 0,
          contextBefore: 'Current report with ', contextAfter: '.',
        }],
      };
    });
    const capture = coordinatorTestHooks.clipboardCapture(platform, {
      id: 'run:chatgpt', runId: 'run', provider: 'chatgpt', conversationKey, tabId: 44, state: 'queued',
      createdAt: 1, attempts: 0, domMarkdown: copiedReport, domCitations: [],
    });
    await providerCopyStarted;
    const copyCurrent = coordinatorTestHooks.copyCurrentResponse(44, 'chatgpt', { runId: 'run', conversationKey });
    await Promise.resolve();
    expect(clipboard).toBe(copiedReport);

    releaseProviderCopy();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(capture).resolves.toMatchObject({ text: copiedReport, restored: true });
    await copyCurrent;
    expect(clipboard.match(/^## References$/gm)).toHaveLength(1);
    expect(clipboard).toContain('Current report with');
  });

  it('copies from the run-owned entry tab without a stored key or live content run', async () => {
    const legacy = run({ chatgpt: provider('chatgpt', 45, 'researching') });
    await putRun(legacy);
    tabsGet.mockResolvedValue({ id: 45, url: 'https://chatgpt.com/' } as Browser.tabs.Tab);
    platform.sendTabEvent.mockImplementation(async (_tabId, event) => {
      if ((event as { type: string }).type === 'content:ping') return { ok: true };
      return {
        provider: 'chatgpt', pageUrl: 'https://chatgpt.com/',
        domMarkdown: 'Current entry-page response.', domCitations: [],
      };
    });
    await expect(coordinatorTestHooks.handleRequest(
      { type: 'provider:copy-current', runId: legacy.id, provider: 'chatgpt' }, {},
    )).resolves.toEqual({ ok: true });
    expect(platform.writeClipboard).toHaveBeenCalledWith('Current entry-page response.\n');
  });

  it('fails closed for a mismatched side-panel Copy current request', async () => {
    const legacy = run({ chatgpt: provider('chatgpt', 45, 'researching') });
    legacy.providerRuns.chatgpt!.conversationKey = 'https://chatgpt.com/c/expected';
    await putRun(legacy);
    tabsGet.mockResolvedValue({ id: 45, url: 'https://chatgpt.com/c/other' } as Browser.tabs.Tab);
    await expect(coordinatorTestHooks.handleRequest(
      { type: 'provider:copy-current', runId: legacy.id, provider: 'chatgpt' }, {},
    )).resolves.toMatchObject({ ok: false, code: 'conversation_mismatch' });
    expect(platform.writeClipboard).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong active run', { activeRunId: 'other-run', conversationKey: 'https://chatgpt.com/c/expected', pageUrl: 'https://chatgpt.com/c/expected' }],
    ['wrong snapshot conversation', { activeRunId: 'run', conversationKey: 'https://chatgpt.com/c/expected', pageUrl: 'https://chatgpt.com/c/other' }],
  ])('rejects %s identity before writing Copy current', async (_label, identity) => {
    tabsGet.mockResolvedValue({ id: 46, url: 'https://chatgpt.com/c/expected' } as Browser.tabs.Tab);
    platform.sendTabEvent.mockImplementation(async (_tabId, event) => {
      if ((event as { type: string }).type === 'content:ping') return { ok: true };
      return { provider: 'chatgpt', ...identity, domMarkdown: 'Current response.', domCitations: [] };
    });
    await expect(coordinatorTestHooks.copyCurrentResponse(46, 'chatgpt', {
      runId: 'run', conversationKey: 'https://chatgpt.com/c/expected',
    })).rejects.toMatchObject({ code: 'conversation_mismatch' });
    expect(platform.writeClipboard).not.toHaveBeenCalled();
  });

  it('preserves current-response transport and snapshot diagnostics', async () => {
    tabsGet.mockResolvedValue({ id: 48, url: 'https://chatgpt.com/c/expected' } as Browser.tabs.Tab);
    platform.sendTabEvent.mockImplementation(async (_tabId, event) => {
      if ((event as { type: string }).type === 'content:ping') return { ok: true };
      throw new Error('No ChatGPT response is available to copy.');
    });
    await expect(coordinatorTestHooks.copyCurrentResponse(48, 'chatgpt', {
      runId: 'run', conversationKey: 'https://chatgpt.com/c/expected',
    })).rejects.toThrow('No ChatGPT response is available to copy.');

    platform.sendTabEvent.mockImplementation(async (_tabId, event) => {
      if ((event as { type: string }).type === 'content:ping') return { ok: true };
      return {
        provider: 'chatgpt', pageUrl: 'https://chatgpt.com/c/expected',
        activeRunId: 'run', conversationKey: 'https://chatgpt.com/c/expected',
        domMarkdown: 'Current response.',
        domCitations: [{ url: 'not a URL', domOrder: 0, contextBefore: '', contextAfter: '' }],
      };
    });
    await expect(coordinatorTestHooks.copyCurrentResponse(48, 'chatgpt', {
      runId: 'run', conversationKey: 'https://chatgpt.com/c/expected',
    })).rejects.toThrow('Provider returned invalid citation data.');
  });

  it('rechecks the tab conversation after snapshot processing and before clipboard write', async () => {
    tabsGet
      .mockResolvedValueOnce({ id: 47, url: 'https://chatgpt.com/c/expected' } as Browser.tabs.Tab)
      .mockResolvedValueOnce({ id: 47, url: 'https://chatgpt.com/c/other' } as Browser.tabs.Tab);
    platform.sendTabEvent.mockImplementation(async (_tabId, event) => {
      if ((event as { type: string }).type === 'content:ping') return { ok: true };
      return {
        provider: 'chatgpt', pageUrl: 'https://chatgpt.com/c/expected',
        activeRunId: 'run', conversationKey: 'https://chatgpt.com/c/expected',
        domMarkdown: 'Current response.', domCitations: [],
      };
    });
    await expect(coordinatorTestHooks.copyCurrentResponse(47, 'chatgpt', {
      runId: 'run', conversationKey: 'https://chatgpt.com/c/expected',
    })).rejects.toMatchObject({ code: 'conversation_mismatch' });
    expect(platform.writeClipboard).not.toHaveBeenCalled();
  });

  it('registers and handles the provider-page Copy current context menu', async () => {
    tabsGet.mockResolvedValue({ id: 55, url: 'https://gemini.google.com/app' } as Browser.tabs.Tab);
    platform.sendTabEvent.mockImplementation(async (_tabId, event) => {
      if ((event as { type: string }).type === 'content:ping') return { ok: true };
      return {
        provider: 'gemini', pageUrl: 'https://gemini.google.com/app',
        domMarkdown: 'Current Gemini response.', domCitations: [],
      };
    });

    await coordinatorTestHooks.registerCopyCurrentContextMenu();
    expect(browser.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({
      id: 'copy-current-research-response',
      contexts: ['page'],
      documentUrlPatterns: expect.arrayContaining(['https://gemini.google.com/*']),
    }));

    await coordinatorTestHooks.handleCopyCurrentContextMenu(
      { menuItemId: 'copy-current-research-response' } as Browser.contextMenus.OnClickData,
      { id: 55, url: 'https://gemini.google.com/app' } as Browser.tabs.Tab,
    );
    expect(platform.writeClipboard).toHaveBeenCalledWith('Current Gemini response.\n');
    expect(platform.notify).toHaveBeenCalledWith(
      'copy-current:55', 'Gemini response copied', 'The current normalized response is on your clipboard.',
    );
  });

  it('serializes repeated context-menu registration so no duplicate remains', async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstRemoval = new Promise<void>((resolve) => { releaseFirst = resolve; });
    vi.mocked(browser.contextMenus.remove)
      .mockImplementationOnce(async () => { calls.push('remove:first'); await firstRemoval; })
      .mockImplementationOnce(async () => { calls.push('remove:second'); });
    vi.mocked(browser.contextMenus.create).mockImplementation(() => { calls.push('create'); return 1; });

    const first = coordinatorTestHooks.registerCopyCurrentContextMenu();
    const second = coordinatorTestHooks.registerCopyCurrentContextMenu();
    await vi.waitFor(() => expect(calls).toEqual(['remove:first']));
    releaseFirst();
    await Promise.all([first, second]);
    expect(calls).toEqual(['remove:first', 'create', 'remove:second', 'create']);
  });

  it('notifies when a context-menu current-response copy fails', async () => {
    tabsGet.mockResolvedValue({ id: 56, url: 'https://gemini.google.com/app' } as Browser.tabs.Tab);
    platform.sendTabEvent.mockImplementation(async (_tabId, event) => {
      if ((event as { type: string }).type === 'content:ping') return { ok: true };
      throw new Error('No Gemini response is available to copy.');
    });

    await coordinatorTestHooks.handleCopyCurrentContextMenu(
      { menuItemId: 'copy-current-research-response' } as Browser.contextMenus.OnClickData,
      { id: 56, url: 'https://gemini.google.com/app' } as Browser.tabs.Tab,
    );
    expect(platform.notify).toHaveBeenCalledWith(
      'copy-current:56', 'Could not copy current response', 'No Gemini response is available to copy.',
    );
  });

  it('does not report copy failure when only the success notification fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    tabsGet.mockResolvedValue({ id: 57, url: 'https://gemini.google.com/app' } as Browser.tabs.Tab);
    platform.sendTabEvent.mockImplementation(async (_tabId, event) => {
      if ((event as { type: string }).type === 'content:ping') return { ok: true };
      return { provider: 'gemini', pageUrl: 'https://gemini.google.com/app', domMarkdown: 'Current response.', domCitations: [] };
    });
    platform.notify.mockRejectedValue(new Error('Notifications unavailable'));
    await coordinatorTestHooks.handleCopyCurrentContextMenu(
      { menuItemId: 'copy-current-research-response' } as Browser.contextMenus.OnClickData,
      { id: 57, url: 'https://gemini.google.com/app' } as Browser.tabs.Tab,
    );
    expect(platform.writeClipboard).toHaveBeenCalledWith('Current response.\n');
    expect(platform.notify).toHaveBeenCalledTimes(1);
    expect(platform.notify).not.toHaveBeenCalledWith(expect.anything(), 'Could not copy current response', expect.anything());
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
    }, contentSender(931))).resolves.toMatchObject({ ok: true, providerState: { status: 'capturing' } });
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
    }, contentSender(932))).resolves.toMatchObject({ ok: true, providerState: { status: 'capturing' } });
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
    expect(await getRun(stored.id)).toMatchObject({
      completedAt: 123,
      providerRuns: { chatgpt: { saveReceipt: { destination: 'downloads', savedAt: 123, downloadId: 99 } } },
    });
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

  it('salvages a verified DOM report when citation or trail metadata is malformed', async () => {
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
    expect(await getCapture(id)).toMatchObject({ captureMethod: 'dom_only', rawMarkdown: expect.stringContaining('long enough DOM report') });
    expect((await getRun(stored.id))?.providerRuns.grok?.status).toBe('complete');
  });

  it('keeps reconciled citations if only the research trail is malformed', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 9221, 'capturing') });
    const id = `${stored.id}:chatgpt`;
    await putRun(stored);
    await putJob({ id, runId: stored.id, provider: 'chatgpt', tabId: 9221, state: 'queued',
      createdAt: Date.now(), attempts: 0, tabUnavailable: true,
      domMarkdown: 'The final research report cites [source](https://example.test/article) with sufficient context.',
      domCitations: [{ url: 'https://example.test/article', domOrder: 0, contextBefore: 'The final research report cites', contextAfter: 'with sufficient context.' }],
      researchTrail: { searches: null, openedPages: [], warnings: [] } as unknown as NonNullable<CaptureJob['researchTrail']>,
    });
    await coordinatorTestHooks.processCaptureQueue();
    expect(await getCapture(id)).toMatchObject({ citations: [{ url: 'https://example.test/article' }],
      researchTrail: undefined, metadataDegraded: true, urlsResolved: 0 });
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({ status: 'complete', degraded: true });
  });

  it('resets every derived citation field if citation processing fails', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 9222, 'capturing') });
    const id = `${stored.id}:chatgpt`;
    await putRun(stored);
    const domMarkdown = 'A verified DOM research report has enough text to survive malformed citation processing.';
    await putJob({ id, runId: stored.id, provider: 'chatgpt', tabId: 9222, state: 'queued',
      createdAt: Date.now(), attempts: 0, tabUnavailable: true, domMarkdown,
      domCitations: [{ url: 'https://example.test/article', domOrder: 0, contextBefore: '', contextAfter: '' },
        null as unknown as CaptureJob['domCitations'][number]],
    });
    await coordinatorTestHooks.processCaptureQueue();
    expect(await getCapture(id)).toMatchObject({ normalizedMarkdown: domMarkdown, captureMethod: 'dom_only',
      citations: [], unplacedCitationCount: 0, urlsResolved: 0, urlsUnresolved: 0, metadataDegraded: true });
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
      saveReceipt: { destination: 'downloads', requestedRelativePath: `${stored.downloadFolder}/FAILED-chatgpt.md` },
    });
    expect(platform.sendTabEvent).not.toHaveBeenCalledWith(916, expect.objectContaining({ type: 'content:start' }));
  });

  it('links a prior-session persisted capture through the serialized completion path', async () => {
    const stored = run({ chatgpt: provider('chatgpt', 925, 'researching') });
    const id = `${stored.id}:chatgpt`;
    stored.browserSessionId = 'prior-session';
    reportStorage.config = { handle: {} as FileSystemDirectoryHandle, displayName: 'Reports', configuredAt: 1, needsReconnect: false };
    await putRun(stored);
    await putCapture(id, {
      rawMarkdown: 'Recovered report', normalizedMarkdown: 'Recovered report', citations: [],
      captureMethod: 'copy_only', unplacedCitationCount: 0, capturedAt: 1, urlsResolved: 0, urlsUnresolved: 0,
    });
    await coordinatorTestHooks.reconcileRuns();
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({
      status: 'complete', captureId: id, saveReceipt: { destination: 'directory', actualRelativePath: `${stored.reportFolder}/chatgpt.md` },
    });
    expect(reportStorage.writeUniqueMarkdown).toHaveBeenCalledWith(
      reportStorage.config.handle, stored.reportFolder, 'chatgpt.md', expect.stringContaining('Recovered report'),
    );
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
    }, contentSender(918))).resolves.toMatchObject({
      ok: false, code: 'provider_terminal',
    });
  });
});

describe('durable acceptance and state recovery regressions', () => {
  function captureRequest(stored: Run) {
    return {type:'content:capture',runId:stored.id,provider:'chatgpt',domMarkdown:'A complete research report with sufficient meaningful evidence for persistence.',domCitations:[]} as const;
  }
  function jobFor(stored: Run): CaptureJob {
    return {...captureRequest(stored),id:`${stored.id}:chatgpt`,tabId:1,state:'queued',createdAt:Date.now(),attempts:0,domCitations:[]};
  }
  it('accepts automatic capture from the exact run-owned entry tab without a conversation key', async () => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    await putRun(stored);
    await expect(coordinatorTestHooks.handleRequest(
      {...captureRequest(stored), domCitations: []}, contentSender(),
    )).resolves.toMatchObject({ok:true,providerState:{status:'capturing',conversationKey:undefined}});
    await vi.waitFor(async () => expect(await getJob(`${stored.id}:chatgpt`)).toBeUndefined());
  });
  it.each([
    ['wrong tab', contentSender(2)],
    ['wrong origin', contentSender(1, 'https://example.com/')],
    ['unsupported provider path', contentSender(1, 'https://chatgpt.com/share/123')],
  ])('rejects content state from the %s', async (_label, sender) => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    await putRun(stored);
    await expect(coordinatorTestHooks.handleRequest({
      type:'content:state',runId:stored.id,provider:'chatgpt',status:'researching',
    },sender)).resolves.toMatchObject({ok:false,code:'conversation_mismatch'});
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.conversationKey).toBeUndefined();
  });
  it('lazily normalizes compatible stored and reported legacy conversation keys', async () => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    stored.providerRuns.chatgpt!.conversationKey = 'https://chatgpt.com/c/bound/?model=research#sources';
    await putRun(stored);
    await expect(coordinatorTestHooks.handleRequest({
      type:'content:state',runId:stored.id,provider:'chatgpt',status:'researching',
      conversationKey:'https://chatgpt.com/c/bound?model=fast#answer',
    },contentSender(1, 'https://chatgpt.com/c/bound/?temporary=1'))).resolves.toMatchObject({
      ok:true,providerState:{conversationKey:'https://chatgpt.com/c/bound'},
    });
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.conversationKey)
      .toBe('https://chatgpt.com/c/bound');
  });
  it('binds an unbound resumed submission from the sender conversation when the report omitted its key', async () => {
    const stored = run({chatgpt:provider('chatgpt',1,'submitting')});
    await putRun(stored);

    await expect(coordinatorTestHooks.handleRequest({
      type:'content:state',runId:stored.id,provider:'chatgpt',status:'manual_required',
      detail:'Submission could not be confirmed.',
    },contentSender(1, 'https://chatgpt.com/c/bound'))).resolves.toMatchObject({
      ok:true,providerState:{status:'manual_required',conversationKey:'https://chatgpt.com/c/bound'},
    });
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.conversationKey)
      .toBe('https://chatgpt.com/c/bound');
  });
  it('preserves the bound conversation through recoverable navigation and clears detachment on return', async () => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    stored.providerRuns.chatgpt!.conversationKey = 'https://chatgpt.com/c/bound';
    await putRun(stored);

    await expect(coordinatorTestHooks.handleRequest({
      type:'content:state',runId:stored.id,provider:'chatgpt',status:'manual_required',
      reason:'provider_navigation',detail:'Return to the original conversation.',
      conversationKey:'https://chatgpt.com/c/bound',
    },contentSender(1, 'https://chatgpt.com/library'))).resolves.toMatchObject({
      ok:true,providerState:{status:'manual_required',conversationKey:'https://chatgpt.com/c/bound'},
    });
    expect((await getRun(stored.id))?.providerRuns.chatgpt).toMatchObject({
      conversationKey:'https://chatgpt.com/c/bound',detachedAt:expect.any(Number),
    });

    const returnedAt = Date.now();
    await expect(coordinatorTestHooks.handleRequest({
      type:'content:state',runId:stored.id,provider:'chatgpt',status:'researching',
      submittedAt:returnedAt,conversationKey:'https://chatgpt.com/c/bound',
    },contentSender(1, 'https://chatgpt.com/c/bound'))).resolves.toMatchObject({
      ok:true,providerState:{status:'researching',conversationKey:'https://chatgpt.com/c/bound'},
    });
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.detachedAt).toBeUndefined();
  });
  it.each([
    'https://chatgpt.com/',
    'https://chatgpt.com/c/other',
    'https://chatgpt.com/library',
  ])('accepts interruption from the owning provider tab on %s without rebinding', async (url) => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    stored.providerRuns.chatgpt!.conversationKey = 'https://chatgpt.com/c/bound';
    await putRun(stored);

    await expect(coordinatorTestHooks.handleRequest({
      type:'content:state',runId:stored.id,provider:'chatgpt',status:'interrupted',
      conversationKey:'https://chatgpt.com/c/bound',
    },contentSender(1, url))).resolves.toMatchObject({
      ok:true,providerState:{status:'interrupted',conversationKey:'https://chatgpt.com/c/bound'},
    });
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.conversationKey)
      .toBe('https://chatgpt.com/c/bound');
  });
  it.each([
    ['another tab', contentSender(2, 'https://chatgpt.com/library')],
    ['another origin', contentSender(1, 'https://example.com/')],
  ])('rejects interruption from %s', async (_label, sender) => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    stored.providerRuns.chatgpt!.conversationKey = 'https://chatgpt.com/c/bound';
    await putRun(stored);

    await expect(coordinatorTestHooks.handleRequest({
      type:'content:state',runId:stored.id,provider:'chatgpt',status:'interrupted',
      conversationKey:'https://chatgpt.com/c/bound',
    },sender)).resolves.toMatchObject({ok:false,code:'conversation_mismatch'});
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.status).toBe('researching');
  });
  it('fails closed when a persisted conversation key cannot be normalized', async () => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    stored.providerRuns.chatgpt!.conversationKey = 'legacy-conversation-key';
    await putRun(stored);

    await expect(coordinatorTestHooks.handleRequest({
      type:'content:state',runId:stored.id,provider:'chatgpt',status:'researching',
      conversationKey:'https://chatgpt.com/c/current',
    },contentSender(1, 'https://chatgpt.com/c/current'))).resolves.toMatchObject({
      ok:false,code:'conversation_mismatch',
    });
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.conversationKey).toBe('legacy-conversation-key');
  });
  it('persists the first conversation key and rejects later unavailable or different keys', async () => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    await putRun(stored);
    const bound = await coordinatorTestHooks.handleRequest({
      type:'content:state',runId:stored.id,provider:'chatgpt',status:'researching',
      conversationKey:'https://chatgpt.com/c/bound',
    },contentSender(1, 'https://chatgpt.com/c/bound'));
    expect(bound).toMatchObject({ok:true,providerState:{conversationKey:'https://chatgpt.com/c/bound'}});
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.conversationKey).toBe('https://chatgpt.com/c/bound');

    await expect(coordinatorTestHooks.handleRequest({
      type:'content:state',runId:stored.id,provider:'chatgpt',status:'researching',
    },contentSender(1, 'https://chatgpt.com/c/bound'))).resolves.toMatchObject({ok:false,code:'conversation_mismatch'});
    await expect(coordinatorTestHooks.handleRequest({
      type:'content:state',runId:stored.id,provider:'chatgpt',status:'researching',
      conversationKey:'https://chatgpt.com/c/other',
    },contentSender(1, 'https://chatgpt.com/c/bound'))).resolves.toMatchObject({ok:false,code:'conversation_mismatch'});
  });
  it.each([undefined, 'https://chatgpt.com/c/other'])('rejects automatic capture with mismatched conversation key %s', async (conversationKey) => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    stored.providerRuns.chatgpt!.conversationKey = 'https://chatgpt.com/c/bound';
    await putRun(stored);
    await expect(coordinatorTestHooks.handleRequest({
      ...captureRequest(stored), conversationKey, domCitations: [],
    },contentSender(1, 'https://chatgpt.com/c/bound'))).resolves.toMatchObject({ok:false,code:'conversation_mismatch'});
    expect(await getJob(`${stored.id}:chatgpt`)).toBeUndefined();
    expect((await getRun(stored.id))?.providerRuns.chatgpt?.status).toBe('researching');
  });
  it.each(['setting_mode','submitting','opening'] as const)('rejects capture in %s without leaving a job', async (status) => {
    const stored = run({chatgpt:provider('chatgpt',1,status)});
    await putRun(stored);
    await expect(coordinatorTestHooks.handleRequest(
      {...captureRequest(stored),domCitations:[]}, contentSender(),
    )).resolves.toMatchObject({ok:false,code:'invalid_transition',providerState:{status}});
    expect(await getJob(`${stored.id}:chatgpt`)).toBeUndefined();
    expect((await getRun(stored.id))!.providerRuns.chatgpt!.status).toBe(status);
  });
  it('rolls back the job when the run write fails after the job write', async () => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    await putRun(stored);
    await expect(acceptCaptureJob(jobFor(stored),(current) => {
      current!.providerRuns.chatgpt!.status='capturing';
      current!.query = (() => undefined) as unknown as string;
      return current!;
    })).rejects.toThrow();
    expect(await getJob(`${stored.id}:chatgpt`)).toBeUndefined();
    expect((await getRun(stored.id))!.providerRuns.chatgpt!.status).toBe('researching');
  });
  it('rolls back state when the payload cannot be stored', async () => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    await putRun(stored);
    const job = jobFor(stored);
    job.domMarkdown = (() => undefined) as unknown as string;
    await expect(acceptCaptureJob(job,(current) => {current!.providerRuns.chatgpt!.status='capturing'; return current!;})).rejects.toThrow();
    expect(await getJob(job.id)).toBeUndefined();
    expect((await getRun(stored.id))!.providerRuns.chatgpt!.status).toBe('researching');
  });
  it('drops a legacy unaccepted job without failing its setup-phase provider', async () => {
    const stored = run({chatgpt:provider('chatgpt',1,'setting_mode')});
    await putRun(stored);
    await putJob(jobFor(stored));
    await coordinatorTestHooks.processCaptureQueue();
    expect(await getJob(`${stored.id}:chatgpt`)).toBeUndefined();
    expect((await getRun(stored.id))!.providerRuns.chatgpt!.status).toBe('setting_mode');
  });
  it('reconciles a recoverable legacy job before completing it', async () => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    await putRun(stored);
    await putJob({...jobFor(stored),tabUnavailable:true});
    await coordinatorTestHooks.processCaptureQueue();
    expect(await getJob(`${stored.id}:chatgpt`)).toBeUndefined();
    expect((await getRun(stored.id))!.providerRuns.chatgpt!.status).toBe('complete');
  });
  it('preserves timeout state per active interval and resets it for genuine resumed research', async () => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    const submittedAt = Date.now()-3600000;
    stored.providerRuns.chatgpt!.submittedAt=submittedAt;
    await putRun(stored);
    const request = {type:'content:state',runId:stored.id,provider:'chatgpt',status:'manual_required',reason:'research_timeout',detail:'Timed out',submittedAt:Date.now()} as const;
    const first = await coordinatorTestHooks.handleRequest(request,contentSender());
    const second = await coordinatorTestHooks.handleRequest(request,contentSender());
    expect(first).toMatchObject({ok:true,providerState:{status:'manual_required',submittedAt,researchTimedOutAt:expect.any(Number)}});
    expect(second).toEqual(first);
    expect(platform.notify).toHaveBeenCalledTimes(1);
    await coordinatorTestHooks.startContent((await getRun(stored.id))!,'chatgpt',true);
    expect(platform.sendTabEvent).toHaveBeenCalledWith(1,expect.objectContaining({type:'content:start',submittedAt,researchTimedOutAt:expect.any(Number)}));
    const resumedAt=Date.now();
    await expect(coordinatorTestHooks.handleRequest({...request,status:'researching',submittedAt:resumedAt,reason:undefined},contentSender()))
      .resolves.toEqual({ok:true,providerState:{status:'researching',submittedAt:resumedAt,researchTimedOutAt:undefined}});
    const nextTimeout = await coordinatorTestHooks.handleRequest({...request,submittedAt:resumedAt},contentSender());
    expect(nextTimeout).toMatchObject({ok:true,providerState:{status:'manual_required',submittedAt:resumedAt,researchTimedOutAt:expect.any(Number)}});
    expect(platform.notify).toHaveBeenCalledTimes(2);
  });
  it('accepts an explicitly fresh research interval while the stored status still says researching', async () => {
    const stored = run({chatgpt:provider('chatgpt',1,'researching')});
    const priorSubmittedAt = Date.now() - 60_000;
    const resumedAt = Date.now();
    stored.providerRuns.chatgpt!.submittedAt = priorSubmittedAt;
    stored.providerRuns.chatgpt!.researchTimedOutAt = Date.now() - 1000;
    await putRun(stored);

    await expect(coordinatorTestHooks.handleRequest({
      type:'content:state',runId:stored.id,provider:'chatgpt',status:'researching',submittedAt:resumedAt,
    },contentSender())).resolves.toEqual({
      ok:true,providerState:{status:'researching',submittedAt:resumedAt,researchTimedOutAt:undefined},
    });
  });
  it('acknowledges a stored state even if notification delivery fails', async () => {
    vi.spyOn(console,'error').mockImplementation(() => undefined);
    const stored=run({chatgpt:provider('chatgpt',1,'researching')});
    await putRun(stored);
    platform.notify.mockRejectedValue(new Error('notifications unavailable'));
    await expect(coordinatorTestHooks.handleRequest(
      {type:'content:state',runId:stored.id,provider:'chatgpt',status:'manual_required'},contentSender(),
    )).resolves.toMatchObject({ok:true,providerState:{status:'manual_required'}});
    vi.restoreAllMocks();
  });
  it('returns a terminal snapshot for stale state reports', async () => {
    const stored=run({chatgpt:provider('chatgpt',1,'complete')},'complete');
    await putRun(stored);
    await expect(coordinatorTestHooks.handleRequest(
      {type:'content:state',runId:stored.id,provider:'chatgpt',status:'researching'},contentSender(),
    )).resolves.toMatchObject({ok:false,code:'provider_terminal',providerState:{status:'complete'}});
  });
  it('does not inject another script when a reachable receiver rejects startup', async () => {
    const stored=run({chatgpt:provider('chatgpt',1,'setting_mode')});
    await putRun(stored);
    const executeScript=vi.fn();
    Object.assign(browser,{scripting:{executeScript}});
    platform.sendTabEvent.mockImplementation(async (_tab,event) => {
      if ((event as {type:string}).type==='content:ping') return {ok:true};
      throw new Error('Invalid application state');
    });
    await coordinatorTestHooks.startContent(stored,'chatgpt');
    expect(executeScript).not.toHaveBeenCalled();
    expect(platform.sendTabEvent).toHaveBeenCalledTimes(2);
  });
  it('injects only after ping establishes that the receiver is missing', async () => {
    const stored=run({chatgpt:provider('chatgpt',1,'opening')});
    await putRun(stored);
    const executeScript=vi.fn(async () => undefined);
    Object.assign(browser,{scripting:{executeScript}});
    platform.sendTabEvent.mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.')).mockResolvedValue({ok:true});
    const start=coordinatorTestHooks.startContent(stored,'chatgpt');
    await start;
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(platform.sendTabEvent).toHaveBeenLastCalledWith(1,expect.objectContaining({type:'content:start'}));
  });
});
