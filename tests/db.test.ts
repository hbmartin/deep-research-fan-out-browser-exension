// @vitest-environment node
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { captureId, evictHistory, getCapture, listRuns, putCapture, putRun } from '../src/db';
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
        downloadFolder: `deep-research/${id}`,
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
});
