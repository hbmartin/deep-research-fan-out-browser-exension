import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { NAVIGATION_DEFERRAL_MS } from './durations';
import { deriveRunStatus } from './state';
import { PROVIDERS, isTerminalProviderStatus, type Capture, type CaptureJob, type ProviderId, type ProviderRun, type ReportDirectoryConfig, type Run, type RunId } from './types';

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
export const ORPHAN_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const CAPTURE_STORAGE_FAILURE_DETAIL = 'A verified DOM report was retained, but capture storage failed. Use Retry report from history.';
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
    && optionalNumber(value.copiedAt)
    && optionalNumber(value.reconcileFailureCount)
    && optionalNumber(value.detachedAt)
    && (value.detachedSetupStatus === undefined || ['opening', 'awaiting_ready', 'setting_mode'].includes(String(value.detachedSetupStatus)))
    && (value.captureRecoveryPending === undefined || typeof value.captureRecoveryPending === 'boolean')
    && (value.captureRecoveryInProgress === undefined || typeof value.captureRecoveryInProgress === 'boolean')
    && (value.captureReviewPending === undefined || typeof value.captureReviewPending === 'boolean')
    && validSaveReceipt(value.saveReceipt);
}

function validCaptureJobIdentity(value: unknown, expectedId?: string): value is Record<string, unknown> {
  if (!record(value)) return false;
  return typeof value.id === 'string' && Boolean(value.id)
    && (expectedId === undefined || value.id === expectedId)
    && typeof value.runId === 'string' && Boolean(value.runId)
    && PROVIDERS.includes(value.provider as ProviderId)
    && finiteNumber(value.tabId)
    && ['queued', 'leased', 'paused', 'orphaned'].includes(String(value.state))
    && finiteNumber(value.createdAt)
    && finiteNumber(value.attempts)
    && typeof value.domMarkdown === 'string'
    && optionalString(value.conversationKey);
}

function validCaptureJob(value: unknown): value is CaptureJob {
  if (!validCaptureJobIdentity(value)) return false;
  return Array.isArray(value.domCitations)
    && (value.state === 'leased' ? finiteNumber(value.leasedAt) : optionalNumber(value.leasedAt))
    && optionalString(value.leaseToken)
    && optionalNumber(value.orphanedAt)
    && optionalNumber(value.deferredAt)
    && optionalString(value.title)
    && (value.tabUnavailable === undefined || typeof value.tabUnavailable === 'boolean')
    && (value.deferredForNavigation === undefined || typeof value.deferredForNavigation === 'boolean')
    && (value.copyControlObserved === undefined || typeof value.copyControlObserved === 'boolean');
}

export interface CaptureJobInspection {
  exists: boolean;
  job?: CaptureJob;
  changed: boolean;
  retainedReport?: string;
}

function normalizeCaptureJobRecord(value: unknown, expectedId?: string): CaptureJobInspection {
  if (validCaptureJob(value) && (expectedId === undefined || value.id === expectedId)) {
    return { exists: true, job: value, changed: false };
  }
  if (!record(value)) return { exists: value !== undefined, changed: false };
  const retainedReport = typeof value.domMarkdown === 'string' && value.domMarkdown.trim()
    ? value.domMarkdown : undefined;
  if (!validCaptureJobIdentity(value, expectedId)) {
    return { exists: true, changed: false, retainedReport };
  }

  const repaired: Record<string, unknown> = { ...value };
  let changed = false;
  if (repaired.state === 'leased' && !finiteNumber(repaired.leasedAt)) {
    repaired.state = 'queued';
    delete repaired.leasedAt;
    changed = true;
  } else if (repaired.state !== 'leased' && !optionalNumber(repaired.leasedAt)) {
    delete repaired.leasedAt;
    changed = true;
  }
  for (const key of ['orphanedAt', 'deferredAt'] as const) {
    if (!optionalNumber(repaired[key])) {
      delete repaired[key];
      changed = true;
    }
  }
  if (!Array.isArray(repaired.domCitations)) {
    repaired.domCitations = [];
    changed = true;
  }
  if (!optionalString(repaired.title)) {
    delete repaired.title;
    changed = true;
  }
  for (const key of ['tabUnavailable', 'deferredForNavigation', 'copyControlObserved'] as const) {
    if (repaired[key] !== undefined && typeof repaired[key] !== 'boolean') {
      delete repaired[key];
      changed = true;
    }
  }
  return validCaptureJob(repaired)
    ? { exists: true, job: repaired, changed }
    : { exists: true, changed: false, retainedReport };
}

function validRunRecord(value: unknown): value is Run {
  if (!record(value)
    || value.recordVersion !== 2
    || typeof value.id !== 'string' || !value.id
    || typeof value.query !== 'string'
    || !finiteNumber(value.createdAt)
    || !finiteNumber(value.windowId)
    || typeof value.status !== 'string' || !RUN_STATUSES.has(value.status)
    || !record(value.providerRuns)
    || !optionalString(value.browserSessionId)
    || !optionalNumber(value.completedAt)
    || !optionalNumber(value.tabGroupId)
    || typeof value.slug !== 'string' || !value.slug
    || typeof value.reportFolder !== 'string' || !value.reportFolder
    || typeof value.downloadFolder !== 'string' || !value.downloadFolder) return false;
  for (const [provider, providerRun] of Object.entries(value.providerRuns)) {
    if (!PROVIDERS.includes(provider as ProviderId) || !validProviderRun(providerRun, provider as ProviderId)) {
      return false;
    }
  }
  return true;
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

function createRunStore(database: IDBPDatabase<ResearchDb>): void {
  const runs = database.createObjectStore('runs', { keyPath: 'id' });
  runs.createIndex('by-created', 'createdAt');
  runs.createIndex('by-status', 'status');
}

function createJobStore(database: IDBPDatabase<ResearchDb>): void {
  const jobs = database.createObjectStore('jobs', { keyPath: 'id' });
  jobs.createIndex('by-created', 'createdAt');
  jobs.createIndex('by-state', 'state');
}

function db(): Promise<IDBPDatabase<ResearchDb>> {
  if (databasePromise) return databasePromise;
  const opening = openDB<ResearchDb>('deep-research-fan-out', 3, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        createRunStore(database);
        createJobStore(database);
        database.createObjectStore('captures');
        database.createObjectStore('redirects', { keyPath: 'wrapper' });
      }
      if (oldVersion < 2) {
        database.createObjectStore('configuration');
      }
      if (oldVersion > 0 && oldVersion < 3) {
        // v3 intentionally resets disposable prerelease research data while
        // preserving the separately stored report-directory configuration.
        for (const name of ['runs', 'jobs', 'captures', 'redirects'] as const) database.deleteObjectStore(name);
        createRunStore(database);
        createJobStore(database);
        database.createObjectStore('captures');
        database.createObjectStore('redirects', { keyPath: 'wrapper' });
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
  if (!validRunRecord(run)) throw new Error('Cannot persist a malformed research run.');
  await (await db()).put('runs', run);
}
export async function getRun(id: RunId): Promise<Run | undefined> {
  const database = await db();
  const stored = await database.get('runs', id);
  if (!stored) return undefined;
  if (!validRunRecord(stored)) {
    warnInvalidRun(stored);
    return undefined;
  }
  return stored;
}
export async function listRuns(): Promise<Run[]> {
  const database = await db();
  const storedRuns = await database.getAllFromIndex('runs', 'by-created');
  const runs: Run[] = [];
  for (const stored of storedRuns) {
    if (!validRunRecord(stored)) {
      warnInvalidRun(stored);
      continue;
    }
    runs.push(stored);
  }
  return runs.sort((a, b) => b.createdAt - a.createdAt);
}
export async function putCapture(id: string, capture: Capture): Promise<void> {
  const database = await db();
  const transaction = database.transaction('captures', 'readwrite');
  const existing = await transaction.store.get(id);
  capture.revision = existing && captureContentSignature(existing) === captureContentSignature(capture)
    ? existing.revision ?? legacyCaptureRevision(existing)
    : crypto.randomUUID();
  await transaction.store.put(capture, id);
  await transaction.done;
}
export async function getCapture(id?: string): Promise<Capture | undefined> {
  if (!id) return undefined;
  const database = await db();
  const current = await database.get('captures', id);
  if (!current || current.revision) return current;
  const transaction = database.transaction('captures', 'readwrite');
  const capture = await transaction.store.get(id);
  if (capture && !capture.revision) {
    capture.revision = legacyCaptureRevision(capture);
    await transaction.store.put(capture, id);
  }
  await transaction.done;
  return capture;
}
export async function putJob(job: CaptureJob): Promise<void> {
  if (!validCaptureJob(job)) throw new Error('Cannot persist a malformed capture job.');
  await (await db()).put('jobs', job);
}
export async function inspectCaptureJob(id: string): Promise<CaptureJobInspection> {
  return normalizeCaptureJobRecord(await (await db()).get('jobs', id), id);
}
export async function getJob(id: string): Promise<CaptureJob | undefined> {
  return (await inspectCaptureJob(id)).job;
}
export async function deleteJob(id: string): Promise<void> { await (await db()).delete('jobs', id); }

export function isUsableCaptureJobReport(job: CaptureJob): boolean {
  const dom = job.domMarkdown.trim();
  return dom.length >= 40 || Boolean(job.copyControlObserved && dom);
}

export type CaptureRecoveryInspection =
  | { kind: 'missing_owner'; id: string }
  | { kind: 'saved_capture'; id: string; run: Run; capture: Capture }
  | { kind: 'usable_job'; id: string; run: Run; job: CaptureJob }
  | { kind: 'review_required'; id: string; run: Run; retainedReport: string }
  | { kind: 'unavailable'; id: string; run: Run; jobExists: boolean };

export type CaptureRecoveryNormalization = CaptureRecoveryInspection & {
  changed: boolean;
  resumeRecommended?: boolean;
};

export type CaptureRecoveryScheduleResult =
  | { outcome: 'scheduled'; run: Run }
  | { outcome: 'review_required'; run: Run }
  | { outcome: 'unavailable'; run: Run; resumeRecommended: boolean }
  | { outcome: 'missing_owner' };

export type DiscardBlockedCaptureResult =
  | { outcome: 'discarded'; run: Run; resumeRecommended: boolean }
  | { outcome: 'state_changed' };

export type CaptureCommitResult =
  | { outcome: 'committed'; run: Run; capture: Capture; completed: boolean }
  | { outcome: 'stale_lease' }
  | { outcome: 'missing_owner' }
  | { outcome: 'missing_capture' };

function classifyCaptureRecovery(
  id: string,
  stored: Run | undefined,
  provider: ProviderId,
  rawJob: unknown,
  capture: Capture | undefined,
): CaptureRecoveryInspection {
  const run = stored && validRunRecord(stored) ? stored : undefined;
  if (stored && !run) warnInvalidRun(stored);
  if (!run?.providerRuns[provider]) return { kind: 'missing_owner', id };
  if (capture) return { kind: 'saved_capture', id, run, capture };
  const inspection = normalizeCaptureJobRecord(rawJob, id);
  if (inspection.job && isUsableCaptureJobReport(inspection.job)) {
    return { kind: 'usable_job', id, run, job: inspection.job };
  }
  if (inspection.retainedReport) {
    return { kind: 'review_required', id, run, retainedReport: inspection.retainedReport };
  }
  return { kind: 'unavailable', id, run, jobExists: inspection.exists };
}

export async function inspectCaptureRecovery(
  id: string,
  runId: RunId,
  provider: ProviderId,
): Promise<CaptureRecoveryInspection> {
  const transaction = (await db()).transaction(['runs', 'jobs', 'captures'], 'readonly');
  const [stored, rawJob, capture] = await Promise.all([
    transaction.objectStore('runs').get(runId),
    transaction.objectStore('jobs').get(id),
    transaction.objectStore('captures').get(id),
  ]);
  await transaction.done;
  return classifyCaptureRecovery(id, stored, provider, rawJob, capture);
}

export class CaptureJobReviewRequiredError extends Error {
  constructor() {
    super('A retained report needs review before another capture can be accepted.');
    this.name = 'CaptureJobReviewRequiredError';
  }
}

/** Caller holds the run lock. Validation and both writes share one commit. */
export async function acceptCaptureJob(job: CaptureJob, validate: (run: Run | undefined) => Run): Promise<Run> {
  const transaction = (await db()).transaction(['runs', 'jobs'], 'readwrite');
  let reviewRequired = false;
  let acceptedRun: Run | undefined;
  try {
    const stored = await transaction.objectStore('runs').get(job.runId);
    const currentRun = stored && validRunRecord(stored) ? stored : undefined;
    if (stored && !currentRun) warnInvalidRun(stored);
    if (!validCaptureJob(job)) throw new Error('Cannot persist a malformed capture job.');
    const existing = await transaction.objectStore('jobs').get(job.id);
    const inspection = normalizeCaptureJobRecord(existing, job.id);
    reviewRequired = Boolean(existing && !inspection.job && inspection.retainedReport);
    const validated = validate(reviewRequired && currentRun ? structuredClone(currentRun) : currentRun);
    if (!validRunRecord(validated)) throw new Error('Cannot persist a malformed research run.');

    let runToStore = validated;
    let jobToStore: CaptureJob | undefined;
    if (reviewRequired) {
      const providerRun = currentRun?.providerRuns[job.provider];
      if (!currentRun || !providerRun) throw new Error('Run not found for retained capture review.');
      providerRun.captureReviewPending = true;
      providerRun.captureRecoveryPending = undefined;
      providerRun.captureRecoveryInProgress = undefined;
      runToStore = currentRun;
    } else if (!inspection.job) {
      jobToStore = job;
    } else if (inspection.changed) {
      jobToStore = inspection.job;
    }
    if (jobToStore) await transaction.objectStore('jobs').put(jobToStore);
    await transaction.objectStore('runs').put(runToStore);
    acceptedRun = runToStore;
    await transaction.done;
  } catch (error) {
    try { transaction.abort(); } catch { /* The transaction may already have aborted. */ }
    await transaction.done.catch(() => undefined);
    throw error;
  }
  if (reviewRequired) throw new CaptureJobReviewRequiredError();
  return acceptedRun!;
}

export async function discardBlockedCaptureJob(
  id: string,
  runId: RunId,
  provider: ProviderId,
): Promise<DiscardBlockedCaptureResult> {
  const transaction = (await db()).transaction(['runs', 'jobs', 'captures'], 'readwrite');
  try {
    const [rawJob, capture, stored] = await Promise.all([
      transaction.objectStore('jobs').get(id),
      transaction.objectStore('captures').get(id),
      transaction.objectStore('runs').get(runId),
    ]);
    const recovery = classifyCaptureRecovery(id, stored, provider, rawJob, capture);
    if (recovery.kind !== 'review_required') {
      await transaction.done;
      return { outcome: 'state_changed' };
    }
    const run = recovery.run;
    const providerRun = run.providerRuns[provider]!;
    const resumeRecommended = providerRun.status === 'failed'
      && providerRun.statusDetail === CAPTURE_STORAGE_FAILURE_DETAIL
      && Boolean(providerRun.captureReviewPending || providerRun.captureRecoveryPending
        || providerRun.captureRecoveryInProgress);
    providerRun.captureReviewPending = undefined;
    providerRun.captureRecoveryPending = undefined;
    providerRun.captureRecoveryInProgress = undefined;
    if (providerRun.status === 'failed') {
      providerRun.statusDetail = 'The blocked retained report was discarded. Save again can save the failed run details.';
    }
    await transaction.objectStore('jobs').delete(id);
    await transaction.objectStore('runs').put(run);
    await transaction.done;
    return { outcome: 'discarded', run, resumeRecommended };
  } catch (error) {
    try { transaction.abort(); } catch { /* The transaction may already have aborted. */ }
    await transaction.done.catch(() => undefined);
    throw error;
  }
}

/** Rechecks recovery state and writes only the normalization selected by the caller. */
export async function normalizeCaptureRecovery(
  id: string,
  runId: RunId,
  provider: ProviderId,
): Promise<CaptureRecoveryNormalization> {
  const transaction = (await db()).transaction(['runs', 'jobs', 'captures'], 'readwrite');
  try {
    const [rawJob, capture, stored] = await Promise.all([
      transaction.objectStore('jobs').get(id),
      transaction.objectStore('captures').get(id),
      transaction.objectStore('runs').get(runId),
    ]);
    const recovery = classifyCaptureRecovery(id, stored, provider, rawJob, capture);
    if (recovery.kind === 'missing_owner' || recovery.kind === 'saved_capture') {
      await transaction.done;
      return { ...recovery, changed: false };
    }
    const run = recovery.run;
    const providerRun = run.providerRuns[provider]!;
    const before = JSON.stringify(run);
    let resumeRecommended = false;
    let jobToStore: CaptureJob | undefined;
    let deleteStoredJob = false;
    if (recovery.kind === 'usable_job') {
      const job = recovery.job;
      providerRun.captureReviewPending = undefined;
      if (job.state === 'paused') {
        providerRun.captureRecoveryInProgress = undefined;
        providerRun.captureRecoveryPending = true;
        if (!isTerminalProviderStatus(providerRun.status)) {
          providerRun.status = 'failed';
          providerRun.statusDetail = CAPTURE_STORAGE_FAILURE_DETAIL;
          providerRun.completedAt ??= Date.now();
          run.status = deriveRunStatus(run);
        }
      } else if (providerRun.captureRecoveryPending && !providerRun.captureRecoveryInProgress
        && isTerminalProviderStatus(providerRun.status)) {
        job.state = 'paused';
        job.leasedAt = undefined;
        job.leaseToken = undefined;
        jobToStore = job;
      } else if (!providerRun.captureRecoveryInProgress) {
        providerRun.captureRecoveryPending = undefined;
      }
    } else if (recovery.kind === 'review_required') {
      providerRun.captureReviewPending = true;
      providerRun.captureRecoveryPending = undefined;
      providerRun.captureRecoveryInProgress = undefined;
    } else {
      resumeRecommended = providerRun.status === 'failed'
        && providerRun.statusDetail === CAPTURE_STORAGE_FAILURE_DETAIL
        && Boolean(providerRun.captureReviewPending || providerRun.captureRecoveryPending
          || providerRun.captureRecoveryInProgress);
      providerRun.captureReviewPending = undefined;
      providerRun.captureRecoveryPending = undefined;
      providerRun.captureRecoveryInProgress = undefined;
      if (providerRun.status === 'failed') {
        providerRun.statusDetail = 'No retained report is available for retry. Save again can save the failed run details.';
      }
      deleteStoredJob = recovery.jobExists;
    }
    const runChanged = JSON.stringify(run) !== before;
    if (jobToStore) await transaction.objectStore('jobs').put(jobToStore);
    if (deleteStoredJob) await transaction.objectStore('jobs').delete(id);
    if (runChanged) await transaction.objectStore('runs').put(run);
    await transaction.done;
    const normalized = recovery.kind === 'usable_job' && jobToStore
      ? { ...recovery, job: jobToStore }
      : recovery;
    return {
      ...normalized,
      changed: runChanged || Boolean(jobToStore) || deleteStoredJob,
      ...(resumeRecommended ? { resumeRecommended } : {}),
    };
  } catch (error) {
    try { transaction.abort(); } catch { /* The transaction may already have aborted. */ }
    await transaction.done.catch(() => undefined);
    throw error;
  }
}

/** Durably accepts a user retry without waiting for capture processing. */
export async function scheduleCaptureRecovery(
  id: string,
  runId: RunId,
  provider: ProviderId,
): Promise<CaptureRecoveryScheduleResult> {
  const transaction = (await db()).transaction(['runs', 'jobs', 'captures'], 'readwrite');
  try {
    const [rawJob, capture, stored] = await Promise.all([
      transaction.objectStore('jobs').get(id),
      transaction.objectStore('captures').get(id),
      transaction.objectStore('runs').get(runId),
    ]);
    const recovery = classifyCaptureRecovery(id, stored, provider, rawJob, capture);
    if (recovery.kind === 'missing_owner') {
      const inspection = normalizeCaptureJobRecord(rawJob, id);
      if (inspection.job) {
        inspection.job.state = 'orphaned';
        inspection.job.orphanedAt ??= Date.now();
        inspection.job.leasedAt = undefined;
        inspection.job.leaseToken = undefined;
        await transaction.objectStore('jobs').put(inspection.job);
      }
      await transaction.done;
      return { outcome: 'missing_owner' };
    }
    const run = recovery.run;
    const providerRun = run.providerRuns[provider]!;
    if (recovery.kind === 'saved_capture') {
      providerRun.captureReviewPending = undefined;
      providerRun.captureRecoveryPending = undefined;
      providerRun.captureRecoveryInProgress = true;
      await transaction.objectStore('runs').put(run);
      await transaction.done;
      return { outcome: 'scheduled', run };
    }
    if (recovery.kind === 'review_required') {
      providerRun.captureReviewPending = true;
      providerRun.captureRecoveryPending = undefined;
      providerRun.captureRecoveryInProgress = undefined;
      await transaction.objectStore('runs').put(run);
      await transaction.done;
      return { outcome: 'review_required', run };
    }
    if (recovery.kind === 'unavailable') {
      const resumeRecommended = providerRun.status === 'failed'
        && providerRun.statusDetail === CAPTURE_STORAGE_FAILURE_DETAIL
        && Boolean(providerRun.captureReviewPending || providerRun.captureRecoveryPending
          || providerRun.captureRecoveryInProgress);
      providerRun.captureReviewPending = undefined;
      providerRun.captureRecoveryPending = undefined;
      providerRun.captureRecoveryInProgress = undefined;
      if (providerRun.status === 'failed') {
        providerRun.statusDetail = 'No retained report is available for retry. Save again can save the failed run details.';
      }
      if (recovery.jobExists) await transaction.objectStore('jobs').delete(id);
      await transaction.objectStore('runs').put(run);
      await transaction.done;
      return { outcome: 'unavailable', run, resumeRecommended };
    }
    const job = recovery.job;
    job.state = 'queued';
    job.tabUnavailable = true;
    job.leasedAt = undefined;
    job.leaseToken = undefined;
    job.deferredForNavigation = undefined;
    job.deferredAt = undefined;
    providerRun.captureReviewPending = undefined;
    providerRun.captureRecoveryPending = undefined;
    providerRun.captureRecoveryInProgress = true;
    if (providerRun.status === 'failed' && providerRun.statusDetail === CAPTURE_STORAGE_FAILURE_DETAIL) {
      providerRun.status = 'capturing';
      providerRun.completedAt = undefined;
      run.completedAt = undefined;
      run.status = deriveRunStatus(run);
    }
    providerRun.statusDetail = 'Retrying retained report.';
    await transaction.objectStore('jobs').put(job);
    await transaction.objectStore('runs').put(run);
    await transaction.done;
    return { outcome: 'scheduled', run };
  } catch (error) {
    try { transaction.abort(); } catch { /* The transaction may already have aborted. */ }
    await transaction.done.catch(() => undefined);
    throw error;
  }
}

export async function listPausedCaptureJobIds(): Promise<string[]> {
  const transaction = (await db()).transaction('jobs', 'readonly');
  const ids: string[] = [];
  for await (const cursor of transaction.store.index('by-state').iterate('paused')) {
    ids.push(String(cursor.primaryKey));
  }
  await transaction.done;
  return ids;
}

export async function commitCaptureJob(options: {
  id: string;
  runId: RunId;
  provider: ProviderId;
  capture?: Capture;
  expectedLeaseToken?: string;
  interruptForNavigation?: boolean;
}): Promise<CaptureCommitResult> {
  const transaction = (await db()).transaction(['runs', 'jobs', 'captures'], 'readwrite');
  try {
    const [stored, rawJob, existingCapture] = await Promise.all([
      transaction.objectStore('runs').get(options.runId),
      transaction.objectStore('jobs').get(options.id),
      transaction.objectStore('captures').get(options.id),
    ]);
    const run = stored && validRunRecord(stored) ? stored : undefined;
    if (stored && !run) warnInvalidRun(stored);
    const providerRun = run?.providerRuns[options.provider];
    if (!run || !providerRun) {
      const job = normalizeCaptureJobRecord(rawJob, options.id).job;
      if (job && job.runId === options.runId && job.provider === options.provider) {
        job.state = 'orphaned';
        job.orphanedAt ??= Date.now();
        job.leasedAt = undefined;
        job.leaseToken = undefined;
        await transaction.objectStore('jobs').put(job);
      }
      await transaction.done;
      return { outcome: 'missing_owner' };
    }
    if (options.expectedLeaseToken !== undefined) {
      const job = normalizeCaptureJobRecord(rawJob, options.id).job;
      if (!job || job.state !== 'leased' || job.leaseToken !== options.expectedLeaseToken) {
        await transaction.done;
        return { outcome: 'stale_lease' };
      }
    }
    let capture = options.capture ? structuredClone(options.capture) : existingCapture;
    if (!capture) {
      await transaction.done;
      return { outcome: 'missing_capture' };
    }
    if (options.capture) {
      capture.revision = existingCapture && captureContentSignature(existingCapture) === captureContentSignature(capture)
        ? existingCapture.revision ?? legacyCaptureRevision(existingCapture)
        : crypto.randomUUID();
      await transaction.objectStore('captures').put(capture, options.id);
    } else if (!capture.revision) {
      capture.revision = legacyCaptureRevision(capture);
      await transaction.objectStore('captures').put(capture, options.id);
    }
    const revision = capture.revision!;
    const legacyReceiptForSameCapture = providerRun.captureId === options.id
      && providerRun.artifactRevision === undefined
      && providerRun.saveReceipt !== undefined
      && providerRun.saveReceipt.artifactRevision === undefined;
    const degraded = capture.captureMethod === 'dom_only'
      || capture.metadataDegraded === true
      || capture.unplacedCitationCount > 0
      || capture.urlsUnresolved > 0
      || capture.researchTrail?.complete === false;
    const captureChanged = providerRun.captureId !== options.id
      || (providerRun.artifactRevision !== undefined && providerRun.artifactRevision !== revision)
      || (degraded && !providerRun.degraded);
    const recoveredStorageFailure = providerRun.status === 'failed'
      && (providerRun.captureRecoveryPending || providerRun.captureRecoveryInProgress
        || providerRun.statusDetail === CAPTURE_STORAGE_FAILURE_DETAIL);
    providerRun.captureId = options.id;
    providerRun.artifactRevision = revision;
    providerRun.captureReviewPending = undefined;
    providerRun.captureRecoveryPending = undefined;
    providerRun.captureRecoveryInProgress = undefined;
    if (legacyReceiptForSameCapture) providerRun.saveReceipt!.artifactRevision = revision;
    providerRun.degraded ||= degraded;
    let completed = false;
    if (recoveredStorageFailure) {
      providerRun.status = 'complete';
      providerRun.statusDetail = undefined;
      providerRun.saveReceipt = undefined;
      providerRun.completedAt ??= Date.now();
      run.completedAt = undefined;
      completed = true;
    } else if (isTerminalProviderStatus(providerRun.status)) {
      if (captureChanged && providerRun.saveReceipt) {
        providerRun.saveReceipt = undefined;
        run.completedAt = undefined;
      }
    } else if (options.interruptForNavigation) {
      providerRun.status = 'interrupted';
      providerRun.statusDetail = 'Provider tab navigated away before clipboard capture completed.';
      providerRun.completedAt ??= Date.now();
    } else {
      providerRun.status = 'complete';
      providerRun.statusDetail = undefined;
      providerRun.completedAt ??= Date.now();
      completed = true;
    }
    run.status = deriveRunStatus(run);
    if (rawJob !== undefined) await transaction.objectStore('jobs').delete(options.id);
    await transaction.objectStore('runs').put(run);
    await transaction.done;
    return { outcome: 'committed', run, capture, completed };
  } catch (error) {
    try { transaction.abort(); } catch { /* The transaction may already have aborted. */ }
    await transaction.done.catch(() => undefined);
    throw error;
  }
}

export interface CaptureJobCursor {
  createdAt: number;
  id: string;
}

export async function nextCaptureJob(after?: CaptureJobCursor): Promise<CaptureJob | undefined> {
  const database = await db();
  const transaction = database.transaction(['jobs', 'runs'], 'readonly');
  const range = after ? IDBKeyRange.lowerBound(after.createdAt) : undefined;
  let selected: CaptureJob | undefined;
  for await (const cursor of transaction.objectStore('jobs').index('by-created').iterate(range)) {
    if (after && cursor.key === after.createdAt && indexedDB.cmp(cursor.primaryKey, after.id) <= 0) continue;
    const normalized = normalizeCaptureJobRecord(cursor.value, String(cursor.primaryKey));
    const job = normalized.job;
    if (!job) continue;
    if (job.state === 'paused') continue;
    const storedRun = await transaction.objectStore('runs').get(job.runId);
    const run = storedRun && validRunRecord(storedRun) ? storedRun : undefined;
    if (storedRun && !run) warnInvalidRun(storedRun);
    if (job.state === 'orphaned') {
      if (Date.now() - (job.orphanedAt ?? job.createdAt) >= ORPHAN_JOB_RETENTION_MS) {
        selected = job;
        break;
      }
      if (run?.providerRuns[job.provider]) {
        selected = job;
        break;
      }
      continue;
    }
    if (run?.providerRuns[job.provider]?.captureRecoveryPending) continue;
    const leaseAge = job.leasedAt === undefined ? undefined : Date.now() - job.leasedAt;
    if (job.state !== 'queued' && !(leaseAge !== undefined && (leaseAge < 0 || leaseAge > 60_000))) continue;
    if (!job.deferredForNavigation || Date.now() - (job.deferredAt ?? job.createdAt) >= NAVIGATION_DEFERRAL_MS) {
      selected = job;
      break;
    }
    if (!run || !run.providerRuns[job.provider] || isTerminalProviderStatus(run.providerRuns[job.provider]!.status)) {
      selected = job;
      break;
    }
  }
  await transaction.done;
  return selected;
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

export async function pruneExpiredRedirects(): Promise<void> {
  const database = await db();
  const expiredRedirects = (await database.getAll('redirects'))
    .filter((redirect) => Date.now() - redirect.resolvedAt > REDIRECT_RETENTION_MS);
  if (!expiredRedirects.length) return;
  const transaction = database.transaction('redirects', 'readwrite');
  for (const redirect of expiredRedirects) await transaction.objectStore('redirects').delete(redirect.wrapper);
  await transaction.done;
}

export function captureId(runId: RunId, provider: ProviderId): string { return `${runId}:${provider}`; }
