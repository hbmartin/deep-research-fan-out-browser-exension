import { ADAPTERS } from './adapters';
import { buildArtifact } from './artifacts';
import { reconcileCitations } from './citations';
import { captureId, deleteJob, evictHistory, getCapture, getRedirect, getRun, listRuns, nextCaptureJob, putCapture, putJob, putRedirect, putRun } from './db';
import type { RuntimeRequest, RuntimeResponse } from './messages';
import { createPlatform, handleOffscreenResponse, sendTabEvent, type BrowserPlatform } from './platform';
import { loadSettings } from './settings';
import { assertTransition, createDownloadFolder, deriveRunStatus, slugify } from './state';
import { ATTENTION_PROVIDER_STATUSES, isTerminalProviderStatus, PROVIDERS, type Capture, type CaptureJob, type DomCitation, type ProviderId, type ProviderRun, type ProviderRunStatus, type Run } from './types';

const ALARM_NAME = 'reconcile-runs';
let captureWorkerRunning = false;
let lastNonRunInteractionAt = 0;
const knownRunTabIds = new Set<number>();

class CaptureDeferredError extends Error {}

function errorResponse(error: unknown): RuntimeResponse {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function composeQuery(query: string, appendString: string): string {
  return appendString.trim() ? `${query}\n${appendString}` : query;
}

async function broadcastRuns(): Promise<void> {
  const runs = await listRuns();
  knownRunTabIds.clear();
  for (const run of runs) for (const providerRun of Object.values(run.providerRuns)) knownRunTabIds.add(providerRun.tabId);
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

async function startContent(run: Run, provider: ProviderId): Promise<void> {
  const providerRun = run.providerRuns[provider];
  if (!providerRun || isTerminalProviderStatus(providerRun.status)) return;
  const settings = await loadSettings();
  const event = {
    type: 'content:start',
    runId: run.id,
    provider,
    query: run.query,
    appendString: providerRun.appendString,
    geminiAutoApprove: settings.geminiAutoApprove,
    completionDebounceMs: settings.providers[provider].completionDebounceMs,
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

async function createRun(queryInput: string, requestedWindowId?: number): Promise<Run> {
  const query = queryInput.trim();
  if (!query) throw new Error('Enter a research query.');
  const settings = await loadSettings();
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
    query,
    createdAt: now,
    windowId: currentWindow.id,
    providerRuns,
    status: 'active',
    slug,
    downloadFolder: createDownloadFolder(settings.downloadRoot, now, slug),
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
  const run = await getRun(runId);
  if (!run) throw new Error('Run not found.');
  const providerRun = run.providerRuns[provider];
  if (!providerRun) throw new Error('Provider is not part of this run.');
  assertTransition(providerRun.status, status);
  providerRun.status = status;
  providerRun.statusDetail = detail;
  if (submittedAt) providerRun.submittedAt = submittedAt;
  if (isTerminalProviderStatus(status)) providerRun.completedAt = Date.now();
  run.status = deriveRunStatus(run);
  await putRun(run);
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
  if (provider !== 'gemini') return { citations, resolved: 0, unresolved: 0 };
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
  const attemptCapture = async (): Promise<{ text: string; restored: boolean }> => {
    let original = '';
    let hasSnapshot = false;
    try { original = await platform.readClipboard(); hasSnapshot = true; } catch { /* Continue without a snapshot. */ }
    await sendTabEvent(job.tabId, { type: 'capture:copy-now', jobId: job.id });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const copied = await platform.readClipboard();
    if (copied.trim().length < 40) throw new Error('Copied report was empty');
    let restored = false;
    if (settings.restoreClipboard && hasSnapshot) {
      const current = await platform.readClipboard();
      if (current === copied) {
        await platform.writeClipboard(original);
        restored = true;
      }
    }
    return { text: copied, restored };
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await attemptCapture(); }
    catch { await new Promise((resolve) => setTimeout(resolve, 300)); }
  }
  if (Date.now() - lastNonRunInteractionAt < 5000) throw new CaptureDeferredError('Waiting until the user is idle before focusing a provider tab.');
  const [current] = await browser.tabs.query({ active: true, currentWindow: true });
  try {
    await browser.tabs.update(job.tabId, { active: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    return await attemptCapture();
  } catch {
    return undefined;
  } finally {
    if (current?.id !== undefined && current.id !== job.tabId) await browser.tabs.update(current.id, { active: true }).catch(() => undefined);
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
      job.state = 'leased';
      job.leasedAt = Date.now();
      job.attempts += 1;
      await putJob(job);
      const run = await getRun(job.runId);
      const providerRun = run?.providerRuns[job.provider];
      if (!run || !providerRun || isTerminalProviderStatus(providerRun.status)) {
        await deleteJob(job.id);
        continue;
      }
      try {
        const copied = await clipboardCapture(platform, job);
        const rawMarkdown = copied?.text || job.domMarkdown;
        if (rawMarkdown.trim().length < 40) throw new Error('Clipboard and DOM capture were both empty.');
        const resolved = await resolveCitationUrls(job.provider, job.domCitations);
        const reconciled = reconcileCitations(rawMarkdown, resolved.citations, ADAPTERS[job.provider].citationMarkerStyle);
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
        };
        const id = captureId(run.id, job.provider);
        await putCapture(id, capture);
        providerRun.captureId = id;
        providerRun.degraded ||= !copied || reconciled.unplacedCitationCount > 0 || resolved.unresolved > 0;
        await putRun(run);
        await deleteJob(job.id);
        await mutateProvider(run.id, job.provider, 'complete');
      } catch (error) {
        if (error instanceof CaptureDeferredError) break;
        await deleteJob(job.id);
        await mutateProvider(run.id, job.provider, 'failed', error instanceof Error ? error.message : String(error));
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
  if (providerRun.status !== 'capturing') await mutateProvider(run.id, request.provider, 'capturing');
  await putJob({
    id: captureId(run.id, request.provider), runId: run.id, provider: request.provider,
    tabId: providerRun.tabId, state: 'queued', createdAt: Date.now(), attempts: 0,
    domMarkdown: request.domMarkdown, domCitations: request.domCitations, title: request.title,
  });
  void processCaptureQueue();
}

async function downloadProvider(run: Run, provider: ProviderId): Promise<void> {
  const providerRun = run.providerRuns[provider];
  if (!providerRun) return;
  const capture = await getCapture(providerRun.captureId);
  const artifact = buildArtifact(run, providerRun, capture);
  providerRun.downloadId = await createPlatform().downloadText(`${run.downloadFolder}/${provider}.md`, artifact);
  providerRun.downloadedAt = Date.now();
}

async function maybeFinalize(runInput: Run): Promise<void> {
  const run = await getRun(runInput.id) ?? runInput;
  const providerRuns = Object.values(run.providerRuns);
  if (!providerRuns.length || !providerRuns.every((item) => isTerminalProviderStatus(item.status)) || run.completedAt) return;
  run.status = 'finalizing';
  await putRun(run);
  const failedDownloads: string[] = [];
  for (const provider of PROVIDERS) {
    if (!run.providerRuns[provider]) continue;
    try { await downloadProvider(run, provider); } catch { failedDownloads.push(provider); }
  }
  run.status = 'complete';
  run.completedAt = Date.now();
  await putRun(run);
  if (run.tabGroupId !== undefined) await browser.tabGroups.update(run.tabGroupId, { collapsed: true }).catch(() => undefined);
  await evictHistory();
  const count = providerRuns.length - failedDownloads.length;
  await createPlatform().notify(`run:${run.id}`, 'Research run complete', `${count} of ${providerRuns.length} files saved${failedDownloads.length ? '; retry failed downloads from history.' : '.'}`);
}

async function endProvider(runId: string, provider: ProviderId): Promise<void> {
  const run = await getRun(runId);
  const providerRun = run?.providerRuns[provider];
  if (!run || !providerRun) throw new Error('Provider run not found.');
  if (!isTerminalProviderStatus(providerRun.status)) await mutateProvider(runId, provider, 'abandoned', 'Ended by the user.');
}

async function reconcileRuns(markInterrupted = false): Promise<void> {
  const runs = await listRuns();
  for (const run of runs.filter((item) => item.status !== 'complete')) {
    for (const providerRun of Object.values(run.providerRuns)) {
      if (isTerminalProviderStatus(providerRun.status)) continue;
      if (markInterrupted) {
        providerRun.status = 'interrupted';
        providerRun.statusDetail = 'Browser restarted before completion.';
        providerRun.completedAt = Date.now();
        continue;
      }
      try {
        const tab = await browser.tabs.get(providerRun.tabId);
        if (!tab.url?.startsWith(ADAPTERS[providerRun.provider].origin)) throw new Error('Provider tab navigated away.');
        await startContent(run, providerRun.provider);
      } catch {
        providerRun.status = 'interrupted';
        providerRun.statusDetail = 'Provider tab was closed or navigated away.';
        providerRun.completedAt = Date.now();
      }
    }
    run.status = deriveRunStatus(run);
    await putRun(run);
    await maybeFinalize(run);
  }
  await processCaptureQueue();
  await broadcastRuns();
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
        await createPlatform().writeClipboard(buildArtifact(run, providerRun, capture));
        providerRun.copiedAt = Date.now();
        await putRun(run); await broadcastRuns(); return { ok: true };
      }
      case 'provider:download': {
        const run = await getRun(message.runId);
        if (!run) throw new Error('Run not found.');
        await downloadProvider(run, message.provider); await putRun(run); await broadcastRuns(); return { ok: true };
      }
      case 'content:hello': {
        const tabId = sender.tab?.id;
        if (tabId !== undefined) {
          const runs = await listRuns();
          const run = runs.find((candidate) => Object.values(candidate.providerRuns).some((item) => item.tabId === tabId));
          if (run) void startContent(run, message.provider);
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
  browser.runtime.onInstalled.addListener(() => {
    void browser.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  });
  browser.runtime.onStartup.addListener(() => { void reconcileRuns(true); });
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
  browser.tabs.onRemoved.addListener(() => { void reconcileRuns(); });
  browser.tabs.onActivated.addListener(({ tabId }) => {
    if (!knownRunTabIds.has(tabId)) lastNonRunInteractionAt = Date.now();
  });
  void browser.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  void reconcileRuns();
}
