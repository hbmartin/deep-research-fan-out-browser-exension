// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { captureId, deleteReportDirectoryConfig, evictHistory, getCapture, getRedirect, getReportDirectoryConfig, getRun, listRuns, putCapture, putRedirect, putReportDirectoryConfig, putRun, REDIRECT_RETENTION_MS } from '../src/db';
import type { Capture, Run } from '../src/types';

const capture: Capture = {
  rawMarkdown: 'report', normalizedMarkdown: 'report', citations: [], captureMethod: 'dom_only',
  unplacedCitationCount: 0, capturedAt: 1, urlsResolved: 0, urlsUnresolved: 0,
};

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

  it('retains the newest twenty completed runs and removes their captures atomically', async () => {
    await evictHistory(20);
    const runs = await listRuns();
    expect(runs).toHaveLength(20);
    expect(runs[0]?.id).toBe('run-21');
    expect(runs.at(-1)?.id).toBe('run-02');
    expect(await getCapture(captureId('run-00', 'chatgpt'))).toBeUndefined();
    expect(await getCapture(captureId('run-02', 'chatgpt'))).toBeDefined();
  });

  it('evicts redirects outside the retention window', async () => {
    await putRedirect('https://wrapper.test/old', 'https://canonical.test/old', Date.now() - REDIRECT_RETENTION_MS - 1);
    await putRedirect('https://wrapper.test/current', 'https://canonical.test/current');

    await evictHistory(20);
    expect(await getRedirect('https://wrapper.test/old')).toBeUndefined();
    expect(await getRedirect('https://wrapper.test/current')).toBe('https://canonical.test/current');
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
