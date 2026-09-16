// @vitest-environment node
import 'fake-indexeddb/auto';
import { deleteDB, openDB } from 'idb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportDirectoryConfig } from '../src/types';

describe('research database v3 upgrade', () => {
  beforeEach(async () => {
    vi.resetModules();
    await deleteDB('deep-research-fan-out');
  });

  it('clears prerelease research data while preserving the report-directory configuration', async () => {
    const versionTwo = await openDB('deep-research-fan-out', 2, {
      upgrade(database) {
        const runs = database.createObjectStore('runs', { keyPath: 'id' });
        runs.createIndex('by-created', 'createdAt');
        runs.createIndex('by-status', 'status');
        const jobs = database.createObjectStore('jobs', { keyPath: 'id' });
        jobs.createIndex('by-created', 'createdAt');
        jobs.createIndex('by-state', 'state');
        database.createObjectStore('captures');
        database.createObjectStore('redirects', { keyPath: 'wrapper' });
        database.createObjectStore('configuration');
      },
    });
    const config: ReportDirectoryConfig = {
      handle: { name: 'Research' } as unknown as FileSystemDirectoryHandle,
      displayName: 'Research', configuredAt: 42, needsReconnect: false,
    };
    await versionTwo.put('runs', { id: 'old-run', createdAt: 1, status: 'complete' });
    await versionTwo.put('jobs', { id: 'old-run:chatgpt', createdAt: 1, state: 'queued' });
    await versionTwo.put('captures', { rawMarkdown: 'old' }, 'old-run:chatgpt');
    await versionTwo.put('redirects', { wrapper: 'https://old.test', canonical: 'https://new.test', resolvedAt: 1 });
    await versionTwo.put('configuration', config, 'report-directory');
    versionTwo.close();

    const database = await import('../src/db');
    expect(await database.listRuns()).toEqual([]);
    expect(await database.getJob('old-run:chatgpt')).toBeUndefined();
    expect(await database.getCapture('old-run:chatgpt')).toBeUndefined();
    expect(await database.getRedirect('https://old.test')).toBeUndefined();
    expect(await database.getReportDirectoryConfig()).toEqual(config);

    const raw = await openDB('deep-research-fan-out', 3);
    expect(Array.from(raw.objectStoreNames)).toEqual([
      'captures', 'configuration', 'jobs', 'redirects', 'runs',
    ]);
    expect(await raw.count('runs')).toBe(0);
    expect(await raw.count('jobs')).toBe(0);
    expect(await raw.count('captures')).toBe(0);
    expect(await raw.count('redirects')).toBe(0);
    raw.close();
  });
});
