// @vitest-environment node
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { captureId, captureJobIsEligible, deleteJob, deleteReportDirectoryConfig, getCapture, getJob, getRedirect, getReportDirectoryConfig, getRun, inspectCaptureRecovery, listPausedCaptureJobIds, listRuns, nextCaptureJob, pruneExpiredRedirects, putCapture, putJob, putRedirect, putReportDirectoryConfig, putRun, REDIRECT_RETENTION_MS } from '../src/db';
import type { Capture, CaptureJob, Run } from '../src/types';

const capture: Capture = {
  rawMarkdown: 'report', normalizedMarkdown: 'report', citations: [], captureMethod: 'dom_only',
  unplacedCitationCount: 0, capturedAt: 1, urlsResolved: 0, urlsUnresolved: 0,
};

async function putLegacyJob(job: CaptureJob): Promise<void> {
  await getJob('__initialize__');
  const database = await openDB('deep-research-fan-out', 3);
  try { await database.put('jobs', job); }
  finally { database.close(); }
}

describe('run history', () => {
  beforeAll(async () => {
    for (let index = 0; index < 22; index += 1) {
      const id = `run-${String(index).padStart(2, '0')}`;
      const storedCapture = captureId(id, 'chatgpt');
      const run: Run = {
        recordVersion: 2, id, query: id, createdAt: index, completedAt: index + 1, windowId: 1, status: 'complete', slug: id,
        reportFolder: `${id}-00000000`, downloadFolder: `deep-research/${id}-00000000`,
        providerRuns: {
          chatgpt: {
            provider: 'chatgpt', tabId: index, status: 'complete', submittedQuery: id, appendString: '',
            attempts: 0, degraded: false, adapterVersion: 'test', captureId: storedCapture,
          },
        },
      };
      await putCapture(storedCapture, capture);
      await putRun(run);
    }
  });

  it('retains completed runs and their captures beyond the old twenty-run limit', async () => {
    await pruneExpiredRedirects();
    const runs = await listRuns();
    expect(runs).toHaveLength(22);
    expect(runs[0]?.id).toBe('run-21');
    expect(runs.at(-1)?.id).toBe('run-00');
    expect(await getCapture(captureId('run-00', 'chatgpt'))).toBeDefined();
    expect(await getCapture(captureId('run-02', 'chatgpt'))).toBeDefined();
  });

  it('evicts redirects outside the retention window', async () => {
    await putRedirect('https://wrapper.test/old', 'https://canonical.test/old', Date.now() - REDIRECT_RETENTION_MS - 1);
    await putRedirect('https://wrapper.test/current', 'https://canonical.test/current');

    await pruneExpiredRedirects();
    expect(await getRedirect('https://wrapper.test/old')).toBeUndefined();
    expect(await getRedirect('https://wrapper.test/current')).toBe('https://canonical.test/current');
  });

  it('normalizes a malformed optional orphan timestamp without writing during the read', async () => {
    const valid: CaptureJob = {
      id: 'orphan-valid', runId: 'missing-run', provider: 'chatgpt', tabId: 1,
      state: 'orphaned', createdAt: Date.now(), orphanedAt: Date.now(), attempts: 1,
      domMarkdown: 'A retained report with enough text to be recovered later.', domCitations: [],
    };
    const invalid = { ...valid, id: 'orphan-invalid', orphanedAt: 'yesterday' } as unknown as CaptureJob;
    try {
      await putJob(valid);
      await expect(putJob(invalid)).rejects.toThrow('malformed capture job');
      await putLegacyJob(invalid);
      expect(await getJob(valid.id)).toMatchObject({ orphanedAt: valid.orphanedAt });
      const normalized = await getJob(invalid.id);
      expect(normalized?.id).toBe(invalid.id);
      expect(normalized?.orphanedAt).toBeUndefined();
      const raw = await openDB('deep-research-fan-out', 3);
      expect((await raw.get('jobs', invalid.id))?.orphanedAt).toBe('yesterday');
      raw.close();
      expect(await nextCaptureJob()).toBeUndefined();
    } finally {
      await deleteJob(valid.id);
      await deleteJob(invalid.id);
    }
  });

  it('repairs malformed legacy leases without losing their retained reports', async () => {
    const valid: CaptureJob = {
      id: 'lease-valid', runId: 'missing-run', provider: 'chatgpt', conversationKey: 'https://chatgpt.com/c/retained', tabId: 1,
      state: 'leased', createdAt: Date.now(), leasedAt: Date.now(), attempts: 1,
      domMarkdown: 'Report', domCitations: [],
    };
    const jobs = [
      valid,
      { ...valid, id: 'lease-missing', createdAt: valid.createdAt + 1, leasedAt: undefined },
      { ...valid, id: 'lease-string', createdAt: valid.createdAt + 2, leasedAt: 'yesterday' },
      { ...valid, id: 'lease-infinite', createdAt: valid.createdAt + 3, leasedAt: Infinity },
      { ...valid, id: 'queued-without-lease', createdAt: valid.createdAt + 4, state: 'queued', leasedAt: undefined },
    ] as CaptureJob[];
    const invalidToken = { ...valid, id: 'lease-invalid-token', createdAt: valid.createdAt + 5, leaseToken: 42 } as unknown as CaptureJob;
    const staleQueuedToken = { ...valid, id: 'queued-stale-token', createdAt: valid.createdAt + 6,
      state: 'queued', leasedAt: undefined, leaseToken: 'stale' } as CaptureJob;
    try {
      await putJob(valid);
      for (const job of jobs.slice(1, 4)) {
        await expect(putJob(job)).rejects.toThrow('malformed capture job');
        await putLegacyJob(job);
      }
      await putJob(jobs[4]!);
      await putLegacyJob(invalidToken);
      await putLegacyJob(staleQueuedToken);
      expect(await getJob(valid.id)).toMatchObject({ leasedAt: valid.leasedAt });
      for (const job of jobs.slice(1, 4)) {
        expect(await getJob(job.id)).toMatchObject({
          state: 'queued', domMarkdown: 'Report', conversationKey: valid.conversationKey,
        });
      }
      expect(await getJob('queued-without-lease')).toMatchObject({ state: 'queued' });
      expect(await getJob(invalidToken.id)).toMatchObject({ state: 'leased' });
      expect((await getJob(invalidToken.id))?.leaseToken).toBeUndefined();
      expect(await getJob(staleQueuedToken.id)).toMatchObject({ state: 'queued' });
      expect((await getJob(staleQueuedToken.id))?.leaseToken).toBeUndefined();
      expect((await nextCaptureJob())?.id).toBe('lease-missing');
    } finally {
      for (const job of jobs) await deleteJob(job.id);
      await deleteJob(invalidToken.id);
      await deleteJob(staleQueuedToken.id);
    }
  });

  it('returns in-memory repairs when job writes are unavailable', async () => {
    const job = {
      id: 'readonly-repair', runId: 'missing-run', provider: 'chatgpt', tabId: 1,
      state: 'leased', createdAt: 1, attempts: 1, leasedAt: undefined,
      deferredAt: null, domMarkdown: 'A retained report available during storage pressure.', domCitations: [],
    } as unknown as CaptureJob;
    await putLegacyJob(job);
    const originalPut = IDBObjectStore.prototype.put;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'jobs') throw new DOMException('storage full', 'QuotaExceededError');
      return originalPut.call(this, value, key);
    });
    try {
      const normalized = await getJob(job.id);
      expect(normalized?.state).toBe('queued');
      expect(normalized?.leasedAt).toBeUndefined();
      expect(normalized?.deferredAt).toBeUndefined();
      expect(await nextCaptureJob()).toMatchObject({ id: job.id, state: 'queued' });
      expect(putSpy).not.toHaveBeenCalled();
    } finally {
      putSpy.mockRestore();
      await deleteJob(job.id);
    }
  });

  it('reclaims zero leases and normalizes malformed leases directly from the queue', async () => {
    const zeroLease: CaptureJob = {
      id: 'lease-zero', runId: 'missing-run', provider: 'chatgpt', tabId: 1,
      state: 'leased', createdAt: 1, leasedAt: 0, attempts: 1,
      domMarkdown: 'A retained report', domCitations: [],
    };
    const missingLease = { ...zeroLease, id: 'lease-from-queue', createdAt: 2, leasedAt: undefined };
    try {
      await putJob(zeroLease);
      await putLegacyJob(missingLease);
      expect((await nextCaptureJob())?.id).toBe(zeroLease.id);
      await deleteJob(zeroLease.id);
      expect(await nextCaptureJob()).toMatchObject({ id: missingLease.id, state: 'queued', domMarkdown: 'A retained report' });
      expect(await getJob(missingLease.id)).toMatchObject({ state: 'queued' });
    } finally {
      await deleteJob(zeroLease.id);
      await deleteJob(missingLease.id);
    }
  });

  it('reclaims a lease stamped in the future after the wall clock moves backward', async () => {
    const job: CaptureJob = {
      id: 'lease-from-future', runId: 'missing-run', provider: 'chatgpt', tabId: 1,
      state: 'leased', createdAt: 1, leasedAt: Date.now() + 60 * 60 * 1000, attempts: 1,
      domMarkdown: 'A retained report from a future-stamped lease.', domCitations: [],
    };
    try {
      await putJob(job);
      expect(await nextCaptureJob()).toMatchObject({ id: job.id });
    } finally { await deleteJob(job.id); }
  });

  it('uses one eligibility table for lease backoff, recovery, and navigation deferral', () => {
    const now = Date.now();
    const job: CaptureJob = {
      id: 'eligibility:chatgpt', runId: 'eligibility', provider: 'chatgpt', tabId: 1,
      state: 'queued', createdAt: now, attempts: 1,
      domMarkdown: 'A retained report used to verify queue eligibility.', domCitations: [],
    };
    const providerRun = {
      provider: 'chatgpt' as const, tabId: 1, status: 'capturing' as const,
      submittedQuery: 'query', appendString: '', attempts: 0, degraded: false, adapterVersion: 'test',
    };
    expect(captureJobIsEligible({ ...job, state: 'leased', leasedAt: now }, providerRun, now)).toBe(false);
    expect(captureJobIsEligible({ ...job, state: 'leased', leasedAt: now - 60_001 }, providerRun, now)).toBe(true);
    expect(captureJobIsEligible(job, { ...providerRun, captureRecoveryPending: true }, now)).toBe(false);
    expect(captureJobIsEligible({ ...job, deferredForNavigation: true, deferredAt: now }, providerRun, now)).toBe(false);
    expect(captureJobIsEligible(
      { ...job, deferredForNavigation: true, deferredAt: now }, { ...providerRun, status: 'abandoned' }, now,
    )).toBe(true);
  });

  it('continues queue scans across equal timestamps without loading all jobs', async () => {
    const createdAt = Date.now();
    const jobs: CaptureJob[] = ['cursor-a', 'cursor-b'].map((id, index) => ({
      id, runId: `missing-cursor-${index}`, provider: 'chatgpt', tabId: index + 1,
      state: 'queued', createdAt, attempts: 0,
      domMarkdown: `A retained cursor report ${index} with enough content for queue processing.`, domCitations: [],
    }));
    const getAllSpy = vi.spyOn(IDBIndex.prototype, 'getAll');
    try {
      for (const job of jobs) await putJob(job);
      const first = await nextCaptureJob();
      expect(first?.id).toBe('cursor-a');
      const second = await nextCaptureJob({ createdAt: first!.createdAt, id: first!.id });
      expect(second?.id).toBe('cursor-b');
      expect(await nextCaptureJob({ createdAt: second!.createdAt, id: second!.id })).toBeUndefined();
      expect(getAllSpy).not.toHaveBeenCalled();
    } finally {
      getAllSpy.mockRestore();
      for (const job of jobs) await deleteJob(job.id);
    }
  });

  it('skips paused jobs without reading their runs', async () => {
    const runId = `missing-paused-${crypto.randomUUID()}`;
    const job: CaptureJob = {
      id: `${runId}:chatgpt`, runId, provider: 'chatgpt', tabId: 1,
      state: 'paused', createdAt: Date.now(), attempts: 3,
      domMarkdown: 'A retained paused report that must not trigger a run lookup.', domCitations: [],
    };
    const originalGet = IDBObjectStore.prototype.get;
    let runReads = 0;
    const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      if (this.name === 'runs' && key === runId) runReads += 1;
      return originalGet.call(this, key);
    });
    try {
      await putJob(job);
      await nextCaptureJob();
      expect(runReads).toBe(0);
    } finally {
      getSpy.mockRestore();
      await deleteJob(job.id);
    }
  });

  it('lists paused jobs through index keys without opening value cursors', async () => {
    const runId = `paused-keys-${crypto.randomUUID()}`;
    const id = `${runId}:chatgpt`;
    const getAllKeysSpy = vi.spyOn(IDBIndex.prototype, 'getAllKeys');
    const openCursorSpy = vi.spyOn(IDBIndex.prototype, 'openCursor');
    try {
      await putJob({
        id, runId, provider: 'chatgpt', tabId: 1, state: 'paused', createdAt: Date.now(), attempts: 3,
        domMarkdown: 'A retained paused report discovered through its index key.', domCitations: [],
      });
      expect(await listPausedCaptureJobIds()).toContain(id);
      expect(getAllKeysSpy).toHaveBeenCalled();
      expect(openCursorSpy).not.toHaveBeenCalled();
    } finally {
      getAllKeysSpy.mockRestore();
      openCursorSpy.mockRestore();
      await deleteJob(id);
    }
  });

  it('classifies saved recovery through its capture key without loading the report body', async () => {
    const runId = `capture-key-${crypto.randomUUID()}`;
    const id = `${runId}:chatgpt`;
    const stored: Run = {
      recordVersion: 2, id: runId, query: 'query', createdAt: Date.now(), windowId: 1,
      status: 'complete', slug: 'query', reportFolder: 'query-capture-key',
      downloadFolder: 'deep-research/query-capture-key',
      providerRuns: {
        chatgpt: {
          provider: 'chatgpt', tabId: 1, status: 'failed', submittedQuery: 'query', appendString: '',
          attempts: 0, degraded: false, adapterVersion: 'test', completedAt: Date.now(),
        },
      },
    };
    await putRun(stored);
    await putCapture(id, { ...capture });
    const originalGet = IDBObjectStore.prototype.get;
    let captureReads = 0;
    const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      if (this.name === 'captures' && key === id) captureReads += 1;
      return originalGet.call(this, key);
    });
    try {
      await expect(inspectCaptureRecovery(id, runId, 'chatgpt')).resolves.toMatchObject({ kind: 'saved_capture' });
      expect(captureReads).toBe(0);
    } finally { getSpy.mockRestore(); }
  });

  it('rejects obsolete run records instead of migrating them on read', async () => {
    const obsolete = {
      id: 'obsolete-v1-run', query: 'legacy', createdAt: Date.now(), windowId: 1, status: 'complete',
      providerRuns: {}, slug: 'legacy',
    } as unknown as Run;
    await expect(putRun(obsolete)).rejects.toThrow('malformed research run');
    expect(await getRun(obsolete.id)).toBeUndefined();
  });

  it('keeps the chosen directory configuration in the local database', async () => {
    const config = {
      handle: { name: 'Reports', kind: 'directory' } as FileSystemDirectoryHandle,
      displayName: 'Reports', configuredAt: 456, needsReconnect: false,
    };
    await putReportDirectoryConfig(config);
    expect(await getReportDirectoryConfig()).toEqual(config);
    await deleteReportDirectoryConfig();
    expect(await getReportDirectoryConfig()).toBeUndefined();
  });
});
