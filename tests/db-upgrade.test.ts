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

  it('creates local configuration storage and migrates v1 download receipts during upgrade', async () => {
    const legacyRun = {
      id: '12345678-abcd', query: 'Upgrade query', createdAt: 1, windowId: 1, status: 'complete', slug: 'upgrade-query',
      downloadFolder: 'deep-research/2026-01-01_1200_upgrade-query_12345678abcd',
      providerRuns: {
        chatgpt: {
          provider: 'chatgpt', tabId: 1, status: 'complete', submittedQuery: 'Upgrade query', appendString: '', attempts: 0,
          degraded: false, adapterVersion: 'test', captureId: 'legacy:capture', downloadedAt: 22, downloadId: 4,
        },
      },
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
    versionOne.close();

    const database = await import('../src/db');
    const upgraded = await database.getRun(legacyRun.id);
    expect(upgraded).toMatchObject({
      reportFolder: 'upgrade-query-12345678',
      downloadFolder: 'deep-research/upgrade-query-12345678',
      providerRuns: { chatgpt: { saveReceipt: { destination: 'downloads', savedAt: 22, downloadId: 4 } } },
    });
    expect(upgraded?.providerRuns.chatgpt?.downloadedAt).toBeUndefined();
    expect(await database.getReportDirectoryConfig()).toBeUndefined();
  });
});
