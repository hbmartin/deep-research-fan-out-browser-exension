import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Capture, CaptureJob, ProviderId, Run, RunId } from './types';

interface ResearchDb extends DBSchema {
  runs: { key: string; value: Run; indexes: { 'by-created': number; 'by-status': string } };
  captures: { key: string; value: Capture };
  jobs: { key: string; value: CaptureJob; indexes: { 'by-created': number; 'by-state': string } };
  redirects: { key: string; value: { wrapper: string; canonical: string; resolvedAt: number } };
}

let databasePromise: Promise<IDBPDatabase<ResearchDb>> | undefined;

function db(): Promise<IDBPDatabase<ResearchDb>> {
  databasePromise ??= openDB<ResearchDb>('deep-research-fan-out', 1, {
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
  return databasePromise;
}

export async function putRun(run: Run): Promise<void> { await (await db()).put('runs', run); }
export async function getRun(id: RunId): Promise<Run | undefined> { return (await db()).get('runs', id); }
export async function listRuns(): Promise<Run[]> {
  return (await (await db()).getAllFromIndex('runs', 'by-created')).sort((a, b) => b.createdAt - a.createdAt);
}
export async function putCapture(id: string, capture: Capture): Promise<void> { await (await db()).put('captures', capture, id); }
export async function getCapture(id?: string): Promise<Capture | undefined> { return id ? (await db()).get('captures', id) : undefined; }
export async function putJob(job: CaptureJob): Promise<void> { await (await db()).put('jobs', job); }
export async function deleteJob(id: string): Promise<void> { await (await db()).delete('jobs', id); }
export async function nextCaptureJob(): Promise<CaptureJob | undefined> {
  const database = await db();
  const jobs = (await database.getAllFromIndex('jobs', 'by-created')).sort((a, b) => a.createdAt - b.createdAt);
  return jobs.find((job) => job.state === 'queued' || (job.leasedAt && Date.now() - job.leasedAt > 60_000));
}
export async function getRedirect(wrapper: string): Promise<string | undefined> { return (await db()).get('redirects', wrapper).then((item) => item?.canonical); }
export async function putRedirect(wrapper: string, canonical: string): Promise<void> { await (await db()).put('redirects', { wrapper, canonical, resolvedAt: Date.now() }); }

export async function evictHistory(limit = 20): Promise<void> {
  const database = await db();
  const completed = (await database.getAllFromIndex('runs', 'by-created')).filter((run) => run.status === 'complete');
  if (completed.length <= limit) return;
  const evicted = completed.slice(0, completed.length - limit);
  const transaction = database.transaction(['runs', 'captures'], 'readwrite');
  for (const run of evicted) {
    await transaction.objectStore('runs').delete(run.id);
    for (const providerRun of Object.values(run.providerRuns)) {
      if (providerRun.captureId) await transaction.objectStore('captures').delete(providerRun.captureId);
    }
  }
  await transaction.done;
}

export function captureId(runId: RunId, provider: ProviderId): string { return `${runId}:${provider}`; }
