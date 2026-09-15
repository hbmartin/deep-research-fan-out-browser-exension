// @vitest-environment node
import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '../src/types';

describe('research database v2 upgrade', () => {
  beforeEach(async () => {
    vi.resetModules();
    await deleteDB('deep-research-fan-out');
  });

  it('opens around malformed v1 records and lazily normalizes valid receipts and paths', async () => {
    const legacyRun = {
      id: '12345678-abcd', query: 'Upgrade query', createdAt: 1, windowId: 1, status: 'complete', slug: 'upgrade-query',
      downloadFolder: 'deep-research/2026-01-01_1200_upgrade-query_12345678abcd',
      providerRuns: {
        chatgpt: {
          provider: 'chatgpt', tabId: 1, status: 'failed', submittedQuery: 'Upgrade query', appendString: '', attempts: 0,
          degraded: false, adapterVersion: 'test', captureId: 'legacy:capture', downloadedAt: 22, downloadId: 4,
        },
        gemini: {
          provider: 'gemini', tabId: 2, status: 'failed', submittedQuery: 'Upgrade query', appendString: '', attempts: 0,
          degraded: false, adapterVersion: 'test',
          saveReceipt: {
            destination: 'downloads',
            requestedRelativePath: 'deep-research/2026-01-01_1200_upgrade-query_12345678abcd/FAILED-gemini.md',
            savedAt: 23,
            downloadId: 5,
          },
        },
      },
    } as unknown as Run;
    const malformedRun = {
      id: 'malformed-v1', query: 'Broken', createdAt: 2, windowId: 1, status: 'active',
      providerRuns: { chatgpt: {
        provider: 'chatgpt', tabId: 3, status: 'failed', submittedQuery: 'Broken', appendString: '', attempts: 0,
        degraded: false, adapterVersion: 'test',
        saveReceipt: { destination: 'downloads', requestedRelativePath: 42, savedAt: 3 },
      } },
    };
    const alreadyMigratedRun = {
      id: 'already-migrated', query: 'Earlier migration', createdAt: 3, windowId: 1, status: 'complete',
      recordVersion: 2, slug: 'earlier-migration', reportFolder: 'earlier-migration-alreadym',
      downloadFolder: 'deep-research/earlier-migration-alreadym',
      providerRuns: { grok: {
        provider: 'grok', tabId: 4, status: 'failed', submittedQuery: 'Earlier migration', appendString: '', attempts: 0,
        degraded: false, adapterVersion: 'test',
        saveReceipt: {
          destination: 'downloads',
          requestedRelativePath: 'deep-research/2025-12-01_0900_earlier-migration/FAILED-grok.md',
          savedAt: 24,
          downloadId: 6,
        },
      } },
    } as unknown as Run;
    const versionOne = await openDB('deep-research-fan-out', 1, {
      upgrade(database) {
        const runs = database.createObjectStore('runs', { keyPath: 'id' });
        runs.createIndex('by-created', 'createdAt');
        runs.createIndex('by-status', 'status');
        const jobs = database.createObjectStore('jobs', { keyPath: 'id' });
        jobs.createIndex('by-created', 'createdAt');
        jobs.createIndex('by-state', 'state');
        database.createObjectStore('captures');
        database.createObjectStore('redirects', { keyPath: 'wrapper' });
      },
    });
    await versionOne.put('runs', legacyRun);
    await versionOne.put('runs', malformedRun as unknown as Run);
    await versionOne.put('runs', alreadyMigratedRun);
    versionOne.close();

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const database = await import('../src/db');
    const upgraded = await database.getRun(legacyRun.id);
    expect(upgraded).toMatchObject({
      recordVersion: 2,
      reportFolder: 'upgrade-query-12345678',
      downloadFolder: 'deep-research/upgrade-query-12345678',
      providerRuns: {
        chatgpt: {
          saveReceipt: {
            destination: 'downloads', savedAt: 22, downloadId: 4,
            requestedRelativePath: 'deep-research/2026-01-01_1200_upgrade-query_12345678abcd/chatgpt.md',
          },
        },
        gemini: {
          saveReceipt: {
            requestedRelativePath: 'deep-research/2026-01-01_1200_upgrade-query_12345678abcd/gemini.md',
          },
        },
      },
    });
    expect(upgraded?.providerRuns.chatgpt?.downloadedAt).toBeUndefined();
    expect(await database.getRun('malformed-v1')).toBeUndefined();
    expect((await database.getRun(alreadyMigratedRun.id))?.providerRuns.grok?.saveReceipt?.requestedRelativePath)
      .toBe('deep-research/2025-12-01_0900_earlier-migration/grok.md');
    expect((await database.listRuns()).map((run) => run.id)).toEqual([alreadyMigratedRun.id, legacyRun.id]);
    expect((await database.listRuns()).map((run) => run.id)).toEqual([alreadyMigratedRun.id, legacyRun.id]);
    expect(warning).toHaveBeenCalledTimes(1);

    const raw = await openDB('deep-research-fan-out', 2);
    expect(await raw.get('runs', 'malformed-v1')).toEqual(malformedRun);
    expect((await raw.get('runs', legacyRun.id))?.recordVersion).toBeUndefined();
    const newer = await raw.get('runs', legacyRun.id);
    newer!.status = 'finalizing';
    await raw.put('runs', newer!);
    await Promise.all([database.getRun(legacyRun.id), database.listRuns()]);
    expect((await raw.get('runs', legacyRun.id))?.status).toBe('finalizing');
    expect((await raw.get('runs', legacyRun.id))?.recordVersion).toBeUndefined();
    raw.close();
    expect(await database.getReportDirectoryConfig()).toBeUndefined();
  });

});
