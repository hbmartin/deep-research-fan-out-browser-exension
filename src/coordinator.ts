import { ADAPTERS, classifyProviderPage, conversationKeysMatch, isProviderUrl, normalizeConversationKey, providerFromUrl, type ProviderPageIdentity } from './adapters';
import { buildArtifact, buildCurrentResponseCopy } from './artifacts';
import { reconcileCitations, tokenContainment, tokenSimilarity } from './citations';
import { acceptCaptureJob, CAPTURE_STORAGE_FAILURE_DETAIL, CaptureJobReviewRequiredError, captureId, commitCaptureJob, deleteJob, discardBlockedCaptureJob, getCapture, getJob, getRedirect, getRun, inspectCaptureJob, inspectCaptureRecovery, isUsableCaptureJobReport, listPausedCaptureJobIds, listRuns, MAX_CAPTURE_ATTEMPTS, nextCaptureJob, normalizeCaptureRecovery, ORPHAN_JOB_RETENTION_MS, pruneExpiredRedirects, putJob, putRedirect, putRun, scheduleCaptureRecovery, type CaptureJobCursor, type CaptureRecoveryInspection, type CaptureRecoveryNormalization } from './db';
import { NAVIGATION_DEFERRAL_MS } from './durations';
import type { ContentStateReason, CurrentResponseSnapshot, ProviderSnapshot, RuntimeErrorCode, RuntimeRequest, RuntimeResponse } from './messages';
import { createPlatform, handleOffscreenResponse, sendTabEvent, type BrowserPlatform } from './platform';
import { classifyDirectoryError, getReportDirectoryConfig, markReportDirectoryNeedsReconnect, markReportDirectoryWriteFailure, queryDirectoryPermission, writeUniqueMarkdown } from './report-storage';
import { loadSettings } from './settings';
import { normalizeResearchTrail } from './sources';
import { canTransition, assertTransition, createDownloadFolder, createReportFolder, deriveRunStatus, isSetupProviderStatus, slugify } from './state';
import { ATTENTION_PROVIDER_STATUSES, isTerminalProviderStatus, PROVIDERS, type ArtifactSaveFallbackReason, type ArtifactSaveReceipt, type Capture, type CaptureJob, type DomCitation, type ProviderId, type ProviderRun, type ProviderRunStatus, type ReportDirectoryConfig, type Run } from './types';

const ALARM_NAME = 'reconcile-runs';
const COPY_CURRENT_MENU_ID = 'copy-current-research-response';
let contextMenuRegistrationTail = Promise.resolve();
const clipboardMutationTails = new Map<string, Promise<void>>();
const BROWSER_SESSION_KEY = 'coordinator.browser-session.v1';
let captureScanPromise: Promise<void> | undefined;
let captureScanRequested = false;
const activeCaptureTasks = new Map<string, Promise<void>>();
const activeCaptureTaskGenerations = new Map<string, string>();
const captureTaskRerunIds = new Set<string>();
let reconcileWorkerRunning = false;
let lastNonRunInteractionAt = 0;
const knownRunTabIds = new Set<number>();
const expectedTabActivations = new Map<number, number>();
const finalizingRunIds = new Set<string>();
const runMutationTails = new Map<string, Promise<void>>();
const captureMutationTails = new Map<string, Promise<void>>();
const artifactSaveMutationTails = new Map<string, Promise<void>>();
let browserSessionIdPromise: Promise<string> | undefined;
let fallbackBrowserSessionId: string | undefined;

class CoordinatorRequestError extends Error {
  constructor(message: string, readonly code: RuntimeErrorCode, readonly providerState?: ProviderSnapshot) {
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

async function serializeByKey<T>(tails: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(key)?.catch(() => undefined) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  tails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

function withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
  return serializeByKey(runMutationTails, runId, operation);
}

function withClipboardLock<T>(operation: () => Promise<T>): Promise<T> {
  return serializeByKey(clipboardMutationTails, 'clipboard', operation);
}

async function mutateStoredRun<T>(runId: string, mutation: (run: Run) => T): Promise<{ run: Run; value: T }> {
  return withRunLock(runId, async () => {
    const run = await getRun(runId);
    if (!run) throw new CoordinatorRequestError('Run not found.', 'run_not_found');
    const before = JSON.stringify(run);
    const value = mutation(run);
    if (JSON.stringify(run) !== before) await putRun(run);
    return { run, value };
  });
}

function providerSnapshot(provider: ProviderRun): ProviderSnapshot {
  return {
    status: provider.status,
    submittedAt: provider.submittedAt,
    researchTimedOutAt: provider.researchTimedOutAt,
    conversationKey: normalizeConversationKey(provider.conversationKey, provider.provider),
  };
}

interface VerifiedContentPage {
  kind: 'entry' | 'conversation' | 'interrupted' | 'detached';
  conversationKey?: string;
}

function verifyContentPage(
  providerRun: ProviderRun,
  sender: Browser.runtime.MessageSender,
  reportedConversationKey?: string,
  navigationMode: 'normal' | 'interrupted' | 'detached' = 'normal',
): VerifiedContentPage {
  if (sender.tab?.id !== providerRun.tabId) {
    throw new CoordinatorRequestError('Provider message came from a different or unavailable tab.', 'conversation_mismatch', providerSnapshot(providerRun));
  }
  const senderUrl = sender.url ?? sender.tab.url;
  if (navigationMode !== 'normal') {
    if (!isProviderUrl(senderUrl, providerRun.provider)) {
      throw new CoordinatorRequestError('Provider navigation message came from outside its provider.', 'conversation_mismatch', providerSnapshot(providerRun));
    }
    const page = senderUrl ? classifyProviderPage(senderUrl, providerRun.provider) : { kind: 'unsupported' } as const;
    if (navigationMode === 'detached' && page.kind === 'conversation') {
      throw new CoordinatorRequestError('Detached provider message came from a conversation page.', 'conversation_mismatch', providerSnapshot(providerRun));
    }
    return { kind: navigationMode };
  }
  const page = senderUrl ? classifyProviderPage(senderUrl, providerRun.provider) : { kind: 'unsupported' } as const;
  if (page.kind === 'unsupported') {
    throw new CoordinatorRequestError('Provider tab is not showing a supported conversation or entry page.', 'conversation_mismatch', providerSnapshot(providerRun));
  }
  const storedConversationKey = normalizeConversationKey(providerRun.conversationKey, providerRun.provider);
  const reportedKey = normalizeConversationKey(reportedConversationKey, providerRun.provider);
  if ((providerRun.conversationKey !== undefined && storedConversationKey === undefined)
    || (reportedConversationKey !== undefined && reportedKey === undefined)) {
    throw new CoordinatorRequestError('Provider message contains an unrecognized conversation identity.', 'conversation_mismatch', providerSnapshot(providerRun));
  }
  if (page.kind === 'entry') {
    if (providerRun.conversationKey !== undefined || reportedConversationKey !== undefined) {
      throw new CoordinatorRequestError('Provider tab left its verified conversation.', 'conversation_mismatch', providerSnapshot(providerRun));
    }
    return { kind: 'entry' };
  }
  if ((storedConversationKey !== undefined && reportedKey === undefined)
    || (reportedKey !== undefined && !conversationKeysMatch(page.key, reportedKey, providerRun.provider))
    || (storedConversationKey && !conversationKeysMatch(storedConversationKey, page.key, providerRun.provider))) {
    throw new CoordinatorRequestError('Provider tab is showing a different or unverified conversation.', 'conversation_mismatch', providerSnapshot(providerRun));
  }
  return { kind: 'conversation', conversationKey: page.key };
}

function validateProviderTransition(provider: ProviderRun | undefined, status: ProviderRunStatus): asserts provider is ProviderRun {
  if (!provider) throw new CoordinatorRequestError('Provider run not found.', 'run_not_found');
  if (isTerminalProviderStatus(provider.status)) {
    throw new CoordinatorRequestError('Provider run has ended.', 'provider_terminal', providerSnapshot(provider));
  }
  if (!canTransition(provider.status, status)) {
    throw new CoordinatorRequestError(`Invalid provider transition: ${provider.status} -> ${status}`, 'invalid_transition', providerSnapshot(provider));
  }
}

function rememberDetachedSetupPhase(providerRun: ProviderRun): void {
  if (providerRun.submittedAt !== undefined || providerRun.detachedSetupStatus) return;
  if (providerRun.status === 'opening' || providerRun.status === 'awaiting_ready' || providerRun.status === 'setting_mode') {
    providerRun.detachedSetupStatus = providerRun.status;
  }
}

async function restoreDetachedSetupPhase(runId: string, provider: ProviderId): Promise<Run> {
  return (await mutateStoredRun(runId, (storedRun) => {
    const current = storedRun.providerRuns[provider];
    if (!current || isTerminalProviderStatus(current.status)) return;
    if (current.status === 'manual_required' && current.detachedSetupStatus && current.submittedAt === undefined) {
      const next = current.detachedSetupStatus;
      assertTransition(current.status, next);
      current.status = next;
      current.statusDetail = 'Provider page restored; resuming setup.';
    } else if (current.detachedAt !== undefined) {
      current.statusDetail = 'Provider conversation restored; checking progress.';
    }
    current.detachedSetupStatus = undefined;
    current.detachedAt = undefined;
    storedRun.status = deriveRunStatus(storedRun);
  })).run;
}

function serializeCapture<T>(id: string, operation: () => Promise<T>): Promise<T> {
  return serializeByKey(captureMutationTails, id, operation);
}

function withCaptureAndRunLock<T>(
  runId: string,
  provider: ProviderId,
  operation: () => Promise<T>,
): Promise<T> {
  return serializeCapture(captureId(runId, provider), () => withRunLock(runId, operation));
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
    ...(error instanceof CoordinatorRequestError ? { code: error.code, providerState: error.providerState } : {}),
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

async function ensureContentReceiver(tabId: number, provider: ProviderId): Promise<void> {
  try {
    await sendTabEvent(tabId, { type: 'content:ping', provider });
  } catch (error) {
    // A rejected application request is not evidence that the receiver is missing.
    if (!/receiving end does not exist|could not establish connection|no receiver/i.test(String(error))) throw error;
    const extensionBrowser = browser as typeof browser & {
      scripting?: { executeScript(options: { target: { tabId: number }; files: string[] }): Promise<unknown> };
    };
    if (extensionBrowser.scripting) await extensionBrowser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/providers.js'] });
    else await browser.tabs.executeScript(tabId, { file: '/content-scripts/providers.js' });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function startContent(run: Run, provider: ProviderId, resumeOnly = false): Promise<void> {
  const providerRun = run.providerRuns[provider];
  if (!providerRun || isTerminalProviderStatus(providerRun.status)
    || providerRun.captureReviewPending || providerRun.captureRecoveryInProgress) return;
  try {
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
      submittedAt: providerRun.submittedAt,
      researchTimedOutAt: providerRun.researchTimedOutAt,
      conversationKey: normalizeConversationKey(providerRun.conversationKey, provider),
      captureAccepted,
    } as const;
    await ensureContentReceiver(providerRun.tabId, provider);
    await sendTabEvent(providerRun.tabId, event);
  } catch {
    // The alarm sweep retries both storage reads and content-script startup.
  }
}

function shouldResumeContentOnly(status: ProviderRunStatus): boolean {
  return !isSetupProviderStatus(status);
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
  const reportFolder = createReportFolder(slug, id);
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
    recordVersion: 2,
    id,
    browserSessionId,
    query,
    createdAt: now,
    windowId: currentWindow.id,
    providerRuns,
    status: 'active',
    slug,
    reportFolder,
    downloadFolder: createDownloadFolder(settings.downloadRoot, slug, id),
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

async function mutateProvider(
  runId: string,
  provider: ProviderId,
  status: ProviderRunStatus,
  detail?: string,
  submittedAt?: number,
  reason?: ContentStateReason,
  conversationKey?: string,
  sender?: Browser.runtime.MessageSender,
): Promise<Run> {
  const { run, value: changed } = await mutateStoredRun(runId, (storedRun) => {
    const providerRun = storedRun.providerRuns[provider];
    if (!providerRun) throw new CoordinatorRequestError('Provider run not found.', 'run_not_found');
    const navigationMode = status === 'interrupted'
      ? 'interrupted'
      : reason === 'provider_navigation' && status === 'manual_required'
        ? 'detached'
        : 'normal';
    const verifiedPage = verifyContentPage(providerRun, sender ?? {}, conversationKey, navigationMode);
    if ((status === 'opening' || status === 'awaiting_ready' || status === 'setting_mode') && providerRun.status === 'manual_required'
      && (providerRun.detachedSetupStatus === undefined || providerRun.submittedAt !== undefined)) {
      throw new CoordinatorRequestError('Setup can resume only after a recorded pre-submission redirect.', 'invalid_transition', providerSnapshot(providerRun));
    }
    validateProviderTransition(providerRun, status);
    const previousConversationKey = normalizeConversationKey(providerRun.conversationKey, provider);
    const previouslyDetached = providerRun.detachedAt !== undefined;
    const conversationBound = providerRun.conversationKey === undefined && verifiedPage.conversationKey !== undefined;
    if (verifiedPage.kind !== 'interrupted' && verifiedPage.kind !== 'detached') {
      providerRun.conversationKey = verifiedPage.conversationKey ?? previousConversationKey;
    }
    const timeout = reason === 'research_timeout' && status === 'manual_required';
    const changed = providerRun.status !== status || providerRun.statusDetail !== detail;
    const firstTimeout = timeout && providerRun.researchTimedOutAt === undefined;
    const enteredResearch = status === 'researching' && providerRun.status !== 'researching';
    const refreshedResearchInterval = status === 'researching' && submittedAt !== undefined
      && (providerRun.submittedAt === undefined || submittedAt > providerRun.submittedAt);
    if (verifiedPage.kind === 'detached') rememberDetachedSetupPhase(providerRun);
    providerRun.status = status;
    providerRun.statusDetail = detail;
    if (verifiedPage.kind === 'detached') providerRun.detachedAt ??= Date.now();
    else if (verifiedPage.kind !== 'interrupted') providerRun.detachedAt = undefined;
    if (status === 'opening' || status === 'awaiting_ready' || status === 'setting_mode' || status === 'submitting'
      || status === 'researching' || isTerminalProviderStatus(status)) providerRun.detachedSetupStatus = undefined;
    if (enteredResearch || refreshedResearchInterval) {
      providerRun.submittedAt = submittedAt ?? Date.now();
      providerRun.researchTimedOutAt = undefined;
    } else {
      providerRun.submittedAt ??= submittedAt ?? (status === 'researching' ? Date.now() : undefined);
    }
    if (firstTimeout) providerRun.researchTimedOutAt = Date.now();
    if (isTerminalProviderStatus(status)) providerRun.completedAt ??= Date.now();
    storedRun.status = deriveRunStatus(storedRun);
    return timeout ? firstTimeout : changed || refreshedResearchInterval || conversationBound
      || previouslyDetached !== (providerRun.detachedAt !== undefined);
  });
  // The state is durable. UI side effects must not invalidate its acknowledgement.
  try {
    if (changed && isTerminalProviderStatus(status)) {
      await settleProvider(runId, provider, status === 'complete');
      return run;
    }
    if (changed && (status === 'awaiting_user' || status === 'manual_required')) {
      await createPlatform().notify(`attention:${runId}:${provider}`, `${ADAPTERS[provider].label} needs your input`, detail || 'Open the provider tab to continue.');
    }
    if (changed) await broadcastRuns();
  } catch (error) { console.error('Could not update UI after persisting provider state.', error); }
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
      const cached = await getRedirect(citation.url).catch(() => undefined);
      if (cached) { resolved += 1; return { ...citation, url: cached }; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(citation.url, { redirect: 'follow', signal: controller.signal });
        if (!response.url || response.url === citation.url) throw new Error('Redirect did not resolve');
        await putRedirect(citation.url, response.url).catch(() => undefined);
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

function validateCurrentResponseSnapshot(value: unknown): CurrentResponseSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Provider did not return a response snapshot.');
  const candidate = value as Partial<CurrentResponseSnapshot>;
  if (!candidate.provider || !PROVIDERS.includes(candidate.provider)
    || typeof candidate.pageUrl !== 'string'
    || (candidate.activeRunId !== undefined && typeof candidate.activeRunId !== 'string')
    || (candidate.conversationKey !== undefined && typeof candidate.conversationKey !== 'string')
    || typeof candidate.domMarkdown !== 'string' || !candidate.domMarkdown.trim()
    || !Array.isArray(candidate.domCitations)) {
    throw new Error('Provider returned an invalid response snapshot.');
  }
  const optionalString = (value: unknown) => value === undefined || typeof value === 'string';
  const validCitations = candidate.domCitations.every((citation) => {
    if (!citation || typeof citation !== 'object'
      || typeof citation.url !== 'string'
      || !Number.isSafeInteger(citation.domOrder) || citation.domOrder < 0
      || typeof citation.contextBefore !== 'string'
      || typeof citation.contextAfter !== 'string'
      || !optionalString(citation.originalUrl)
      || !optionalString(citation.title)
      || !optionalString(citation.markerText)) return false;
    try { return ['http:', 'https:'].includes(new URL(citation.url).protocol); }
    catch { return false; }
  });
  if (!validCitations) throw new Error('Provider returned invalid citation data.');
  return {
    provider: candidate.provider,
    pageUrl: candidate.pageUrl,
    activeRunId: candidate.activeRunId,
    conversationKey: candidate.conversationKey,
    domMarkdown: candidate.domMarkdown,
    domCitations: candidate.domCitations,
  };
}

interface ExpectedCurrentResponse {
  runId: string;
  conversationKey?: string;
}

type SupportedProviderPage = Exclude<ProviderPageIdentity, { kind: 'unsupported' }>;

function requireSupportedProviderPage(value: string | undefined, provider: ProviderId): SupportedProviderPage {
  const page = value ? classifyProviderPage(value, provider) : { kind: 'unsupported' } as const;
  if (page.kind === 'unsupported') {
    throw new CoordinatorRequestError(
      'Provider tab is not showing a supported conversation or entry page.',
      'conversation_mismatch',
    );
  }
  return page;
}

function providerPagesMatch(left: SupportedProviderPage, right: SupportedProviderPage, provider: ProviderId): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'entry'
    || (right.kind === 'conversation' && conversationKeysMatch(left.key, right.key, provider));
}

function assertCurrentResponseIdentity(
  snapshot: CurrentResponseSnapshot,
  provider: ProviderId,
  operationPage: SupportedProviderPage,
  expected?: ExpectedCurrentResponse,
): void {
  if (snapshot.provider !== provider || !isProviderUrl(snapshot.pageUrl, provider)) {
    throw new CoordinatorRequestError('Provider response identity did not match the requested provider.', 'conversation_mismatch');
  }
  const snapshotPage = requireSupportedProviderPage(snapshot.pageUrl, provider);
  const snapshotConversationKey = normalizeConversationKey(snapshot.conversationKey, provider);
  const conflictingRun = expected && snapshot.activeRunId !== undefined && snapshot.activeRunId !== expected.runId;
  const pageMismatch = !providerPagesMatch(snapshotPage, operationPage, provider);
  const conversationMismatch = operationPage.kind === 'conversation'
    ? !conversationKeysMatch(snapshotConversationKey, operationPage.key, provider)
    : snapshotConversationKey !== undefined;
  if (conflictingRun || pageMismatch || conversationMismatch) {
    throw new CoordinatorRequestError('Provider tab is showing a different or unverified conversation.', 'conversation_mismatch');
  }
}

async function copyCurrentResponse(tabId: number, provider: ProviderId, expected?: ExpectedCurrentResponse): Promise<void> {
  const tab = await browser.tabs.get(tabId);
  const operationPage = requireSupportedProviderPage(tab.url, provider);
  const expectedConversationKey = normalizeConversationKey(expected?.conversationKey, provider);
  if (expectedConversationKey) {
    if (operationPage.kind !== 'conversation'
      || !conversationKeysMatch(expectedConversationKey, operationPage.key, provider)) {
      throw new CoordinatorRequestError('Provider tab is no longer on the expected conversation.', 'conversation_mismatch');
    }
  } else if (expected && operationPage.kind !== 'entry') {
    throw new CoordinatorRequestError('Provider tab is showing an unverified conversation.', 'conversation_mismatch');
  }
  await ensureContentReceiver(tabId, provider);
  const operationConversationKey = operationPage.kind === 'conversation' ? operationPage.key : undefined;
  const snapshot = validateCurrentResponseSnapshot(await sendTabEvent(tabId, {
    type: 'capture:dom-current', provider, runId: expected?.runId, conversationKey: operationConversationKey,
  }));
  assertCurrentResponseIdentity(snapshot, provider, operationPage, expected);
  const resolved = await resolveCitationUrls(provider, snapshot.domCitations);
  const reconciled = reconcileCitations(snapshot.domMarkdown, resolved.citations, ADAPTERS[provider].citationMarkerStyle);
  await withClipboardLock(async () => {
    const currentTab = await browser.tabs.get(tabId);
    const currentPage = requireSupportedProviderPage(currentTab.url, provider);
    if (!providerPagesMatch(currentPage, operationPage, provider)) {
      throw new CoordinatorRequestError('Provider tab changed before the response could be copied.', 'conversation_mismatch');
    }
    await createPlatform().writeClipboard(buildCurrentResponseCopy(reconciled.markdown, reconciled.citations));
  });
}

async function registerCopyCurrentContextMenu(): Promise<void> {
  const registration = contextMenuRegistrationTail.catch(() => undefined).then(async () => {
    await browser.contextMenus.remove(COPY_CURRENT_MENU_ID).catch(() => undefined);
    browser.contextMenus.create({
      id: COPY_CURRENT_MENU_ID,
      title: 'Copy current response',
      contexts: ['page'],
      documentUrlPatterns: Object.values(ADAPTERS).map((adapter) => `${adapter.origin}/*`),
    });
  });
  contextMenuRegistrationTail = registration;
  await registration;
}

async function handleCopyCurrentContextMenu(info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab): Promise<void> {
  if (info.menuItemId !== COPY_CURRENT_MENU_ID) return;
  const provider = tab?.url ? providerFromUrl(tab.url) : undefined;
  try {
    if (tab?.id === undefined || !provider) throw new Error('Open a supported provider response before copying.');
    await copyCurrentResponse(tab.id, provider);
  } catch (error) {
    await createPlatform().notify(
      `copy-current:${tab?.id ?? 'unavailable'}`,
      'Could not copy current response',
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
    return;
  }
  await createPlatform().notify(
    `copy-current:${tab!.id}`, `${ADAPTERS[provider!].label} response copied`, 'The current normalized response is on your clipboard.',
  ).catch((error) => console.error('Could not show the Copy current success notification.', error));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function clipboardCapture(platform: BrowserPlatform, job: CaptureJob): Promise<{ text: string; restored: boolean } | undefined> {
  return withClipboardLock(async () => {
    const settings = await loadSettings();
    const domMarkdown = job.domMarkdown.trim();
    const hasVerifiableDom = domMarkdown.length >= 20;
    const attemptCapture = async (allowCopyOnly = false): Promise<{ text: string; restored: boolean }> => {
      const original = await platform.readClipboard();
      const sentinel = `__DRFO_COPY_${crypto.randomUUID()}__`;
      let primed = false;
      let observed: string | undefined;
      let copyConfirmed = false;
      try {
        await platform.writeClipboard(sentinel);
        primed = true;
        if (await platform.readClipboard() !== sentinel) throw new Error('Could not verify the clipboard capture sentinel.');
        const clickResult = await withTimeout(sendTabEvent(job.tabId, {
          type: 'capture:copy-now', jobId: job.id, conversationKey: job.conversationKey,
        }), 5000, 'Provider copy request timed out.');
        copyConfirmed = Boolean(clickResult && typeof clickResult === 'object'
          && 'copyConfirmed' in clickResult && clickResult.copyConfirmed === true);
        await new Promise((resolve) => setTimeout(resolve, 250));
        observed = await platform.readClipboard();
        const resemblesDomReport = hasVerifiableDom
          && (tokenSimilarity(observed, domMarkdown) >= 0.45 || tokenContainment(observed, domMarkdown) >= 0.8);
        const confirmedShortCopy = copyConfirmed && (resemblesDomReport || (allowCopyOnly && !hasVerifiableDom));
        if (observed === sentinel
          || !observed.trim()
          || (observed.trim().length < 40 && !confirmedShortCopy)
          || (!resemblesDomReport && !(allowCopyOnly && !hasVerifiableDom && copyConfirmed))) {
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
          if (current === sentinel
            || (settings.restoreClipboard && copyConfirmed && observed !== undefined && current === observed)) {
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
  });
}

async function persistCaptureJob(
  job: CaptureJob,
  copied?: { text: string; restored: boolean },
): Promise<Capture> {
  const rawMarkdown = copied?.text || job.domMarkdown;
  const shortDomBacked = Boolean(job.copyControlObserved && job.domMarkdown.trim());
  if (!rawMarkdown.trim() || (rawMarkdown.trim().length < 40 && !shortDomBacked)) {
    throw new Error('Clipboard and DOM capture did not contain a usable report.');
  }
  let normalizedMarkdown = rawMarkdown;
  let citations: Capture['citations'] = [];
  let unplacedCitationCount = 0;
  let urlsResolved = 0;
  let urlsUnresolved = 0;
  let researchTrail: Capture['researchTrail'];
  let metadataDegraded = false;
  let captureMethod: Capture['captureMethod'] = copied ? (job.domCitations.length ? 'copy+dom' : 'copy_only') : 'dom_only';
  try {
    const resolved = await resolveCitationUrls(job.provider, job.domCitations);
    const reconciled = reconcileCitations(rawMarkdown, resolved.citations, ADAPTERS[job.provider].citationMarkerStyle);
    normalizedMarkdown = reconciled.markdown;
    citations = reconciled.citations;
    unplacedCitationCount = reconciled.unplacedCitationCount;
    urlsResolved = resolved.resolved;
    urlsUnresolved = resolved.unresolved;
  } catch (error) {
    if (!isUsableCaptureJobReport(job)) throw error;
    // Malformed citation metadata must not destroy the already-verified
    // report. Keep its plain DOM text as a degraded, citation-free artifact.
    normalizedMarkdown = job.domMarkdown;
    captureMethod = 'dom_only';
    citations = [];
    unplacedCitationCount = 0;
    urlsResolved = 0;
    urlsUnresolved = 0;
    metadataDegraded = true;
  }
  if (job.researchTrail && !metadataDegraded) {
    try { researchTrail = normalizeResearchTrail(job.researchTrail, citations); }
    catch { metadataDegraded = true; }
  }
  const capture: Capture = {
    rawMarkdown: captureMethod === 'dom_only' && copied ? job.domMarkdown : rawMarkdown,
    normalizedMarkdown,
    citations,
    captureMethod,
    unplacedCitationCount,
    capturedAt: Date.now(),
    urlsResolved,
    urlsUnresolved,
    metadataDegraded: metadataDegraded || undefined,
    title: job.title,
    researchTrail,
  };
  return capture;
}

async function completeProviderCapture(
  runId: string,
  provider: ProviderId,
  captureIdValue: string,
  interruptForNavigation = false,
): Promise<boolean> {
  const result = await withCaptureAndRunLock(runId, provider, () => commitCaptureJob({
    id: captureIdValue, runId, provider, interruptForNavigation,
  }));
  if (result.outcome === 'missing_owner') throw new Error(`Could not link ${provider} capture to its provider run.`);
  if (result.outcome !== 'committed') throw new Error('Captured report is unavailable.');
  await settleProvider(runId, provider, result.completed);
  return result.completed;
}

async function retryPausedCapture(runId: string, provider: ProviderId): Promise<void> {
  const id = captureId(runId, provider);
  const result = await withCaptureAndRunLock(runId, provider, () => scheduleCaptureRecovery(id, runId, provider));
  if (result.outcome === 'missing_owner') {
    throw new CoordinatorRequestError('Run not found.', 'run_not_found');
  }
  if (result.outcome === 'review_required') {
    await broadcastRuns().catch((error) => console.error('Could not broadcast capture review state.', error));
    throw new CoordinatorRequestError(
      'A retained report needs review before capture recovery can continue.',
      'capture_review_required',
      providerSnapshot(result.run.providerRuns[provider]!),
    );
  }
  if (result.outcome === 'unavailable') {
    if (result.resumeRecommended) await resumeProviderAfterRecoveryRemoval(result.run, provider, true);
    await broadcastRuns().catch((error) => console.error('Could not broadcast cleared capture recovery.', error));
    throw new CoordinatorRequestError('No retained report is available for capture retry.', 'invalid_transition');
  }
  scheduleCaptureTask({ id, runId, provider }, true);
  await broadcastRuns().catch((error) => console.error('Could not broadcast scheduled capture recovery.', error));
}

type OwnedProviderTabKind = 'original' | 'recoverable' | 'different_conversation' | 'external' | 'unavailable';

async function classifyOwnedProviderTab(providerRun: ProviderRun): Promise<{ kind: OwnedProviderTabKind }> {
  let url: string | undefined;
  try { url = (await browser.tabs.get(providerRun.tabId)).url; }
  catch { return { kind: 'unavailable' }; }
  if (!url) return { kind: 'unavailable' };
  if (isProviderAuthenticationUrl(url, providerRun.provider)) return { kind: 'recoverable' };
  if (!isProviderUrl(url, providerRun.provider)) return { kind: 'external' };
  const page = classifyProviderPage(url, providerRun.provider);
  const boundKey = normalizeConversationKey(providerRun.conversationKey, providerRun.provider);
  if (providerRun.conversationKey !== undefined && boundKey === undefined) return { kind: 'different_conversation' };
  if (page.kind === 'conversation') {
    return boundKey && !conversationKeysMatch(boundKey, page.key, providerRun.provider)
      ? { kind: 'different_conversation' } : { kind: 'original' };
  }
  return page.kind === 'entry' && boundKey === undefined
    ? { kind: 'original' } : { kind: 'recoverable' };
}

interface CaptureTaskTarget {
  id: string;
  runId: string;
  provider: ProviderId;
}

type CaptureTaskClaim =
  | { kind: 'none' }
  | { kind: 'link' }
  | { kind: 'work'; job: CaptureJob; providerRun: ProviderRun };

async function claimCaptureTask(target: CaptureTaskTarget, leaseToken: string): Promise<CaptureTaskClaim> {
  return withCaptureAndRunLock(target.runId, target.provider, async () => {
    const [capture, job, run] = await Promise.all([
      getCapture(target.id), getJob(target.id), getRun(target.runId),
    ]);
    const providerRun = run?.providerRuns[target.provider];
    if (capture && providerRun) return { kind: 'link' };
    if (!job) return { kind: 'none' };
    if (!run || !providerRun) {
      if (job.state === 'orphaned' && Date.now() - (job.orphanedAt ?? job.createdAt) >= ORPHAN_JOB_RETENTION_MS) {
        await deleteJob(job.id);
      } else {
        job.state = 'orphaned';
        job.orphanedAt ??= Date.now();
        job.leasedAt = undefined;
        job.leaseToken = undefined;
        await putJob(job);
      }
      return { kind: 'none' };
    }
    if (job.state === 'paused' && !providerRun.captureRecoveryInProgress) return { kind: 'none' };
    if (job.state === 'orphaned') {
      job.state = 'queued';
      job.orphanedAt = undefined;
      if (providerRun.captureRecoveryPending && !providerRun.captureRecoveryInProgress) {
        await putJob(job);
        return { kind: 'none' };
      }
    }
    job.state = 'leased';
    job.leasedAt = Date.now();
    job.leaseToken = leaseToken;
    await putJob(job);
    return { kind: 'work', job: structuredClone(job), providerRun: structuredClone(providerRun) };
  });
}

type PreparedCaptureAttempt =
  | { kind: 'stale' }
  | { kind: 'discarded' }
  | { kind: 'deferred'; run: Run; notify: boolean }
  | { kind: 'ready'; job: CaptureJob; navigatedAway: boolean; forceDomFallback: boolean };

async function prepareCaptureAttempt(
  target: CaptureTaskTarget,
  leaseToken: string,
  page: { kind: OwnedProviderTabKind },
): Promise<PreparedCaptureAttempt> {
  return withCaptureAndRunLock(target.runId, target.provider, async () => {
    const [job, run] = await Promise.all([getJob(target.id), getRun(target.runId)]);
    if (!job || job.state !== 'leased' || job.leaseToken !== leaseToken) return { kind: 'stale' };
    const providerRun = run?.providerRuns[target.provider];
    if (!run || !providerRun) {
      job.state = 'orphaned';
      job.orphanedAt ??= Date.now();
      job.leasedAt = undefined;
      job.leaseToken = undefined;
      await putJob(job);
      return { kind: 'stale' };
    }
    const navigatedAway = page.kind === 'different_conversation' || page.kind === 'external';
    let forceDomFallback = Boolean(job.tabUnavailable
      || isTerminalProviderStatus(providerRun.status)
      || job.attempts >= MAX_CAPTURE_ATTEMPTS
      || (job.deferredForNavigation && Date.now() - (job.deferredAt ?? job.createdAt) >= NAVIGATION_DEFERRAL_MS));
    if (page.kind === 'unavailable') {
      job.tabUnavailable = true;
      forceDomFallback = true;
    } else if (navigatedAway) {
      forceDomFallback = true;
    } else if (page.kind === 'recoverable' && !forceDomFallback) {
      job.deferredForNavigation = true;
      job.deferredAt ??= Date.now();
      job.state = 'queued';
      job.leasedAt = undefined;
      job.leaseToken = undefined;
      await putJob(job);
      let notify = false;
      if (!isTerminalProviderStatus(providerRun.status)) {
        notify = providerRun.detachedAt === undefined;
        assertTransition(providerRun.status, 'manual_required');
        rememberDetachedSetupPhase(providerRun);
        providerRun.status = 'manual_required';
        providerRun.statusDetail = `Return to the original ${ADAPTERS[target.provider].label} conversation to finish saving.`;
        providerRun.detachedAt ??= Date.now();
        run.status = deriveRunStatus(run);
        await putRun(run);
      }
      return { kind: 'deferred', run, notify };
    } else if (page.kind === 'original' && job.deferredForNavigation) {
      job.deferredForNavigation = undefined;
      job.deferredAt = undefined;
    }
    if (!isTerminalProviderStatus(providerRun.status) && providerRun.status !== 'capturing') {
      if (!canTransition(providerRun.status, 'capturing')) {
        await deleteJob(job.id);
        return { kind: 'discarded' };
      }
      providerRun.status = 'capturing';
      providerRun.statusDetail = undefined;
      run.status = deriveRunStatus(run);
      await putRun(run);
    }
    if (job.attempts < MAX_CAPTURE_ATTEMPTS) job.attempts += 1;
    await putJob(job);
    return { kind: 'ready', job: structuredClone(job), navigatedAway, forceDomFallback };
  });
}

async function handleCaptureTaskFailure(
  target: CaptureTaskTarget,
  leaseToken: string,
  error: unknown,
  navigatedAway: boolean,
): Promise<void> {
  const outcome = await withCaptureAndRunLock(target.runId, target.provider, async () => {
    const [job, run] = await Promise.all([getJob(target.id), getRun(target.runId)]);
    if (!job || job.state !== 'leased' || job.leaseToken !== leaseToken) return { kind: 'stale' } as const;
    const providerRun = run?.providerRuns[target.provider];
    if (!run || !providerRun) {
      job.state = 'orphaned';
      job.orphanedAt ??= Date.now();
      job.leasedAt = undefined;
      job.leaseToken = undefined;
      await putJob(job);
      return { kind: 'stale' } as const;
    }
    if (job.attempts < MAX_CAPTURE_ATTEMPTS) {
      job.state = 'leased';
      job.leasedAt = Date.now();
      job.leaseToken = undefined;
      await putJob(job);
      return { kind: 'retry_later' } as const;
    }
    if (isUsableCaptureJobReport(job)) {
      job.state = 'paused';
      job.leasedAt = undefined;
      job.leaseToken = undefined;
      job.tabUnavailable = true;
      job.deferredForNavigation = undefined;
      job.deferredAt = undefined;
      await putJob(job);
      providerRun.captureReviewPending = undefined;
      providerRun.captureRecoveryInProgress = undefined;
      providerRun.captureRecoveryPending = true;
      let terminalized = false;
      if (!isTerminalProviderStatus(providerRun.status)) {
        providerRun.status = 'failed';
        providerRun.statusDetail = CAPTURE_STORAGE_FAILURE_DETAIL;
        providerRun.completedAt ??= Date.now();
        run.status = deriveRunStatus(run);
        terminalized = true;
      }
      await putRun(run);
      return { kind: 'paused', run, terminalized } as const;
    }
    await deleteJob(job.id);
    let terminalized = false;
    if (!isTerminalProviderStatus(providerRun.status)) {
      providerRun.status = navigatedAway ? 'interrupted' : 'failed';
      providerRun.statusDetail = navigatedAway
        ? 'Provider tab navigated away before clipboard capture completed.'
        : error instanceof Error ? error.message : String(error);
      providerRun.completedAt ??= Date.now();
      run.status = deriveRunStatus(run);
      await putRun(run);
      terminalized = true;
    }
    return { kind: 'failed', terminalized } as const;
  });
  if (outcome.kind === 'retry_later') {
    console.error(`Capture job attempt failed for ${target.provider}; retaining its DOM fallback.`, error);
    return;
  }
  if (outcome.kind === 'paused') {
    if (outcome.terminalized) await settleProvider(target.runId, target.provider);
    else await broadcastRuns();
    await createPlatform().notify(
      `attention:${target.runId}:${target.provider}`,
      `${ADAPTERS[target.provider].label} report needs a retry`,
      'A verified report was retained, but capture storage failed. Retry the report from history.',
    ).catch(() => undefined);
    console.error(`Could not persist the verified ${target.provider} DOM report.`, error);
  } else if (outcome.kind === 'failed' && outcome.terminalized) {
    await settleProvider(target.runId, target.provider);
  }
}

async function runCaptureTask(target: CaptureTaskTarget, leaseToken: string): Promise<void> {
  const platform = createPlatform();
  const claim = await claimCaptureTask(target, leaseToken);
  if (claim.kind === 'none') return;
  if (claim.kind === 'link') {
    await completeProviderCapture(target.runId, target.provider, target.id);
    return;
  }
  const page = claim.job.tabUnavailable
    ? { kind: 'unavailable' } as const
    : await classifyOwnedProviderTab(claim.providerRun);
  const attempt = await prepareCaptureAttempt(target, leaseToken, page);
  if (attempt.kind === 'stale' || attempt.kind === 'discarded') return;
  if (attempt.kind === 'deferred') {
    if (attempt.notify) await platform.notify(
      `attention:${target.runId}:${target.provider}`,
      `${ADAPTERS[target.provider].label} needs your input`,
      attempt.run.providerRuns[target.provider]!.statusDetail!,
    ).catch(() => undefined);
    return;
  }
  try {
    const copied = attempt.forceDomFallback ? undefined : await clipboardCapture(platform, attempt.job);
    const capture = await persistCaptureJob(attempt.job, copied);
    const committed = await withCaptureAndRunLock(target.runId, target.provider, () => commitCaptureJob({
      id: target.id,
      runId: target.runId,
      provider: target.provider,
      capture,
      expectedLeaseToken: leaseToken,
      interruptForNavigation: attempt.navigatedAway,
    }));
    if (committed.outcome === 'committed') {
      await settleProvider(target.runId, target.provider, committed.completed);
    }
  } catch (error) {
    await handleCaptureTaskFailure(target, leaseToken, error, attempt.navigatedAway);
  }
}

function scheduleCaptureTask(target: CaptureTaskTarget, supersede = false): void {
  if (activeCaptureTaskGenerations.has(target.id) && !supersede) {
    captureTaskRerunIds.add(target.id);
    return;
  }
  const generation = crypto.randomUUID();
  const taskKey = `${target.id}\u0000${generation}`;
  const promise = runCaptureTask(target, generation)
    .catch((error) => console.error(`Capture task failed for ${target.provider}.`, error))
    .finally(() => {
      activeCaptureTasks.delete(taskKey);
      if (activeCaptureTaskGenerations.get(target.id) === generation) {
        activeCaptureTaskGenerations.delete(target.id);
        if (captureTaskRerunIds.delete(target.id)) scheduleCaptureTask(target);
      }
    });
  activeCaptureTaskGenerations.set(target.id, generation);
  activeCaptureTasks.set(taskKey, promise);
}

async function processCaptureQueuePass(): Promise<void> {
  let cursor: CaptureJobCursor | undefined;
  for (;;) {
    const job = await nextCaptureJob(cursor);
    if (!job) return;
    cursor = { createdAt: job.createdAt, id: job.id };
    scheduleCaptureTask({ id: job.id, runId: job.runId, provider: job.provider });
  }
}

function requestCaptureQueueScan(): void {
  captureScanRequested = true;
  if (captureScanPromise) return;
  const worker = (async () => {
    while (captureScanRequested) {
      captureScanRequested = false;
      await processCaptureQueuePass();
    }
  })();
  let tracked: Promise<void>;
  tracked = worker.catch((error) => {
    console.error('Could not scan the capture queue.', error);
  }).finally(() => {
    if (captureScanPromise === tracked) captureScanPromise = undefined;
    if (captureScanRequested) requestCaptureQueueScan();
  });
  captureScanPromise = tracked;
}

async function waitForCaptureQueueIdle(): Promise<void> {
  requestCaptureQueueScan();
  for (;;) {
    const scan = captureScanPromise;
    if (scan) await scan;
    const tasks = [...activeCaptureTasks.values()];
    if (tasks.length) await Promise.all(tasks);
    if (!captureScanPromise && activeCaptureTasks.size === 0 && !captureScanRequested) return;
  }
}

async function processCaptureQueue(): Promise<void> {
  await waitForCaptureQueueIdle();
}

async function queueCapture(
  request: Extract<RuntimeRequest, { type: 'content:capture' }>,
  sender: Browser.runtime.MessageSender = {},
): Promise<Run> {
  const id = captureId(request.runId, request.provider);
  let run: Run;
  try {
    run = await withCaptureAndRunLock(request.runId, request.provider, async () => {
      const existingJob = await getJob(id);
      const job: CaptureJob = {
        id,
        runId: request.runId,
        provider: request.provider,
        conversationKey: request.conversationKey,
        tabId: 0,
        state: 'queued',
        createdAt: Date.now(),
        attempts: 0,
        domMarkdown: request.domMarkdown,
        domCitations: request.domCitations,
        researchTrail: request.researchTrail,
        title: request.title,
        copyControlObserved: request.copyControlObserved,
      };
      // The DB validator fills the tab ID from the same run version it commits.
      return acceptCaptureJob(job, (storedRun) => {
        if (!storedRun) throw new CoordinatorRequestError('Run not found for capture.', 'run_not_found');
        const provider = storedRun.providerRuns[request.provider];
        if (!provider) throw new CoordinatorRequestError('Provider run not found for capture.', 'run_not_found');
        const verifiedPage = verifyContentPage(provider, sender, request.conversationKey);
        validateProviderTransition(provider, 'capturing');
        const existingConversationKey = normalizeConversationKey(existingJob?.conversationKey, request.provider);
        if (existingConversationKey && (!verifiedPage.conversationKey
          || !conversationKeysMatch(existingConversationKey, verifiedPage.conversationKey, request.provider))) {
          throw new CoordinatorRequestError(
            'Capture rejected because the queued job belongs to a different conversation.',
            'conversation_mismatch',
            providerSnapshot(provider),
          );
        }
        const verifiedConversationKey = verifiedPage.conversationKey ?? existingConversationKey;
        provider.conversationKey = verifiedConversationKey;
        job.tabId = provider.tabId;
        job.conversationKey = verifiedConversationKey;
        provider.status = 'capturing';
        provider.statusDetail = undefined;
        provider.captureReviewPending = undefined;
        provider.captureRecoveryPending = undefined;
        provider.captureRecoveryInProgress = undefined;
        storedRun.status = deriveRunStatus(storedRun);
        return storedRun;
      });
    });
  } catch (error) {
    if (!(error instanceof CaptureJobReviewRequiredError)) throw error;
    const storedRun = await getRun(request.runId);
    const providerRun = storedRun?.providerRuns[request.provider];
    await broadcastRuns().catch((broadcastError) => console.error('Could not broadcast capture review state.', broadcastError));
    throw new CoordinatorRequestError(
      error.message,
      'capture_review_required',
      providerRun ? providerSnapshot(providerRun) : undefined,
    );
  }
  void broadcastRuns().catch((error) => console.error('Could not broadcast accepted capture.', error));
  requestCaptureQueueScan();
  return run;
}

interface ArtifactSaveResult {
  saved: boolean;
  receipt?: ArtifactSaveReceipt;
}

function failureArtifactRevision(providerRun: ProviderRun): string {
  return `failure:${providerRun.status}:${providerRun.completedAt ?? 0}:${providerRun.statusDetail ?? ''}`;
}

async function commitArtifactReceipt(
  runId: string,
  provider: ProviderId,
  revision: string,
  receipt: ArtifactSaveReceipt,
): Promise<boolean> {
  return (await mutateStoredRun(runId, (storedRun) => {
    const current = storedRun.providerRuns[provider];
    if (!current || current.artifactRevision !== revision || !isTerminalProviderStatus(current.status)) return false;
    current.saveReceipt = receipt;
    return true;
  })).value;
}

async function saveProviderArtifact(runId: string, provider: ProviderId, force = false): Promise<ArtifactSaveResult> {
  return serializeByKey(artifactSaveMutationTails, `${runId}:${provider}`, async () => {
    for (let revisionAttempt = 0; revisionAttempt < 5; revisionAttempt += 1) {
      let run = await getRun(runId);
      let providerRun = run?.providerRuns[provider];
      if (!run || !providerRun || !isTerminalProviderStatus(providerRun.status)) return { saved: false };
      if (!force && providerRun.artifactRevision
        && providerRun.saveReceipt?.artifactRevision === providerRun.artifactRevision) {
        return { saved: false, receipt: providerRun.saveReceipt };
      }

      const capture = await getCapture(providerRun.captureId);
      const revision = capture?.revision ?? failureArtifactRevision(providerRun);
      if (providerRun.artifactRevision !== revision) {
        const updated = await mutateStoredRun(runId, (storedRun) => {
          const current = storedRun.providerRuns[provider];
          if (!current || !isTerminalProviderStatus(current.status)) return;
          current.artifactRevision = revision;
          if (current.saveReceipt?.artifactRevision
            && current.saveReceipt.artifactRevision !== revision) current.saveReceipt = undefined;
        });
        run = updated.run;
        providerRun = run.providerRuns[provider];
        if (!providerRun || !isTerminalProviderStatus(providerRun.status)) return { saved: false };
      }
      const filename = capture ? `${provider}.md` : `FAILED-${provider}.md`;
      if (!force && providerRun.saveReceipt
        && !providerRun.saveReceipt.artifactRevision) {
        const migrated = { ...providerRun.saveReceipt, artifactRevision: revision };
        if (await commitArtifactReceipt(runId, provider, revision, migrated)) {
          return { saved: false, receipt: migrated };
        }
      }
      const settings = await loadSettings();
      const artifact = buildArtifact(run, providerRun, capture, { includeSourceSnippets: settings.includeSourceSnippets });
      let fallbackReason: ArtifactSaveFallbackReason | undefined;
      let directoryConfig: ReportDirectoryConfig | undefined;
      try { directoryConfig = await getReportDirectoryConfig(); }
      catch { fallbackReason = 'directory_unavailable'; }

      if (directoryConfig) {
        const permission = await queryDirectoryPermission(directoryConfig.handle);
        if (permission === 'granted') {
          let path: Awaited<ReturnType<typeof writeUniqueMarkdown>> | undefined;
          try {
            path = await writeUniqueMarkdown(directoryConfig.handle, run.reportFolder, filename, artifact);
          } catch (error) {
            fallbackReason = classifyDirectoryError(error);
          }
          if (path) {
            const receipt: ArtifactSaveReceipt = {
              destination: 'directory',
              ...path,
              savedAt: Date.now(),
              artifactRevision: revision,
            };
            // Receipt persistence is intentionally outside the filesystem catch:
            // a database failure must not cause a second Downloads copy.
            if (await commitArtifactReceipt(runId, provider, revision, receipt)) {
              await markReportDirectoryNeedsReconnect(directoryConfig, false).catch(() => undefined);
              return { saved: true, receipt };
            }
            continue;
          }
        } else {
          fallbackReason = 'permission_required';
        }
        if (fallbackReason === 'write_failed') {
          await markReportDirectoryWriteFailure(directoryConfig).catch(() => undefined);
        } else if (fallbackReason) {
          await markReportDirectoryNeedsReconnect(directoryConfig, true).catch(() => undefined);
        }
      }

      const requestedRelativePath = `${run.downloadFolder}/${filename}`;
      const downloadId = await createPlatform().downloadText(requestedRelativePath, artifact);
      const receipt: ArtifactSaveReceipt = {
        destination: 'downloads',
        requestedRelativePath,
        savedAt: Date.now(),
        downloadId,
        artifactRevision: revision,
        ...(fallbackReason ? { fallbackReason } : {}),
      };
      if (await commitArtifactReceipt(runId, provider, revision, receipt)) return { saved: true, receipt };
    }
    throw new Error(`Could not save a stable ${provider} artifact revision.`);
  });
}

async function maybeFinalize(runId: string, skipSaveProviders: ReadonlySet<ProviderId> = new Set()): Promise<void> {
  if (finalizingRunIds.has(runId)) return;
  finalizingRunIds.add(runId);
  try {
    if (!await getRun(runId)) return;
    const { run, value: shouldFinalize } = await mutateStoredRun(runId, (storedRun) => {
      const providerRuns = Object.values(storedRun.providerRuns);
      if (!providerRuns.length || !providerRuns.every((item) => isTerminalProviderStatus(item.status)) || storedRun.completedAt) return false;
      storedRun.status = 'finalizing';
      return true;
    });
    if (!shouldFinalize) return;
    const providerRuns = Object.values(run.providerRuns);
    const failedSaves: string[] = [];
    for (const provider of PROVIDERS) {
      if (!run.providerRuns[provider]) continue;
      if (skipSaveProviders.has(provider)) {
        failedSaves.push(provider);
        continue;
      }
      try { await saveProviderArtifact(run.id, provider); } catch { failedSaves.push(provider); }
    }
    const { run: completedRun } = await mutateStoredRun(run.id, (storedRun) => {
      storedRun.status = 'complete';
      storedRun.completedAt = Date.now();
    });
    if (completedRun.tabGroupId !== undefined) await browser.tabGroups.update(completedRun.tabGroupId, { collapsed: true }).catch(() => undefined);
    await pruneExpiredRedirects().catch((error) => console.error('Could not prune expired redirects.', error));
    const savedProviderRuns = Object.values(completedRun.providerRuns);
    const count = savedProviderRuns.filter((item) => item.saveReceipt).length;
    const fallbackCount = savedProviderRuns.filter((item) => item.saveReceipt?.fallbackReason).length;
    const fallbackText = fallbackCount ? ` ${fallbackCount} used Downloads fallback.` : '';
    const failureText = failedSaves.length ? ' Retry failed saves from history.' : '';
    await createPlatform().notify(`run:${run.id}`, 'Research run complete', `${count} of ${providerRuns.length} files saved.${fallbackText}${failureText}`);
  } catch (error) {
    if (!(error instanceof CoordinatorRequestError && error.code === 'run_not_found')) throw error;
  } finally {
    finalizingRunIds.delete(runId);
  }
}

async function settleProvider(
  runId: string,
  provider: ProviderId,
  notifyComplete = false,
): Promise<void> {
  const currentRun = await getRun(runId);
  if (!currentRun) {
    await broadcastRuns().catch(() => undefined);
    return;
  }
  const stoppedProvider = currentRun.providerRuns[provider];
  const browserSessionId = await getBrowserSessionId();
  if (currentRun.browserSessionId === browserSessionId
    && stoppedProvider && isTerminalProviderStatus(stoppedProvider.status)) {
    await sendTabEvent(stoppedProvider.tabId, { type: 'content:stop', runId }).catch(() => undefined);
  }
  let saveFailed = false;
  await saveProviderArtifact(runId, provider).catch((error) => {
    saveFailed = true;
    console.error(`Could not immediately save the ${provider} artifact.`, error);
  });
  if (notifyComplete) {
    await createPlatform().notify(
      `complete:${runId}:${provider}`,
      `${ADAPTERS[provider].label} finished`,
      'The normalized report is ready.',
    ).catch(() => undefined);
  }
  await maybeFinalize(runId, saveFailed ? new Set([provider]) : undefined);
  await broadcastRuns();
}

async function markCaptureJobTabUnavailable(runId: string, provider: ProviderId): Promise<boolean> {
  const id = captureId(runId, provider);
  return serializeCapture(id, async () => {
    const job = await getJob(id);
    if (!job || job.state === 'paused' || job.state === 'orphaned') return false;
    job.tabUnavailable = true;
    job.deferredForNavigation = undefined;
    job.deferredAt = undefined;
    job.state = 'queued';
    job.leasedAt = undefined;
    job.leaseToken = undefined;
    await putJob(job);
    return true;
  });
}

async function unblockNavigationDeferredCapture(runId: string, provider: ProviderId): Promise<boolean> {
  const id = captureId(runId, provider);
  return serializeCapture(id, async () => {
    const job = await getJob(id);
    if (!job?.deferredForNavigation) return false;
    job.deferredForNavigation = undefined;
    job.deferredAt = undefined;
    job.state = 'queued';
    job.leasedAt = undefined;
    job.leaseToken = undefined;
    await putJob(job);
    return true;
  });
}

async function endProvider(runId: string, provider: ProviderId, allowFinished = false): Promise<void> {
  const existing = await getRun(runId);
  const existingProvider = existing?.providerRuns[provider];
  if (!existing || !existingProvider) throw new Error('Provider run not found.');
  const currentSession = existing.browserSessionId === await getBrowserSessionId();
  if (isTerminalProviderStatus(existingProvider.status)) {
    if (allowFinished && currentSession) {
      await sendTabEvent(existingProvider.tabId, { type: 'content:stop', runId }).catch(() => undefined);
      return;
    }
    if (allowFinished) return;
    throw new CoordinatorRequestError('Provider run has ended.', 'provider_terminal', providerSnapshot(existingProvider));
  }
  if (currentSession) await sendTabEvent(existingProvider.tabId, { type: 'content:stop', runId }).catch(() => undefined);
  if (await markCaptureJobTabUnavailable(runId, provider)) {
    scheduleCaptureTask({ id: captureId(runId, provider), runId, provider }, true);
    requestCaptureQueueScan();
    return;
  }
  const { value: ended } = await mutateStoredRun(runId, (storedRun) => {
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
  await settleProvider(runId, provider);
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

function recoveryNeedsNormalization(recovery: CaptureRecoveryInspection, provider: ProviderId): boolean {
  if (recovery.kind === 'missing_owner' || recovery.kind === 'saved_capture') return false;
  const providerRun = recovery.run.providerRuns[provider]!;
  if (recovery.kind === 'review_required') {
    return !providerRun.captureReviewPending || Boolean(providerRun.captureRecoveryPending
      || providerRun.captureRecoveryInProgress);
  }
  if (recovery.kind === 'unavailable') {
    return recovery.jobExists || Boolean(providerRun.captureReviewPending
      || providerRun.captureRecoveryPending || providerRun.captureRecoveryInProgress);
  }
  if (recovery.job.state === 'paused') {
    return !providerRun.captureRecoveryPending || Boolean(providerRun.captureReviewPending
      || providerRun.captureRecoveryInProgress)
      || !isTerminalProviderStatus(providerRun.status);
  }
  return Boolean(providerRun.captureReviewPending
    || (providerRun.captureRecoveryPending && !providerRun.captureRecoveryInProgress));
}

async function resumeProviderAfterRecoveryRemoval(
  runInput: Run,
  provider: ProviderId,
  restoreFailedCapture: boolean,
): Promise<boolean> {
  if (runInput.browserSessionId !== await getBrowserSessionId()) return false;
  const providerInput = runInput.providerRuns[provider];
  if (!providerInput || (await classifyOwnedProviderTab(providerInput)).kind !== 'original') return false;
  let run = runInput;
  if (restoreFailedCapture) {
    const updated = await mutateStoredRun(runInput.id, (storedRun) => {
      const current = storedRun.providerRuns[provider];
      if (!current || current.status !== 'failed'
        || current.captureRecoveryPending || current.captureRecoveryInProgress || current.captureReviewPending) return false;
      current.status = 'capturing';
      current.statusDetail = 'Retained report recovery was cleared; monitoring resumed.';
      current.completedAt = undefined;
      storedRun.completedAt = undefined;
      storedRun.status = deriveRunStatus(storedRun);
      return true;
    });
    run = updated.run;
  }
  const current = run.providerRuns[provider];
  if (!current || isTerminalProviderStatus(current.status)) return false;
  await startContent(run, provider, true);
  return true;
}

async function reconcileCaptureRecoveryRecords(
  runId: string,
  provider: ProviderId,
): Promise<boolean> {
  const id = captureId(runId, provider);
  let recovery: CaptureRecoveryInspection | CaptureRecoveryNormalization = await inspectCaptureRecovery(id, runId, provider);
  if (recovery.kind === 'saved_capture') {
    scheduleCaptureTask({ id, runId, provider }, true);
    return false;
  }
  if (recoveryNeedsNormalization(recovery, provider)) {
    recovery = await withCaptureAndRunLock(runId, provider, () => normalizeCaptureRecovery(id, runId, provider));
  }
  if (recovery.kind === 'usable_job' && recovery.job.state !== 'paused') requestCaptureQueueScan();
  if (recovery.kind !== 'missing_owner' && 'resumeRecommended' in recovery && recovery.resumeRecommended) {
    await resumeProviderAfterRecoveryRemoval(recovery.run, provider, true);
  }
  return 'changed' in recovery ? recovery.changed : false;
}

async function reconcileRuns(): Promise<void> {
  if (reconcileWorkerRunning) return;
  reconcileWorkerRunning = true;
  try {
    const browserSessionId = await getBrowserSessionId();
    const pendingRuns = await listRuns();
    const pausedJobIds = new Set(await listPausedCaptureJobIds());
    let recoveryChanged = false;
    for (const snapshot of pendingRuns) for (const providerRun of Object.values(snapshot.providerRuns)) {
      const id = captureId(snapshot.id, providerRun.provider);
      const paused = pausedJobIds.has(id);
      if (paused || providerRun.captureRecoveryPending || providerRun.captureRecoveryInProgress
        || providerRun.captureReviewPending) {
        try {
          const changed = await reconcileCaptureRecoveryRecords(snapshot.id, providerRun.provider);
          recoveryChanged ||= changed;
        }
        catch (error) { console.error('Could not reconcile retained capture state.', error); }
      }
    }
    if (recoveryChanged) {
      await broadcastRuns().catch((error) => console.error('Could not broadcast reconciled capture recovery.', error));
    }
    const runs = await listRuns();
    setKnownRunTabs(runs);
    for (const snapshot of runs.filter((item) => item.status !== 'complete' || item.completedAt === undefined)) {
      if (snapshot.browserSessionId !== browserSessionId) {
        for (const providerRun of Object.values(snapshot.providerRuns)) {
          if (isTerminalProviderStatus(providerRun.status)) continue;
          const id = captureId(snapshot.id, providerRun.provider);
          const recovery = await inspectCaptureRecovery(id, snapshot.id, providerRun.provider);
          if (recovery.kind === 'saved_capture') {
            scheduleCaptureTask({ id, runId: snapshot.id, provider: providerRun.provider }, true);
            continue;
          }
          const captureQueued = await markCaptureJobTabUnavailable(snapshot.id, providerRun.provider);
          const { run: reconciledRun } = await mutateStoredRun(snapshot.id, (storedRun) => {
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
          if (isTerminalProviderStatus(reconciledRun.providerRuns[providerRun.provider]!.status)) {
            await settleProvider(snapshot.id, providerRun.provider);
          }
        }
        continue;
      }
      for (const providerRun of Object.values(snapshot.providerRuns)) {
        if (isTerminalProviderStatus(providerRun.status)) continue;
        if (providerRun.captureReviewPending || providerRun.captureRecoveryInProgress) continue;
        const page = await classifyOwnedProviderTab(providerRun);
        const providerPage = page.kind === 'original';
        const valid = providerPage || page.kind === 'recoverable';
        if (page.kind === 'recoverable' && providerRun.detachedAt === undefined) {
          await mutateStoredRun(snapshot.id, (storedRun) => {
            const current = storedRun.providerRuns[providerRun.provider];
            if (!current || isTerminalProviderStatus(current.status)) return;
            assertTransition(current.status, 'manual_required');
            rememberDetachedSetupPhase(current);
            current.status = 'manual_required';
            current.statusDetail = `Return to the original ${ADAPTERS[providerRun.provider].label} conversation to continue monitoring.`;
            current.detachedAt = Date.now();
            storedRun.status = deriveRunStatus(storedRun);
          });
        }
        if (!valid && page.kind === 'unavailable'
          && await markCaptureJobTabUnavailable(snapshot.id, providerRun.provider)) continue;
        if (page.kind === 'different_conversation' || page.kind === 'external') {
          await unblockNavigationDeferredCapture(snapshot.id, providerRun.provider);
        }
        const checkedRun = await recordReconcileCheck(snapshot.id, providerRun.provider, valid);
        const checkedProviderRun = checkedRun.providerRuns[providerRun.provider];
        if (checkedProviderRun && isTerminalProviderStatus(checkedProviderRun.status)) {
          await settleProvider(snapshot.id, providerRun.provider);
        }
        if (providerPage && checkedProviderRun && !isTerminalProviderStatus(checkedProviderRun.status)) {
          let currentRun = checkedRun;
          if (checkedProviderRun.detachedAt !== undefined) {
            currentRun = await restoreDetachedSetupPhase(snapshot.id, providerRun.provider);
          }
          await unblockNavigationDeferredCapture(snapshot.id, providerRun.provider);
          await startContent(currentRun, providerRun.provider, shouldResumeContentOnly(currentRun.providerRuns[providerRun.provider]!.status));
        }
      }
    }
    requestCaptureQueueScan();
    await pruneExpiredRedirects().catch((error) => console.error('Could not prune expired redirects.', error));
    for (const snapshot of runs) {
      const latest = await getRun(snapshot.id);
      if (latest && latest.completedAt === undefined) await maybeFinalize(latest.id);
    }
    const latestRuns = await listRuns();
    if (JSON.stringify(latestRuns) !== JSON.stringify(runs)) await broadcastRuns();
    else await updateBadge(latestRuns);
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
      scheduleCaptureTask({
        id: captureId(match.runId, match.provider), runId: match.runId, provider: match.provider,
      }, true);
      continue;
    }
    const { value: interrupted } = await mutateStoredRun(match.runId, (storedRun) => {
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
    await settleProvider(match.runId, match.provider);
  }
  requestCaptureQueueScan();
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
        for (const providerRun of Object.values(run.providerRuns)) {
          await endProvider(run.id, providerRun.provider, true);
        }
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
        await withClipboardLock(() => createPlatform().writeClipboard(
          buildArtifact(run, providerRun, capture, { includeSourceSnippets: settings.includeSourceSnippets }),
        ));
        await mutateStoredRun(run.id, (storedRun) => {
          const storedProviderRun = storedRun.providerRuns[message.provider];
          if (storedProviderRun) storedProviderRun.copiedAt = Date.now();
        });
        await broadcastRuns(); return { ok: true };
      }
      case 'provider:copy-current': {
        const run = await getRun(message.runId);
        const providerRun = run?.providerRuns[message.provider];
        if (!run || !providerRun) throw new Error('Provider run not found.');
        const conversationKey = normalizeConversationKey(providerRun.conversationKey, message.provider);
        if (providerRun.conversationKey !== undefined && conversationKey === undefined) {
          throw new CoordinatorRequestError(
            'This run has an unrecognized legacy conversation identity.',
            'conversation_mismatch',
            providerSnapshot(providerRun),
          );
        }
        await copyCurrentResponse(providerRun.tabId, message.provider, {
          runId: run.id,
          conversationKey,
        });
        return { ok: true };
      }
      case 'provider:save': {
        const run = await getRun(message.runId);
        if (!run) throw new Error('Run not found.');
        await saveProviderArtifact(run.id, message.provider, true); await broadcastRuns(); return { ok: true };
      }
      case 'provider:retry-capture': {
        await retryPausedCapture(message.runId, message.provider);
        return { ok: true };
      }
      case 'provider:copy-retained-job': {
        const report = (await inspectCaptureJob(captureId(message.runId, message.provider))).retainedReport;
        if (!report) throw new CoordinatorRequestError('No blocked retained report is available.', 'invalid_transition');
        await withClipboardLock(() => createPlatform().writeClipboard(report));
        return { ok: true };
      }
      case 'provider:discard-blocked-job': {
        const id = captureId(message.runId, message.provider);
        const discarded = await withCaptureAndRunLock(message.runId, message.provider, () => (
          discardBlockedCaptureJob(id, message.runId, message.provider)
        ));
        if (discarded.outcome === 'state_changed') {
          await reconcileCaptureRecoveryRecords(message.runId, message.provider);
          await broadcastRuns().catch((error) => console.error('Could not broadcast reconciled capture review.', error));
          return { ok: true };
        }
        await resumeProviderAfterRecoveryRemoval(discarded.run, message.provider, discarded.resumeRecommended);
        await broadcastRuns().catch((error) => console.error('Could not broadcast discarded capture review.', error));
        return { ok: true };
      }
      case 'content:hello': {
        const tabId = sender.tab?.id;
        if (tabId !== undefined) {
          const runs = await listRuns();
          const browserSessionId = await getBrowserSessionId();
          const run = runs.find((candidate) => candidate.browserSessionId === browserSessionId
            && candidate.providerRuns[message.provider]?.tabId === tabId);
          const providerRun = run?.providerRuns[message.provider];
          if (run && providerRun) {
            const senderUrl = sender.url ?? sender.tab?.url;
            const page = senderUrl ? classifyProviderPage(senderUrl, message.provider) : { kind: 'unsupported' } as const;
            const original = (page.kind === 'entry' && providerRun.conversationKey === undefined)
              || (page.kind === 'conversation' && (!providerRun.conversationKey
                || conversationKeysMatch(providerRun.conversationKey, page.key, message.provider)));
            const restored = original && providerRun.detachedAt !== undefined
              ? await restoreDetachedSetupPhase(run.id, message.provider) : run;
            if (restored !== run) await broadcastRuns();
            void startContent(restored, message.provider, shouldResumeContentOnly(restored.providerRuns[message.provider]!.status));
          }
        }
        return { ok: true };
      }
      case 'content:state': {
        const run = await mutateProvider(
          message.runId, message.provider, message.status, message.detail,
          message.submittedAt, message.reason, message.conversationKey, sender,
        );
        return { ok: true, providerState: providerSnapshot(run.providerRuns[message.provider]!) };
      }
      case 'content:capture': {
        const run = await queueCapture(message, sender);
        return { ok: true, providerState: providerSnapshot(run.providerRuns[message.provider]!) };
      }
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
  void registerCopyCurrentContextMenu();
  browser.runtime.onInstalled.addListener(() => { void registerCopyCurrentContextMenu(); });
  browser.runtime.onStartup.addListener(() => { void reconcileRuns(); });
  browser.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM_NAME) void reconcileRuns(); });
  browser.runtime.onMessage.addListener((message: RuntimeRequest, sender) => handleRequest(message, sender));
  browser.omnibox.onInputChanged.addListener((text, suggest) => suggest([{ content: text, description: 'Deep research → ChatGPT, Claude, Gemini, Grok' }]));
  browser.omnibox.onInputEntered.addListener((query) => {
    void platform.openPanel(browser.windows.WINDOW_ID_CURRENT).catch(() => undefined);
    void createRun(query).catch(() => undefined);
  });
  action.onClicked.addListener((tab) => { void platform.openPanel(tab.windowId); });
  browser.contextMenus.onClicked.addListener((info, tab) => { void handleCopyCurrentContextMenu(info, tab); });
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
  startContent,
  queueCapture,
  getBrowserSessionId,
  handleRequest,
  serializeCapture,
  withRunLock,
  withCaptureAndRunLock,
  withClipboardLock,
  mutateStoredRun,
  maybeFinalize,
  recordReconcileCheck,
  interruptRemovedTab,
  resolveCitationUrls,
  copyCurrentResponse,
  registerCopyCurrentContextMenu,
  handleCopyCurrentContextMenu,
  isProviderUrl,
  isProviderAuthenticationUrl,
  markExpectedTabActivation,
  recordTabActivation,
  setKnownRunTabs,
  processCaptureQueue,
  waitForCaptureQueueIdle,
  completeProviderCapture,
  saveProviderArtifact,
  reconcileCaptureRecoveryRecords,
  reconcileRuns,
  resetBrowserSession: () => {
    browserSessionIdPromise = undefined;
    fallbackBrowserSessionId = undefined;
    runMutationTails.clear();
    captureMutationTails.clear();
    artifactSaveMutationTails.clear();
    clipboardMutationTails.clear();
    captureScanPromise = undefined;
    captureScanRequested = false;
    activeCaptureTasks.clear();
    activeCaptureTaskGenerations.clear();
    captureTaskRerunIds.clear();
    contextMenuRegistrationTail = Promise.resolve();
  },
  getLastNonRunInteractionAt: () => lastNonRunInteractionAt,
};
