import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { createReportFolder, slugify } from './state';
import { PROVIDERS, type Capture, type CaptureJob, type ProviderId, type ProviderRun, type ReportDirectoryConfig, type Run, type RunId } from './types';

interface ResearchDb extends DBSchema {
  runs: { key: string; value: Run; indexes: { 'by-created': number; 'by-status': string } };
  captures: { key: string; value: Capture };
  jobs: { key: string; value: CaptureJob; indexes: { 'by-created': number; 'by-state': string } };
  redirects: { key: string; value: { wrapper: string; canonical: string; resolvedAt: number } };
  configuration: { key: string; value: ReportDirectoryConfig };
}

let databasePromise: Promise<IDBPDatabase<ResearchDb>> | undefined;

export const MAX_CAPTURE_ATTEMPTS = 3;
export const REDIRECT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const REPORT_DIRECTORY_KEY = 'report-directory';
const invalidRunWarnings = new Set<string>();
const PROVIDER_STATUSES = new Set([
  'pending', 'opening', 'awaiting_ready', 'setting_mode', 'submitting', 'researching',
  'awaiting_user', 'capturing', 'complete', 'manual_required', 'unauthenticated',
  'quota_exhausted', 'interrupted', 'abandoned', 'failed',
]);
const RUN_STATUSES = new Set(['active', 'needs_attention', 'finalizing', 'complete']);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function optionalNumber(value: unknown): value is number | undefined {
  return value === undefined || finiteNumber(value);
}

function validSaveReceipt(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value)
    || !['directory', 'downloads'].includes(String(value.destination))
    || typeof value.requestedRelativePath !== 'string'
    || !finiteNumber(value.savedAt)
    || !optionalString(value.actualRelativePath)
    || !optionalNumber(value.downloadId)
    || !optionalString(value.artifactRevision)) return false;
  return value.fallbackReason === undefined
    || ['permission_required', 'directory_unavailable', 'write_failed'].includes(String(value.fallbackReason));
}

function validProviderRun(value: unknown, provider: ProviderId): value is ProviderRun {
  if (!record(value)) return false;
  return value.provider === provider
    && finiteNumber(value.tabId)
    && typeof value.status === 'string' && PROVIDER_STATUSES.has(value.status)
    && typeof value.submittedQuery === 'string'
    && typeof value.appendString === 'string'
    && finiteNumber(value.attempts)
    && typeof value.degraded === 'boolean'
    && typeof value.adapterVersion === 'string'
    && optionalString(value.statusDetail)
    && optionalString(value.conversationKey)
    && optionalString(value.captureId)
    && optionalString(value.artifactRevision)
    && optionalNumber(value.startedAt)
    && optionalNumber(value.submittedAt)
    && optionalNumber(value.researchTimedOutAt)
    && optionalNumber(value.completedAt)
    && optionalNumber(value.downloadId)
    && optionalNumber(value.downloadedAt)
    && optionalNumber(value.copiedAt)
    && optionalNumber(value.reconcileFailureCount)
    && optionalNumber(value.detachedAt)
    && validSaveReceipt(value.saveReceipt);
}

function normalizeRunRecord(value: unknown): { run?: Run; changed: boolean } {
  if (!record(value)
    || typeof value.id !== 'string' || !value.id
    || typeof value.query !== 'string'
    || !finiteNumber(value.createdAt)
    || !finiteNumber(value.windowId)
    || typeof value.status !== 'string' || !RUN_STATUSES.has(value.status)
    || !record(value.providerRuns)
    || !optionalString(value.browserSessionId)
    || !optionalNumber(value.completedAt)
    || !optionalNumber(value.tabGroupId)
    || (value.recordVersion !== undefined && value.recordVersion !== 2)
    || !optionalString(value.slug)
    || !optionalString(value.reportFolder)
    || !optionalString(value.downloadFolder)) return { changed: false };
  for (const [provider, providerRun] of Object.entries(value.providerRuns)) {
    if (!PROVIDERS.includes(provider as ProviderId) || !validProviderRun(providerRun, provider as ProviderId)) {
      return { changed: false };
    }
  }
  const run = value as unknown as Run;
  let changed = false;
  const legacyDownloadFolder = typeof run.downloadFolder === 'string' ? run.downloadFolder : 'deep-research';
  const slug = typeof run.slug === 'string' && run.slug ? run.slug : slugify(run.query);
  if (run.slug !== slug) {
    run.slug = slug;
    changed = true;
  }
  const reportFolder = typeof run.reportFolder === 'string' && run.reportFolder
    ? run.reportFolder
    : createReportFolder(slug, run.id);
  if (run.reportFolder !== reportFolder) {
    run.reportFolder = reportFolder;
    changed = true;
  }
  const downloadRoot = legacyDownloadFolder?.split('/').filter(Boolean)[0] || 'deep-research';
  const downloadFolder = `${downloadRoot}/${reportFolder}`;
  if (run.downloadFolder !== downloadFolder) {
    run.downloadFolder = downloadFolder;
    changed = true;
  }
  for (const providerRun of Object.values(run.providerRuns)) {
    if (!providerRun.saveReceipt && providerRun.downloadedAt !== undefined) {
      // v1 always used the provider filename, including failed runs.
      const filename = `${providerRun.provider}.md`;
      const relativePath = `${legacyDownloadFolder}/${filename}`;
      providerRun.saveReceipt = {
        destination: 'downloads',
        requestedRelativePath: relativePath,
        savedAt: providerRun.downloadedAt,
        downloadId: providerRun.downloadId,
      };
      changed = true;
    }
    const receipt = providerRun.saveReceipt;
    if (receipt?.destination === 'downloads'
      && !receipt.requestedRelativePath.startsWith(`${downloadFolder}/`)
      && receipt.requestedRelativePath.endsWith(`/FAILED-${providerRun.provider}.md`)
    ) {
      receipt.requestedRelativePath = receipt.requestedRelativePath.replace(
        `/FAILED-${providerRun.provider}.md`, `/${providerRun.provider}.md`,
      );
      changed = true;
    }
    if (providerRun.downloadedAt !== undefined || providerRun.downloadId !== undefined) {
      delete providerRun.downloadedAt;
      delete providerRun.downloadId;
      changed = true;
    }
  }
  if (run.recordVersion !== 2) {
    run.recordVersion = 2;
    changed = true;
  }
  return { run, changed };
}

function warnInvalidRun(value: unknown): void {
  const id = record(value) && typeof value.id === 'string' ? value.id : '(unknown)';
  if (invalidRunWarnings.has(id)) return;
  invalidRunWarnings.add(id);
  console.warn(`Ignoring malformed research run ${id}; the stored record was left untouched.`);
}

function legacyCaptureRevision(capture: Capture): string {
  const input = `${capture.capturedAt}\u0000${capture.rawMarkdown}\u0000${capture.normalizedMarkdown}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `legacy-${capture.capturedAt}-${(hash >>> 0).toString(36)}`;
}

function captureContentSignature(capture: Capture): string {
  const { revision: _revision, ...content } = capture;
  return JSON.stringify(content);
}

function db(): Promise<IDBPDatabase<ResearchDb>> {
  if (databasePromise) return databasePromise;
  const opening = openDB<ResearchDb>('deep-research-fan-out', 2, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        const runs = database.createObjectStore('runs', { keyPath: 'id' });
        runs.createIndex('by-created', 'createdAt');
        runs.createIndex('by-status', 'status');
        const jobs = database.createObjectStore('jobs', { keyPath: 'id' });
        jobs.createIndex('by-created', 'createdAt');
        jobs.createIndex('by-state', 'state');
        database.createObjectStore('captures');
        database.createObjectStore('redirects', { keyPath: 'wrapper' });
      }
      if (oldVersion < 2) {
        database.createObjectStore('configuration');
      }
    },
  });
  let guarded: Promise<IDBPDatabase<ResearchDb>>;
  guarded = opening.catch((error) => {
    if (databasePromise === guarded) databasePromise = undefined;
    throw error;
  });
  databasePromise = guarded;
  return guarded;
}

export async function putRun(run: Run): Promise<void> {
  const normalized = normalizeRunRecord(run);
  if (!normalized.run) throw new Error('Cannot persist a malformed research run.');
  await (await db()).put('runs', normalized.run);
}
export async function getRun(id: RunId): Promise<Run | undefined> {
  const database = await db();
  const stored = await database.get('runs', id);
  if (!stored) return undefined;
  const normalized = normalizeRunRecord(stored);
  if (!normalized.run) {
    warnInvalidRun(stored);
    return undefined;
  }
  if (normalized.changed) await database.put('runs', normalized.run);
  return normalized.run;
}
export async function listRuns(): Promise<Run[]> {
  const database = await db();
  const storedRuns = await database.getAllFromIndex('runs', 'by-created');
  const runs: Run[] = [];
  const migrated: Run[] = [];
  for (const stored of storedRuns) {
    const normalized = normalizeRunRecord(stored);
    if (!normalized.run) {
      warnInvalidRun(stored);
      continue;
    }
    runs.push(normalized.run);
    if (normalized.changed) migrated.push(normalized.run);
  }
  if (migrated.length) {
    const transaction = database.transaction('runs', 'readwrite');
    for (const run of migrated) await transaction.store.put(run);
    await transaction.done;
  }
  return runs.sort((a, b) => b.createdAt - a.createdAt);
}
export async function putCapture(id: string, capture: Capture): Promise<void> {
  const database = await db();
  const existing = await database.get('captures', id);
  capture.revision = existing && captureContentSignature(existing) === captureContentSignature(capture)
    ? existing.revision ?? legacyCaptureRevision(existing)
    : crypto.randomUUID();
  await database.put('captures', capture, id);
}
export async function getCapture(id?: string): Promise<Capture | undefined> {
  if (!id) return undefined;
  const database = await db();
  const capture = await database.get('captures', id);
  if (capture && !capture.revision) {
    capture.revision = legacyCaptureRevision(capture);
    await database.put('captures', capture, id);
  }
  return capture;
}
export async function putJob(job: CaptureJob): Promise<void> { await (await db()).put('jobs', job); }
export async function getJob(id: string): Promise<CaptureJob | undefined> { return (await db()).get('jobs', id); }
export async function deleteJob(id: string): Promise<void> { await (await db()).delete('jobs', id); }

/** Caller holds the run lock. Validation and both writes share one commit. */
export async function acceptCaptureJob(job: CaptureJob, validate: (run: Run | undefined) => Run): Promise<Run> {
  const transaction = (await db()).transaction(['runs', 'jobs'], 'readwrite');
  try {
    const stored = await transaction.objectStore('runs').get(job.runId);
    const normalized = stored ? normalizeRunRecord(stored) : { run: undefined, changed: false };
    if (stored && !normalized.run) warnInvalidRun(stored);
    const run = validate(normalized.run);
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
  return jobs.find((job) => !job.deferredForNavigation
    && (job.state === 'queued' || (job.leasedAt && Date.now() - job.leasedAt > 60_000)));
}
export async function getRedirect(wrapper: string): Promise<string | undefined> { return (await db()).get('redirects', wrapper).then((item) => item?.canonical); }
export async function putRedirect(wrapper: string, canonical: string, resolvedAt = Date.now()): Promise<void> {
  await (await db()).put('redirects', { wrapper, canonical, resolvedAt });
}

export async function getReportDirectoryConfig(): Promise<ReportDirectoryConfig | undefined> {
  return (await db()).get('configuration', REPORT_DIRECTORY_KEY);
}

export async function putReportDirectoryConfig(config: ReportDirectoryConfig): Promise<void> {
  await (await db()).put('configuration', config, REPORT_DIRECTORY_KEY);
}

export async function deleteReportDirectoryConfig(): Promise<void> {
  await (await db()).delete('configuration', REPORT_DIRECTORY_KEY);
}

export async function evictHistory(limit = 20): Promise<void> {
  const database = await db();
  const completed = (await database.getAllFromIndex('runs', 'by-created')).flatMap((stored) => {
    const normalized = normalizeRunRecord(stored);
    if (!normalized.run) {
      warnInvalidRun(stored);
      return [];
    }
    return normalized.run.status === 'complete' ? [normalized.run] : [];
  });
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
