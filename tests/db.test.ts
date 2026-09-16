// @vitest-environment node
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { captureId, deleteJob, deleteReportDirectoryConfig, getCapture, getJob, getRedirect, getReportDirectoryConfig, getRun, listRuns, nextCaptureJob, pruneExpiredRedirects, putCapture, putJob, putRedirect, putReportDirectoryConfig, putRun, REDIRECT_RETENTION_MS } from '../src/db';
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
        id, query: id, createdAt: index, completedAt: index + 1, windowId: 1, status: 'complete', slug: id,
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
    try {
      await putJob(valid);
      for (const job of jobs.slice(1, 4)) {
        await expect(putJob(job)).rejects.toThrow('malformed capture job');
        await putLegacyJob(job);
      }
      await putJob(jobs[4]!);
      expect(await getJob(valid.id)).toMatchObject({ leasedAt: valid.leasedAt });
      for (const job of jobs.slice(1, 4)) {
        expect(await getJob(job.id)).toMatchObject({
          state: 'queued', domMarkdown: 'Report', conversationKey: valid.conversationKey,
        });
      }
      expect(await getJob('queued-without-lease')).toMatchObject({ state: 'queued' });
      expect((await nextCaptureJob())?.id).toBe('lease-missing');
    } finally {
      for (const job of jobs) await deleteJob(job.id);
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

  it('migrates legacy download metadata into a receipt and adopts query-based folders', async () => {
    const legacy = {
      id: 'legacy-run-12345678', query: 'Legacy query', createdAt: 1, windowId: 1, status: 'active', slug: 'legacy-query',
      downloadFolder: 'deep-research/2026-01-01_1200_legacy-query_legacyrun12345678',
      providerRuns: {
        chatgpt: {
          provider: 'chatgpt', tabId: 1, status: 'complete', submittedQuery: 'Legacy query', appendString: '', attempts: 0,
          degraded: false, adapterVersion: 'test', captureId: 'legacy:capture', downloadedAt: 123, downloadId: 9,
        },
        claude: {
          provider: 'claude', tabId: 2, status: 'researching', submittedQuery: 'Legacy query', appendString: '', attempts: 0,
          degraded: false, adapterVersion: 'test',
        },
      },
    } as unknown as Run;
    await putRun(legacy);

    const migrated = await getRun(legacy.id);
    expect(migrated).toMatchObject({
      reportFolder: 'legacy-query-legacyru',
      downloadFolder: 'deep-research/legacy-query-legacyru',
      providerRuns: { chatgpt: { saveReceipt: { destination: 'downloads', savedAt: 123, downloadId: 9 } } },
    });
    expect(migrated?.providerRuns.chatgpt?.saveReceipt?.requestedRelativePath).toContain('2026-01-01_1200_legacy-query_legacyrun12345678/chatgpt.md');
    expect(migrated?.providerRuns.chatgpt?.downloadedAt).toBeUndefined();
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
