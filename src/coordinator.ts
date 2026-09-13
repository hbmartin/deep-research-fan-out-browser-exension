import { ADAPTERS } from './adapters';
import { buildArtifact } from './artifacts';
import { reconcileCitations, tokenContainment, tokenSimilarity } from './citations';
import { captureId, deleteJob, evictHistory, getCapture, getJob, getRedirect, getRun, listRuns, MAX_CAPTURE_ATTEMPTS, nextCaptureJob, putCapture, putJob, putRedirect, putRun } from './db';
import type { RuntimeErrorCode, RuntimeRequest, RuntimeResponse } from './messages';
import { createPlatform, handleOffscreenResponse, sendTabEvent, type BrowserPlatform } from './platform';
import { loadSettings } from './settings';
import { normalizeResearchTrail } from './sources';
import { assertTransition, createDownloadFolder, deriveRunStatus, slugify } from './state';
import { ATTENTION_PROVIDER_STATUSES, isTerminalProviderStatus, PROVIDERS, type Capture, type CaptureJob, type DomCitation, type ProviderId, type ProviderRun, type ProviderRunStatus, type Run } from './types';

const ALARM_NAME = 'reconcile-runs';
const BROWSER_SESSION_KEY = 'coordinator.browser-session.v1';
let captureWorkerRunning = false;
let reconcileWorkerRunning = false;
let lastNonRunInteractionAt = 0;
const knownRunTabIds = new Set<number>();
const expectedTabActivations = new Map<number, number>();
const finalizingRunIds = new Set<string>();
const runMutationTails = new Map<string, Promise<void>>();
let browserSessionIdPromise: Promise<string> | undefined;
let fallbackBrowserSessionId: string | undefined;

class CoordinatorRequestError extends Error {
  constructor(message: string, readonly code: RuntimeErrorCode) {
    super(message);
    this.name = 'CoordinatorRequestError';
  }
}

async function getBrowserSessionId(): Promise<string> {
  browserSessionIdPromise ??= (async () => {
    const session = (browser.storage as unknown as {
      session?: {
        get(key: string): Promise<Record<string, unknown>>;
        set(value: Record<string, unknown>): Promise<void>;
      };
    }).session;
    if (!session) {
      fallbackBrowserSessionId ??= crypto.randomUUID();
      return fallbackBrowserSessionId;
    }
    try {
      const stored = await session.get(BROWSER_SESSION_KEY);
      if (typeof stored[BROWSER_SESSION_KEY] === 'string') return stored[BROWSER_SESSION_KEY];
      const id = crypto.randomUUID();
      await session.set({ [BROWSER_SESSION_KEY]: id });
      return id;
    } catch {
      fallbackBrowserSessionId ??= crypto.randomUUID();
      return fallbackBrowserSessionId;
    }
  })();
  return browserSessionIdPromise;
}

async function mutateStoredRun<T>(runId: string, mutation: (run: Run) => T): Promise<{ run: Run; value: T }> {
  const previous = runMutationTails.get(runId)?.catch(() => undefined) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  runMutationTails.set(runId, tail);
  await previous;
  try {
    const run = await getRun(runId);
    if (!run) throw new Error('Run not found.');
    const value = mutation(run);
    await putRun(run);
    return { run, value };
  } finally {
    release();
    if (runMutationTails.get(runId) === tail) runMutationTails.delete(runId);
  }
}

function setKnownRunTabs(runs: Run[]): void {
  knownRunTabIds.clear();
  for (const run of runs) for (const providerRun of Object.values(run.providerRuns)) knownRunTabIds.add(providerRun.tabId);
}

async function activateTabInternally(tabId: number): Promise<void> {
  markExpectedTabActivation(tabId);
  await browser.tabs.update(tabId, { active: true });
}

function markExpectedTabActivation(tabId: number, now = Date.now()): number {
  const expiresAt = now + 2000;
  expectedTabActivations.set(tabId, expiresAt);
  setTimeout(() => {
    if (expectedTabActivations.get(tabId) === expiresAt) expectedTabActivations.delete(tabId);
  }, 2000);
  return expiresAt;
}

function recordTabActivation(tabId: number, now = Date.now()): boolean {
  const expectedUntil = expectedTabActivations.get(tabId);
  expectedTabActivations.delete(tabId);
  if (expectedUntil !== undefined && expectedUntil >= now) return false;
  if (knownRunTabIds.has(tabId)) return false;
  lastNonRunInteractionAt = now;
  return true;
}

function errorResponse(error: unknown): RuntimeResponse {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof CoordinatorRequestError ? { code: error.code } : {}),
  };
}

function composeQuery(query: string, appendString: string): string {
  return appendString.trim() ? `${query}\n${appendString}` : query;
}

async function broadcastRuns(): Promise<void> {
  const runs = await listRuns();
  setKnownRunTabs(runs);
  await browser.runtime.sendMessage({ type: 'runs:changed', runs }).catch(() => undefined);
  await updateBadge(runs);
}

async function updateBadge(runs: Run[]): Promise<void> {
  const platform = createPlatform();
  const attention = runs.flatMap((run) => Object.values(run.providerRuns)).filter((providerRun) => ATTENTION_PROVIDER_STATUSES.has(providerRun.status)).length;
  if (attention) return platform.setBadge(String(attention), '#b42318');
  const unread = runs.flatMap((run) => Object.values(run.providerRuns)).filter((providerRun) => providerRun.status === 'complete' && !providerRun.copiedAt).length;
  await platform.setBadge(unread ? String(unread) : '', '#475467');
}

async function startContent(run: Run, provider: ProviderId, resumeOnly = false): Promise<void> {
  const providerRun = run.providerRuns[provider];
  if (!providerRun || isTerminalProviderStatus(providerRun.status)) return;
  const settings = await loadSettings();
  const id = captureId(run.id, provider);
  const captureAccepted = Boolean(await getJob(id) || await getCapture(id));
  const event = {
    type: 'content:start',
    runId: run.id,
    provider,
    query: run.query,
    appendString: providerRun.appendString,
    geminiAutoApprove: settings.geminiAutoApprove,
    completionDebounceMs: settings.providers[provider].completionDebounceMs,
    resumeOnly,
    status: providerRun.status,
    captureAccepted,
  } as const;
  try {
    await sendTabEvent(providerRun.tabId, event);
  } catch {
    try {
      const extensionBrowser = browser as typeof browser & {
        scripting?: { executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown> };
      };
      if (extensionBrowser.scripting) await extensionBrowser.scripting.executeScript({ target: { tabId: providerRun.tabId }, files: ['/content-scripts/providers.js'] });
      else await browser.tabs.executeScript(providerRun.tabId, { file: '/content-scripts/providers.js' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await sendTabEvent(providerRun.tabId, event);
    } catch {
      // The alarm sweep retries. A valid provider tab is kept open for manual use.
    }
  }
}

function shouldResumeContentOnly(status: ProviderRunStatus): boolean {
  return !['pending', 'opening', 'awaiting_ready', 'setting_mode'].includes(status);
}

async function createRun(queryInput: string, requestedWindowId?: number): Promise<Run> {
  const query = queryInput.trim();
  if (!query) throw new Error('Enter a research query.');
  const settings = await loadSettings();
  const browserSessionId = await getBrowserSessionId();
  const enabled = PROVIDERS.filter((provider) => settings.providers[provider].enabled);
  if (!enabled.length) throw new Error('Enable at least one provider in Options.');
  const currentWindow = requestedWindowId
    ? await browser.windows.get(requestedWindowId).catch(() => browser.windows.getCurrent())
    : await browser.windows.getCurrent();
  if (currentWindow.id === undefined) throw new Error('No browser window is available.');
  const now = Date.now();
  const id = crypto.randomUUID();
  const slug = slugify(query);
  const tabs = await Promise.all(enabled.map((provider) => browser.tabs.create({ windowId: currentWindow.id, url: ADAPTERS[provider].entryUrl, active: false })));
  const providerRuns: Run['providerRuns'] = {};
  enabled.forEach((provider, index) => {
    const tabId = tabs[index]!.id;
    if (tabId === undefined) throw new Error(`Could not create the ${provider} tab.`);
    const appendString = settings.providers[provider].appendString;
    providerRuns[provider] = {
      provider,
      tabId,
      status: 'opening',
      submittedQuery: composeQuery(query, appendString),
      appendString,
      startedAt: now,
      attempts: 0,
      degraded: false,
      adapterVersion: ADAPTERS[provider].version,
    };
  });
  const run: Run = {
    id,
    browserSessionId,
    query,
    createdAt: now,
    windowId: currentWindow.id,
    providerRuns,
    status: 'active',
    slug,
    downloadFolder: createDownloadFolder(settings.downloadRoot, now, slug, id),
  };
  const tabIds = tabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id]);
  const updateTab = browser.tabs.update as unknown as (tabId: number, properties: Record<string, unknown>) => Promise<unknown>;
  await Promise.all(tabIds.map((tabId) => updateTab(tabId, { autoDiscardable: false }).catch(() => undefined)));
  try {
    const groupId = await (browser.tabs as typeof browser.tabs & { group(options: { tabIds: number[] }): Promise<number> }).group({ tabIds });
    run.tabGroupId = groupId;
    const date = new Date(now);
    await browser.tabGroups.update(groupId, { title: `${query.slice(0, 32)} · ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` });
  } catch {
    for (const providerRun of Object.values(providerRuns)) providerRun.degraded = true;
  }
  await putRun(run);
  await Promise.all(enabled.map((provider) => startContent(run, provider)));
  await broadcastRuns();
  return run;
}

async function mutateProvider(runId: string, provider: ProviderId, status: ProviderRunStatus, detail?: string, submittedAt?: number): Promise<Run> {
  const { run } = await mutateStoredRun(runId, (storedRun) => {
    const providerRun = storedRun.providerRuns[provider];
    if (!providerRun) throw new Error('Provider is not part of this run.');
    assertTransition(providerRun.status, status);
    providerRun.status = status;
    providerRun.statusDetail = detail;
    if (submittedAt) providerRun.submittedAt = submittedAt;
    if (isTerminalProviderStatus(status)) providerRun.completedAt ??= Date.now();
    storedRun.status = deriveRunStatus(storedRun);
  });
  if (status === 'awaiting_user' || status === 'manual_required') {
    await createPlatform().notify(`attention:${runId}:${provider}`, `${ADAPTERS[provider].label} needs your input`, detail || 'Open the provider tab to continue.');
  }
  if (status === 'complete') {
    await createPlatform().notify(`complete:${runId}:${provider}`, `${ADAPTERS[provider].label} finished`, 'The normalized report is ready.');
  }
  await maybeFinalize(run);
  await broadcastRuns();
  return run;
}

async function resolveCitationUrls(provider: ProviderId, citations: DomCitation[]): Promise<{ citations: DomCitation[]; resolved: number; unresolved: number }> {
  if (ADAPTERS[provider].urlResolution !== 'follow_redirect') return { citations, resolved: 0, unresolved: 0 };
  let resolved = 0;
  let unresolved = 0;
  const output: DomCitation[] = [];
  for (let index = 0; index < citations.length; index += 6) {
    const batch = citations.slice(index, index + 6);
    output.push(...await Promise.all(batch.map(async (citation) => {
      let parsed: URL;
      try { parsed = new URL(citation.url); } catch { return citation; }
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'vertexaisearch.cloud.google.com') return citation;
      const cached = await getRedirect(citation.url);
      if (cached) { resolved += 1; return { ...citation, url: cached }; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(citation.url, { redirect: 'follow', signal: controller.signal });
        if (!response.url || response.url === citation.url) throw new Error('Redirect did not resolve');
        await putRedirect(citation.url, response.url);
        resolved += 1;
        return { ...citation, originalUrl: citation.url, url: response.url };
      } catch {
        unresolved += 1;
        return citation;
      } finally { clearTimeout(timer); }
    })));
  }
  return { citations: output, resolved, unresolved };
}

async function clipboardCapture(platform: BrowserPlatform, job: CaptureJob): Promise<{ text: string; restored: boolean } | undefined> {
  const settings = await loadSettings();
  const domMarkdown = job.domMarkdown.trim();
  const hasVerifiableDom = domMarkdown.length >= 20;
  const attemptCapture = async (allowCopyOnly = false): Promise<{ text: string; restored: boolean }> => {
    const original = await platform.readClipboard();
    const sentinel = `__DRFO_COPY_${crypto.randomUUID()}__`;
    let primed = false;
    let observed: string | undefined;
    try {
      await platform.writeClipboard(sentinel);
      primed = true;
      await sendTabEvent(job.tabId, { type: 'capture:copy-now', jobId: job.id });
      await new Promise((resolve) => setTimeout(resolve, 250));
      observed = await platform.readClipboard();
      const resemblesDomReport = hasVerifiableDom
        && (tokenSimilarity(observed, domMarkdown) >= 0.45 || tokenContainment(observed, domMarkdown) >= 0.8);
      if (observed === sentinel || observed.trim().length < 40 || (!resemblesDomReport && !(allowCopyOnly && !hasVerifiableDom))) {
        throw new Error('Provider copy did not produce a new report.');
      }
      let restored = false;
      if (settings.restoreClipboard) {
        const current = await platform.readClipboard();
        if (current === observed) {
          await platform.writeClipboard(original);
          restored = true;
        }
      }
      return { text: observed, restored };
    } catch (error) {
      if (primed) {
        const current = await platform.readClipboard().catch(() => undefined);
        if (current === sentinel) {
          await platform.writeClipboard(original).catch(() => undefined);
        }
      }
      throw error;
    }
  };
  if (hasVerifiableDom) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { return await attemptCapture(); }
      catch { await new Promise((resolve) => setTimeout(resolve, 300)); }
    }
  }
  if (job.tabUnavailable || Date.now() - lastNonRunInteractionAt < 5000) return undefined;
  const [current] = await browser.tabs.query({ active: true, currentWindow: true });
  try {
    await activateTabInternally(job.tabId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    return await attemptCapture(!hasVerifiableDom);
  } catch {
    return undefined;
  } finally {
    if (current?.id !== undefined && current.id !== job.tabId) await activateTabInternally(current.id).catch(() => undefined);
  }
}

function captureIsDegraded(capture: Capture): boolean {
  return capture.captureMethod === 'dom_only'
    || capture.unplacedCitationCount > 0
    || capture.urlsUnresolved > 0
    || capture.researchTrail?.complete === false;
}

async function persistCaptureJob(
  job: CaptureJob,
  copied?: { text: string; restored: boolean },
): Promise<{ id: string; degraded: boolean }> {
  const rawMarkdown = copied?.text || job.domMarkdown;
  if (rawMarkdown.trim().length < 40) throw new Error('Clipboard and DOM capture were both empty.');
  const resolved = await resolveCitationUrls(job.provider, job.domCitations);
  const reconciled = reconcileCitations(rawMarkdown, resolved.citations, ADAPTERS[job.provider].citationMarkerStyle);
  const researchTrail = job.researchTrail
    ? normalizeResearchTrail(job.researchTrail, reconciled.citations)
    : undefined;
  const capture: Capture = {
    rawMarkdown,
    normalizedMarkdown: reconciled.markdown,
    citations: reconciled.citations,
    captureMethod: copied ? (job.domCitations.length ? 'copy+dom' : 'copy_only') : 'dom_only',
    unplacedCitationCount: reconciled.unplacedCitationCount,
    capturedAt: Date.now(),
    urlsResolved: resolved.resolved,
    urlsUnresolved: resolved.unresolved,
    title: job.title,
    researchTrail,
  };
  const id = captureId(job.runId, job.provider);
  await putCapture(id, capture);
  return { id, degraded: captureIsDegraded(capture) };
}

async function completeProviderCapture(runId: string, provider: ProviderId, captureIdValue: string, degraded: boolean): Promise<boolean> {
  const { run, value } = await mutateStoredRun(runId, (storedRun) => {
    const providerRun = storedRun.providerRuns[provider];
    if (!providerRun) return { completed: false, attached: false };
    const captureChanged = providerRun.captureId !== captureIdValue || (degraded && !providerRun.degraded);
    providerRun.captureId = captureIdValue;
    providerRun.degraded ||= degraded;
    if (isTerminalProviderStatus(providerRun.status)) {
      if (captureChanged && providerRun.downloadedAt) {
        providerRun.downloadedAt = undefined;
        providerRun.downloadId = undefined;
        storedRun.completedAt = undefined;
      }
      storedRun.status = deriveRunStatus(storedRun);
      return { completed: false, attached: true };
    }
    assertTransition(providerRun.status, 'complete');
    providerRun.status = 'complete';
    providerRun.statusDetail = undefined;
    providerRun.completedAt ??= Date.now();
    storedRun.status = deriveRunStatus(storedRun);
    return { completed: true, attached: true };
  });
  if (!value.attached) return false;
  if (value.completed) {
    await createPlatform().notify(`complete:${runId}:${provider}`, `${ADAPTERS[provider].label} finished`, 'The normalized report is ready.');
  }
  await maybeFinalize(run);
  await broadcastRuns();
  return value.completed;
}

async function failProviderIfActive(runId: string, provider: ProviderId, detail: string): Promise<void> {
  const { run, value: failed } = await mutateStoredRun(runId, (storedRun) => {
    const providerRun = storedRun.providerRuns[provider];
    if (!providerRun || isTerminalProviderStatus(providerRun.status)) return false;
    assertTransition(providerRun.status, 'failed');
    providerRun.status = 'failed';
    providerRun.statusDetail = detail;
    providerRun.completedAt ??= Date.now();
    storedRun.status = deriveRunStatus(storedRun);
    return true;
  });
  if (!failed) return;
  await maybeFinalize(run);
  await broadcastRuns();
}

async function reconcilePersistedCaptureFailure(
  runId: string,
  provider: ProviderId,
  captureIdValue: string,
  degraded: boolean,
  error: unknown,
): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  const { run } = await mutateStoredRun(runId, (storedRun) => {
    const providerRun = storedRun.providerRuns[provider];
    if (!providerRun) return;
    providerRun.captureId = captureIdValue;
    providerRun.degraded ||= degraded;
    if (!isTerminalProviderStatus(providerRun.status)) {
      assertTransition(providerRun.status, 'failed');
      providerRun.status = 'failed';
      providerRun.statusDetail = `Capture was saved, but completion failed: ${detail}`;
      providerRun.completedAt ??= Date.now();
    }
    storedRun.status = deriveRunStatus(storedRun);
  });
  await maybeFinalize(run);
  await broadcastRuns();
}

async function containCaptureJobFailure(
  runId: string,
  provider: ProviderId,
  error: unknown,
  persisted?: { id: string; degraded: boolean },
): Promise<void> {
  console.error(`Capture job failed for ${provider}.`, error);
  try {
    if (persisted) await reconcilePersistedCaptureFailure(runId, provider, persisted.id, persisted.degraded, error);
    else await failProviderIfActive(runId, provider, error instanceof Error ? error.message : String(error));
  } catch (transitionError) {
    console.error(`Could not persist the failed capture state for ${provider}.`, transitionError);
  }
}

async function processCaptureQueue(): Promise<void> {
  if (captureWorkerRunning) return;
  captureWorkerRunning = true;
  const platform = createPlatform();
  try {
    for (;;) {
      const job = await nextCaptureJob();
      if (!job) break;
      const run = await getRun(job.runId);
      const providerRun = run?.providerRuns[job.provider];
      if (!run || !providerRun) {
        await deleteJob(job.id);
        continue;
      }
      const existingCapture = await getCapture(job.id);
      if (existingCapture) {
        job.state = 'leased';
        job.leasedAt = Date.now();
        await putJob(job);
        try {
          await completeProviderCapture(run.id, job.provider, job.id, captureIsDegraded(existingCapture));
          await deleteJob(job.id);
        } catch (error) {
          console.error(`Could not link the persisted ${job.provider} capture; retaining its recovery job.`, error);
        }
        continue;
      }
      const forceDomFallback = job.tabUnavailable
        || isTerminalProviderStatus(providerRun.status)
        || job.attempts >= MAX_CAPTURE_ATTEMPTS;
      job.state = 'leased';
      job.leasedAt = Date.now();
      if (job.attempts < MAX_CAPTURE_ATTEMPTS) job.attempts += 1;
      await putJob(job);
      let persisted: { id: string; degraded: boolean } | undefined;
      try {
        const copied = forceDomFallback ? undefined : await clipboardCapture(platform, job);
        persisted = await persistCaptureJob(job, copied);
        try {
          await completeProviderCapture(run.id, job.provider, persisted.id, persisted.degraded);
          await deleteJob(job.id);
        } catch (error) {
          await containCaptureJobFailure(run.id, job.provider, error, persisted);
        }
      } catch (error) {
        if (persisted) {
          await containCaptureJobFailure(run.id, job.provider, error, persisted);
          continue;
        }
        if (job.attempts >= MAX_CAPTURE_ATTEMPTS) {
          await deleteJob(job.id).catch((deleteError) => console.error('Could not remove a failed capture job.', deleteError));
          await containCaptureJobFailure(run.id, job.provider, error);
          continue;
        }
        console.error(`Capture job attempt failed for ${job.provider}; retaining its DOM fallback.`, error);
        job.state = 'leased';
        job.leasedAt = Date.now();
        await putJob(job).catch((putError) => console.error('Could not retain the failed capture job.', putError));
      }
    }
  } finally {
    captureWorkerRunning = false;
  }
}

async function queueCapture(request: Extract<RuntimeRequest, { type: 'content:capture' }>): Promise<void> {
  const run = await getRun(request.runId);
  const providerRun = run?.providerRuns[request.provider];
  if (!run || !providerRun) throw new Error('Run not found for capture.');
  if (isTerminalProviderStatus(providerRun.status)) {
    throw new CoordinatorRequestError('Provider run no longer accepts captures.', 'provider_terminal');
  }
  // A retry after a lost acknowledgement must not replace a leased payload.
  if (await getJob(captureId(run.id, request.provider))) {
    void processCaptureQueue();
    return;
  }
  if (providerRun.status !== 'capturing') await mutateProvider(run.id, request.provider, 'capturing');
  await putJob({
    id: captureId(run.id, request.provider), runId: run.id, provider: request.provider,
    tabId: providerRun.tabId, state: 'queued', createdAt: Date.now(), attempts: 0,
    domMarkdown: request.domMarkdown, domCitations: request.domCitations, researchTrail: request.researchTrail, title: request.title,
  });
  void processCaptureQueue();
}

async function downloadProvider(runId: string, provider: ProviderId, force = false): Promise<boolean> {
  const run = await getRun(runId);
  const providerRun = run?.providerRuns[provider];
  if (!run || !providerRun || (!force && providerRun.downloadedAt)) return false;
  const capture = await getCapture(providerRun.captureId);
  const settings = await loadSettings();
  const artifact = buildArtifact(run, providerRun, capture, { includeSourceSnippets: settings.includeSourceSnippets });
  const downloadId = await createPlatform().downloadText(`${run.downloadFolder}/${provider}.md`, artifact);
  await mutateStoredRun(run.id, (storedRun) => {
    const storedProviderRun = storedRun.providerRuns[provider];
    if (!storedProviderRun) return;
    storedProviderRun.downloadId = downloadId;
    storedProviderRun.downloadedAt = Date.now();
  });
  return true;
}

async function maybeFinalize(runInput: Run): Promise<void> {
  const runId = runInput.id;
  if (finalizingRunIds.has(runId)) return;
  finalizingRunIds.add(runId);
  try {
    const { run, value: shouldFinalize } = await mutateStoredRun(runId, (storedRun) => {
      const providerRuns = Object.values(storedRun.providerRuns);
      if (!providerRuns.length || !providerRuns.every((item) => isTerminalProviderStatus(item.status)) || storedRun.completedAt) return false;
      storedRun.status = 'finalizing';
      return true;
    });
    if (!shouldFinalize) return;
    const providerRuns = Object.values(run.providerRuns);
    const failedDownloads: string[] = [];
    for (const provider of PROVIDERS) {
      if (!run.providerRuns[provider]) continue;
      try { await downloadProvider(run.id, provider); } catch { failedDownloads.push(provider); }
    }
    const { run: completedRun } = await mutateStoredRun(run.id, (storedRun) => {
      storedRun.status = 'complete';
      storedRun.completedAt = Date.now();
    });
    if (completedRun.tabGroupId !== undefined) await browser.tabGroups.update(completedRun.tabGroupId, { collapsed: true }).catch(() => undefined);
    await evictHistory();
    const count = providerRuns.length - failedDownloads.length;
    await createPlatform().notify(`run:${run.id}`, 'Research run complete', `${count} of ${providerRuns.length} files saved${failedDownloads.length ? '; retry failed downloads from history.' : '.'}`);
  } finally {
    finalizingRunIds.delete(runId);
  }
}

async function markCaptureJobTabUnavailable(runId: string, provider: ProviderId): Promise<boolean> {
  const job = await getJob(captureId(runId, provider));
  if (!job) return false;
  job.tabUnavailable = true;
  job.state = 'queued';
  job.leasedAt = undefined;
  await putJob(job);
  return true;
}

async function endProvider(runId: string, provider: ProviderId): Promise<void> {
  const existing = await getRun(runId);
  const existingProvider = existing?.providerRuns[provider];
  if (!existing || !existingProvider) throw new Error('Provider run not found.');
  await sendTabEvent(existingProvider.tabId, { type: 'content:stop', runId }).catch(() => undefined);
  if (await markCaptureJobTabUnavailable(runId, provider)) {
    await processCaptureQueue();
    return;
  }
  const { run, value: ended } = await mutateStoredRun(runId, (storedRun) => {
    const providerRun = storedRun.providerRuns[provider];
    if (!providerRun) throw new Error('Provider run not found.');
    if (isTerminalProviderStatus(providerRun.status)) return false;
    assertTransition(providerRun.status, 'abandoned');
    providerRun.status = 'abandoned';
    providerRun.statusDetail = 'Ended by the user.';
    providerRun.completedAt ??= Date.now();
    storedRun.status = deriveRunStatus(storedRun);
    return true;
  });
  if (!ended) return;
  await maybeFinalize(run);
  await broadcastRuns();
}

function isProviderUrl(url: string | undefined, provider: ProviderId): boolean {
  if (!url) return false;
  try { return new URL(url).origin === ADAPTERS[provider].origin; }
  catch { return false; }
}

function isProviderAuthenticationUrl(url: string | undefined, provider: ProviderId): boolean {
  if (!url) return false;
  try { return ADAPTERS[provider].authenticationOrigins?.includes(new URL(url).origin) ?? false; }
  catch { return false; }
}

async function recordReconcileCheck(runId: string, provider: ProviderId, valid: boolean): Promise<Run> {
  return (await mutateStoredRun(runId, (run) => {
    const providerRun = run.providerRuns[provider];
    if (!providerRun || isTerminalProviderStatus(providerRun.status)) return;
    if (valid) {
      providerRun.reconcileFailureCount = undefined;
      return;
    }
    providerRun.reconcileFailureCount = (providerRun.reconcileFailureCount ?? 0) + 1;
    if (providerRun.reconcileFailureCount < 3) return;
    assertTransition(providerRun.status, 'interrupted');
    providerRun.status = 'interrupted';
    providerRun.statusDetail = 'Provider tab was unavailable or away from its provider for three checks.';
    providerRun.completedAt ??= Date.now();
    run.status = deriveRunStatus(run);
  })).run;
}

async function reconcileRuns(): Promise<void> {
  if (reconcileWorkerRunning) return;
  reconcileWorkerRunning = true;
  try {
    const browserSessionId = await getBrowserSessionId();
    const runs = await listRuns();
    setKnownRunTabs(runs);
    for (const snapshot of runs.filter((item) => item.status !== 'complete')) {
      if (snapshot.browserSessionId !== browserSessionId) {
        for (const providerRun of Object.values(snapshot.providerRuns)) {
          if (isTerminalProviderStatus(providerRun.status)) continue;
          const id = captureId(snapshot.id, providerRun.provider);
          const capture = await getCapture(id);
          if (capture) {
            await mutateStoredRun(snapshot.id, (storedRun) => {
              const currentProviderRun = storedRun.providerRuns[providerRun.provider];
              if (!currentProviderRun || isTerminalProviderStatus(currentProviderRun.status)) return;
              currentProviderRun.status = 'capturing';
              currentProviderRun.statusDetail = 'Linking a saved report after browser restart.';
              storedRun.status = deriveRunStatus(storedRun);
            });
            await completeProviderCapture(snapshot.id, providerRun.provider, id, captureIsDegraded(capture));
            await deleteJob(id).catch(() => undefined);
            continue;
          }
          const captureQueued = await markCaptureJobTabUnavailable(snapshot.id, providerRun.provider);
          await mutateStoredRun(snapshot.id, (storedRun) => {
            const currentProviderRun = storedRun.providerRuns[providerRun.provider];
            if (!currentProviderRun || isTerminalProviderStatus(currentProviderRun.status)) return;
            if (captureQueued) {
              currentProviderRun.status = 'capturing';
              currentProviderRun.statusDetail = 'Saving a detected report after browser restart.';
              currentProviderRun.completedAt = undefined;
            } else {
              currentProviderRun.status = 'interrupted';
              currentProviderRun.statusDetail = 'Browser restarted before completion.';
              currentProviderRun.completedAt ??= Date.now();
            }
            storedRun.status = deriveRunStatus(storedRun);
          });
        }
        const latest = await getRun(snapshot.id);
        if (latest) await maybeFinalize(latest);
        continue;
      }
      for (const providerRun of Object.values(snapshot.providerRuns)) {
        if (isTerminalProviderStatus(providerRun.status)) continue;
        let providerPage = false;
        let valid = false;
        try {
          const tab = await browser.tabs.get(providerRun.tabId);
          providerPage = isProviderUrl(tab.url, providerRun.provider);
          valid = providerPage || isProviderAuthenticationUrl(tab.url, providerRun.provider);
        } catch {
          valid = false;
        }
        if (!valid && await markCaptureJobTabUnavailable(snapshot.id, providerRun.provider)) continue;
        const checkedRun = await recordReconcileCheck(snapshot.id, providerRun.provider, valid);
        const checkedProviderRun = checkedRun.providerRuns[providerRun.provider];
        if (providerPage && checkedProviderRun && !isTerminalProviderStatus(checkedProviderRun.status)) {
          await startContent(checkedRun, providerRun.provider, shouldResumeContentOnly(checkedProviderRun.status));
        }
      }
      const latest = await getRun(snapshot.id);
      if (latest) await maybeFinalize(latest);
    }
    await processCaptureQueue();
    await broadcastRuns();
  } finally {
    reconcileWorkerRunning = false;
  }
}

async function interruptRemovedTab(tabId: number): Promise<void> {
  const runs = await listRuns();
  const matches = runs.flatMap((run) => Object.values(run.providerRuns)
    .filter((providerRun) => providerRun.tabId === tabId && !isTerminalProviderStatus(providerRun.status))
    .map((providerRun) => ({ runId: run.id, provider: providerRun.provider })));
  let changed = false;
  for (const match of matches) {
    if (await markCaptureJobTabUnavailable(match.runId, match.provider)) {
      changed = true;
      continue;
    }
    const { run, value: interrupted } = await mutateStoredRun(match.runId, (storedRun) => {
      const providerRun = storedRun.providerRuns[match.provider];
      if (!providerRun || isTerminalProviderStatus(providerRun.status)) return false;
      assertTransition(providerRun.status, 'interrupted');
      providerRun.status = 'interrupted';
      providerRun.statusDetail = 'Provider tab was closed.';
      providerRun.completedAt ??= Date.now();
      storedRun.status = deriveRunStatus(storedRun);
      return true;
    });
    if (!interrupted) continue;
    changed = true;
    await maybeFinalize(run);
  }
  await processCaptureQueue();
  if (changed) await broadcastRuns();
}

async function handleRequest(message: RuntimeRequest, sender: Browser.runtime.MessageSender): Promise<RuntimeResponse> {
  if (handleOffscreenResponse(message)) return { ok: true };
  try {
    switch (message.type) {
      case 'runs:list': return { ok: true, runs: await listRuns() };
      case 'run:start': return { ok: true, run: await createRun(message.query, message.windowId) };
      case 'run:rerun': {
        const prior = await getRun(message.runId);
        if (!prior) throw new Error('Run not found.');
        return { ok: true, run: await createRun(prior.query, prior.windowId) };
      }
      case 'run:end': {
        const run = await getRun(message.runId);
        if (!run) throw new Error('Run not found.');
        for (const provider of Object.keys(run.providerRuns) as ProviderId[]) await endProvider(run.id, provider);
        return { ok: true };
      }
      case 'provider:end': await endProvider(message.runId, message.provider); return { ok: true };
      case 'provider:focus': {
        const run = await getRun(message.runId);
        const providerRun = run?.providerRuns[message.provider];
        if (!run || !providerRun) throw new Error('Provider run not found.');
        await browser.windows.update(run.windowId, { focused: true });
        await browser.tabs.update(providerRun.tabId, { active: true });
        return { ok: true };
      }
      case 'provider:copy': {
        const run = await getRun(message.runId);
        const providerRun = run?.providerRuns[message.provider];
        const capture = await getCapture(providerRun?.captureId);
        if (!run || !providerRun || !capture) throw new Error('No captured report is available.');
        const settings = await loadSettings();
        await createPlatform().writeClipboard(buildArtifact(run, providerRun, capture, { includeSourceSnippets: settings.includeSourceSnippets }));
        await mutateStoredRun(run.id, (storedRun) => {
          const storedProviderRun = storedRun.providerRuns[message.provider];
          if (storedProviderRun) storedProviderRun.copiedAt = Date.now();
        });
        await broadcastRuns(); return { ok: true };
      }
      case 'provider:download': {
        const run = await getRun(message.runId);
        if (!run) throw new Error('Run not found.');
        await downloadProvider(run.id, message.provider, true); await broadcastRuns(); return { ok: true };
      }
      case 'content:hello': {
        const tabId = sender.tab?.id;
        if (tabId !== undefined) {
          const runs = await listRuns();
          const browserSessionId = await getBrowserSessionId();
          const run = runs.find((candidate) => candidate.browserSessionId === browserSessionId
            && candidate.providerRuns[message.provider]?.tabId === tabId);
          const providerRun = run?.providerRuns[message.provider];
          if (run && providerRun) void startContent(run, message.provider, shouldResumeContentOnly(providerRun.status));
        }
        return { ok: true };
      }
      case 'content:state': await mutateProvider(message.runId, message.provider, message.status, message.detail, message.submittedAt); return { ok: true };
      case 'content:capture': await queueCapture(message); return { ok: true };
      case 'capture:clipboard-read':
      case 'capture:clipboard-write':
      case 'download:blob-create':
      case 'download:blob-revoke':
      case 'capture:offscreen-result': return { ok: true };
    }
  } catch (error) { return errorResponse(error); }
}

export function startCoordinator(): void {
  const platform = createPlatform();
  const action = (browser.action ?? (browser as unknown as { browserAction: typeof browser.action }).browserAction);
  void platform.configurePanelAction();
  browser.runtime.onStartup.addListener(() => { void reconcileRuns(); });
  browser.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM_NAME) void reconcileRuns(); });
  browser.runtime.onMessage.addListener((message: RuntimeRequest, sender) => handleRequest(message, sender));
  browser.omnibox.onInputChanged.addListener((text, suggest) => suggest([{ content: text, description: 'Deep research → ChatGPT, Claude, Gemini, Grok' }]));
  browser.omnibox.onInputEntered.addListener((query) => {
    void platform.openPanel(browser.windows.WINDOW_ID_CURRENT).catch(() => undefined);
    void createRun(query).catch(() => undefined);
  });
  action.onClicked.addListener((tab) => { void platform.openPanel(tab.windowId); });
  browser.notifications.onClicked.addListener((id) => {
    const parts = id.split(':');
    if ((parts[0] === 'attention' || parts[0] === 'complete') && parts.length === 3) {
      void handleRequest({ type: 'provider:focus', runId: parts[1]!, provider: parts[2] as ProviderId }, {} as Browser.runtime.MessageSender);
    }
  });
  browser.tabs.onRemoved.addListener((tabId) => { void interruptRemovedTab(tabId); });
  browser.tabs.onActivated.addListener(({ tabId }) => { recordTabActivation(tabId); });
  void browser.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  void reconcileRuns();
}

export const coordinatorTestHooks = {
  clipboardCapture,
  getBrowserSessionId,
  handleRequest,
  mutateStoredRun,
  maybeFinalize,
  recordReconcileCheck,
  interruptRemovedTab,
  resolveCitationUrls,
  isProviderUrl,
  isProviderAuthenticationUrl,
  markExpectedTabActivation,
  recordTabActivation,
  setKnownRunTabs,
  processCaptureQueue,
  reconcileRuns,
  reconcilePersistedCaptureFailure,
  resetBrowserSession: () => {
    browserSessionIdPromise = undefined;
    fallbackBrowserSessionId = undefined;
  },
  getLastNonRunInteractionAt: () => lastNonRunInteractionAt,
};
