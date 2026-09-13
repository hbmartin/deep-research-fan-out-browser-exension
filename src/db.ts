import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Capture, CaptureJob, ProviderId, Run, RunId } from './types';

interface ResearchDb extends DBSchema {
  runs: { key: string; value: Run; indexes: { 'by-created': number; 'by-status': string } };
  captures: { key: string; value: Capture };
  jobs: { key: string; value: CaptureJob; indexes: { 'by-created': number; 'by-state': string } };
  redirects: { key: string; value: { wrapper: string; canonical: string; resolvedAt: number } };
}

let databasePromise: Promise<IDBPDatabase<ResearchDb>> | undefined;

export const MAX_CAPTURE_ATTEMPTS = 3;
export const REDIRECT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
export async function getJob(id: string): Promise<CaptureJob | undefined> { return (await db()).get('jobs', id); }
export async function deleteJob(id: string): Promise<void> { await (await db()).delete('jobs', id); }

/** Caller holds the run lock. Validation and both writes share one commit. */
export async function acceptCaptureJob(job: CaptureJob, validate: (run: Run | undefined) => Run): Promise<Run> {
  const transaction = (await db()).transaction(['runs', 'jobs'], 'readwrite');
  try {
    const run = validate(await transaction.objectStore('runs').get(job.runId));
    const existing = await transaction.objectStore('jobs').get(job.id);
    if (!existing) await transaction.objectStore('jobs').put(job);
    await transaction.objectStore('runs').put(run);
    await transaction.done;
    return run;
  } catch (error) {
    try { transaction.abort(); } catch { /* The transaction may already have aborted. */ }
    await transaction.done.catch(() => undefined);
    throw error;
  }
}
export async function nextCaptureJob(): Promise<CaptureJob | undefined> {
  const database = await db();
  const jobs = (await database.getAllFromIndex('jobs', 'by-created')).sort((a, b) => a.createdAt - b.createdAt);
  return jobs.find((job) => job.state === 'queued' || (job.leasedAt && Date.now() - job.leasedAt > 60_000));
}
export async function getRedirect(wrapper: string): Promise<string | undefined> { return (await db()).get('redirects', wrapper).then((item) => item?.canonical); }
export async function putRedirect(wrapper: string, canonical: string, resolvedAt = Date.now()): Promise<void> {
  await (await db()).put('redirects', { wrapper, canonical, resolvedAt });
}

export async function evictHistory(limit = 20): Promise<void> {
  const database = await db();
  const completed = (await database.getAllFromIndex('runs', 'by-created')).filter((run) => run.status === 'complete');
  const evicted = completed.slice(0, Math.max(0, completed.length - limit));
  const expiredRedirects = (await database.getAll('redirects'))
    .filter((redirect) => Date.now() - redirect.resolvedAt > REDIRECT_RETENTION_MS);
  if (!evicted.length && !expiredRedirects.length) return;
  const transaction = database.transaction(['runs', 'captures', 'redirects'], 'readwrite');
  for (const run of evicted) {
    await transaction.objectStore('runs').delete(run.id);
    for (const providerRun of Object.values(run.providerRuns)) {
      if (providerRun.captureId) await transaction.objectStore('captures').delete(providerRun.captureId);
    }
  }
  for (const redirect of expiredRedirects) await transaction.objectStore('redirects').delete(redirect.wrapper);
  await transaction.done;
}

export function captureId(runId: RunId, provider: ProviderId): string { return `${runId}:${provider}`; }
