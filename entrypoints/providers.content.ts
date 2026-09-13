import TurndownService from 'turndown';
import { ADAPTERS, providerFromLocation, type ProviderAdapter, type SelectorChain } from '@/src/adapters';
import { cloneResponseContent, createFinalResponseBaseline, createResponseSnapshot, domCitationInventory, evaluateStableResponse, isClarifyingResponse, isNewFinalResponse, isProgressResponse, isQuotaResponse, mergeCitationInventories, shouldOpenSourceToggle, sourceToggleState, type FinalResponseBaseline, type StableResponseCandidate } from '@/src/dom-capture';
import { ContentMessageError, sendContentMessage } from '@/src/content-messaging';
import { injectQuery, submitWithEnter } from '@/src/injection';
import type { BackgroundEvent } from '@/src/messages';
import { findAll, findElement, isVisible } from '@/src/selectors';
import { captureGrokResearchTrail } from '@/src/sources';
import type { ProviderRunStatus, RunId } from '@/src/types';

interface ActiveRun {
  id: RunId;
  adapter: ProviderAdapter;
  submittedQuery: string;
  geminiAutoApprove: boolean;
  completionDebounceMs: number;
  status: ProviderRunStatus;
  submittedAt?: number;
  completionCandidate?: StableResponseCandidate;
  captureSent: boolean;
  finalResponseBaseline: FinalResponseBaseline;
  copyButtonBaseline: ReadonlySet<HTMLElement>;
  automationStarted: boolean;
}

let active: ActiveRun | undefined;
let observer: MutationObserver | undefined;
let sweepTimer: number | undefined;
let inspectionScheduled = false;
let captureInFlight = false;
let captureFailureCount = 0;
let captureRetryAt = 0;
let pendingReport: { runId: RunId; status: ProviderRunStatus; promise: Promise<void> } | undefined;
const RESEARCH_TIMEOUT_MS = 45 * 60 * 1000;
const RESPONSE_VISIBILITY = { ignoreAncestorAriaHidden: true, ignoreAncestorOpacity: true } as const;
const HOVER_COPY_VISIBILITY = { allowTransparent: true } as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function report(status: ProviderRunStatus, detail?: string, submittedAt?: number): Promise<void> {
  if (!active) return;
  const reportingRun = active;
  const effectiveSubmittedAt = submittedAt ?? (status === 'researching' && reportingRun.status !== 'researching' ? Date.now() : undefined);
  await sendContentMessage({
    type: 'content:state', runId: reportingRun.id, provider: reportingRun.adapter.id,
    status, detail, submittedAt: effectiveSubmittedAt,
  });
  if (active?.id !== reportingRun.id) return;
  active.status = status;
  if (effectiveSubmittedAt) active.submittedAt = effectiveSubmittedAt;
}

function reportEventually(status: ProviderRunStatus, detail?: string, submittedAt?: number): void {
  if (!active || (pendingReport?.runId === active.id && pendingReport.status === status)) return;
  const runId = active.id;
  const promise = report(status, detail, submittedAt);
  pendingReport = { runId, status, promise };
  void promise
    .catch((error) => console.error(`Could not report provider state ${status}.`, error))
    .finally(() => {
      if (pendingReport?.promise === promise) pendingReport = undefined;
    });
}

function reportTerminalEventually(status: 'interrupted' | 'quota_exhausted', detail: string): void {
  if (!active || (pendingReport?.runId === active.id && pendingReport.status === status)) return;
  const runId = active.id;
  const promise = report(status, detail);
  pendingReport = { runId, status, promise };
  void promise
    .then(() => stopMonitoring())
    .catch((error) => console.error(`Could not report provider state ${status}.`, error))
    .finally(() => {
      if (pendingReport?.promise === promise) pendingReport = undefined;
    });
}

function waitFor(predicate: () => HTMLElement | null, timeoutMs: number): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const immediate = predicate();
    if (immediate) return resolve(immediate);
    const started = Date.now();
    const localObserver = new MutationObserver(() => {
      const result = predicate();
      if (result) finish(result);
      else if (Date.now() - started >= timeoutMs) finish(null);
    });
    const poll = window.setInterval(() => {
      const result = predicate();
      if (result || Date.now() - started >= timeoutMs) finish(result);
    }, 250);
    function finish(result: HTMLElement | null) {
      localObserver.disconnect();
      clearInterval(poll);
      resolve(result);
    }
    localObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  });
}

async function prefillOnly(detail: string): Promise<void> {
  if (!active) return;
  const composer = findElement(active.adapter.selectors.composer);
  if (composer) await injectQuery(composer, active.adapter.composerKind, active.submittedQuery);
  await report('manual_required', detail);
  beginMonitoring();
}

async function automate(): Promise<void> {
  if (!active) return;
  const { adapter } = active;
  const submissionBaseline = active.finalResponseBaseline;
  await report('awaiting_ready');
  let composer: HTMLElement | null = null;
  for (let attempt = 0; attempt < 2 && !composer; attempt += 1) {
    if (findElement(adapter.selectors.loginWall)) return report('unauthenticated', `Not signed in to ${adapter.label}.`);
    if (findElement(adapter.selectors.quotaNotice, document, responseRoots(adapter))) {
      return report('quota_exhausted', `${adapter.label} deep research limit reached.`);
    }
    composer = await waitFor(() => findElement(adapter.selectors.composer), 15_000);
    if (!composer && attempt === 0) await delay(2000);
  }
  if (!composer) return prefillOnly('Page did not become ready after two attempts.');

  await report('setting_mode');
  if (!findElement(adapter.selectors.modeConfirmed)) {
    const entry = findElement(adapter.selectors.modeEntry);
    if (!entry) return prefillOnly('Could not find the deep research mode control.');
    entry.click();
    const option = await waitFor(() => findElement(adapter.selectors.modeOption), 3000);
    if (!option) return prefillOnly('Could not find the deep research mode option.');
    option.click();
    const confirmed = await waitFor(() => findElement(adapter.selectors.modeConfirmed), 3000);
    if (!confirmed) return prefillOnly('Could not confirm deep research mode. Set it manually and send.');
  }

  await report('submitting');
  if (!(await injectQuery(composer, adapter.composerKind, active.submittedQuery))) {
    return prefillOnly('Could not enter the complete query. Paste it manually.');
  }
  if (adapter.submitStrategy === 'enter') submitWithEnter(composer);
  else {
    const submit = findElement(adapter.selectors.submitButton);
    if (!submit || !isVisible(submit)) return prefillOnly('The send control was unavailable. Send the pre-filled query manually.');
    submit.click();
  }
  const submitted = await waitFor(() => {
    const text = composer instanceof HTMLTextAreaElement ? composer.value : composer.textContent ?? '';
    const streaming = findElement(adapter.selectors.streamingIndicator);
    const plan = adapter.selectors.planApproval && findElement(adapter.selectors.planApproval);
    const latestResponse = responseRoots(adapter).at(-1) ?? null;
    const responseStarted = isNewFinalResponse(latestResponse, submissionBaseline);
    return !text.trim() && (isInteractiveProgressIndicator(streaming) || plan || responseStarted) ? composer : null;
  }, 5000);
  if (!submitted) {
    await report('manual_required', 'The query may not have sent. Check the provider tab.');
    beginMonitoring();
    return;
  }
  await report('researching', undefined, Date.now());
  beginMonitoring();
}

function contentToMarkdown(content: HTMLElement): string {
  const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  turndown.addRule('removeUnsafe', { filter: ['form', 'input', 'textarea'], replacement: () => '' });
  return turndown.turndown(content).trim();
}

function responseRoots(adapter: ProviderAdapter): HTMLElement[] {
  return findAll(adapter.selectors.finalMessageRoot, document, RESPONSE_VISIBILITY);
}

function treeDistance(left: HTMLElement, right: HTMLElement): number {
  const leftAncestors = new Map<HTMLElement, number>();
  let distance = 0;
  for (let current: HTMLElement | null = left; current; current = current.parentElement) {
    leftAncestors.set(current, distance);
    distance += 1;
  }
  distance = 0;
  for (let current: HTMLElement | null = right; current; current = current.parentElement) {
    const leftDistance = leftAncestors.get(current);
    if (leftDistance !== undefined) return leftDistance + distance;
    distance += 1;
  }
  return Number.POSITIVE_INFINITY;
}

function owningResponse(candidate: HTMLElement, roots: readonly HTMLElement[]): HTMLElement | undefined {
  let owner: HTMLElement | undefined;
  let ownerDistance = Number.POSITIVE_INFINITY;
  let ownerIndex = -1;
  for (const [index, response] of roots.entries()) {
    const distance = treeDistance(candidate, response);
    if (distance < ownerDistance) {
      owner = response;
      ownerDistance = distance;
      ownerIndex = index;
      continue;
    }
    if (distance !== ownerDistance || !owner) continue;
    const responsePrecedesControl = Boolean(response.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING);
    const ownerPrecedesControl = Boolean(owner.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING);
    if ((responsePrecedesControl && !ownerPrecedesControl)
      || (responsePrecedesControl === ownerPrecedesControl
        && (responsePrecedesControl ? index > ownerIndex : index < ownerIndex))) {
      owner = response;
      ownerIndex = index;
    }
  }
  return owner;
}

function isInteractiveProgressIndicator(element: HTMLElement | null): boolean {
  return Boolean(element && (element instanceof HTMLButtonElement
    || element.getAttribute('role') === 'button'
    || (element instanceof HTMLInputElement && ['button', 'submit'].includes(element.type))));
}

export function findResponseControl(
  root: HTMLElement,
  responseRoots: readonly HTMLElement[],
  selectors: SelectorChain,
  baseline: ReadonlySet<HTMLElement> = new Set(),
  allowHoverTransparent = false,
): HTMLElement | null {
  const visibility = allowHoverTransparent ? HOVER_COPY_VISIBILITY : undefined;
  const candidates = findAll(selectors, document, visibility)
    .filter((candidate) => candidate.isConnected
      && getComputedStyle(candidate).pointerEvents !== 'none'
      && !candidate.closest('pre, code, table, [inert]')
      && !baseline.has(candidate));
  const scoped = candidates.filter((candidate) => root.contains(candidate));
  if (scoped.length) return scoped.at(-1)!;
  for (const candidate of [...candidates].reverse()) {
    if (owningResponse(candidate, responseRoots) === root) return candidate;
  }
  return null;
}

async function capture(root: HTMLElement): Promise<void> {
  if (!active || active.captureSent || captureInFlight) return;
  captureInFlight = true;
  const capturingRun = active;
  const initialSnapshot = createResponseSnapshot(root);
  const before = domCitationInventory(root, capturingRun.adapter);
  const roots = responseRoots(capturingRun.adapter);
  const toggle = capturingRun.adapter.selectors.sourcesPanelToggle
    ? findResponseControl(root, roots, capturingRun.adapter.selectors.sourcesPanelToggle)
    : null;
  const title = initialSnapshot.content.querySelector('h1, h2, h3')?.textContent?.trim();
  try {
    let after = before;
    const researchTrail = capturingRun.adapter.id === 'grok'
      ? await captureGrokResearchTrail(document, toggle)
      : undefined;
    if (capturingRun.adapter.id !== 'grok' && toggle && shouldOpenSourceToggle(toggle)) {
      const initialToggleState = sourceToggleState(toggle);
      toggle.click();
      const started = Date.now();
      do {
        await delay(100);
        after = domCitationInventory(root, capturingRun.adapter);
      } while (Date.now() - started < 1000 && after.length === before.length);
      toggle.click();
      if (initialToggleState === 'unknown' && after.length < before.length) after = before;
    }
    const refreshedSnapshot = root.isConnected ? createResponseSnapshot(root) : undefined;
    const finalContent = refreshedSnapshot && refreshedSnapshot.text.length >= initialSnapshot.text.length
      ? refreshedSnapshot.content
      : initialSnapshot.content;
    try {
      await sendContentMessage({
        type: 'content:capture',
        runId: capturingRun.id,
        provider: capturingRun.adapter.id,
        domMarkdown: contentToMarkdown(finalContent),
        domCitations: mergeCitationInventories(before, after),
        researchTrail,
        title,
      });
    } catch (error) {
      if (error instanceof ContentMessageError && error.code === 'provider_terminal') {
        if (active?.id === capturingRun.id) active.captureSent = true;
        stopMonitoring();
        return;
      }
      throw error;
    }
    if (active?.id === capturingRun.id) {
      active.status = 'capturing';
      active.captureSent = true;
      captureFailureCount = 0;
      captureRetryAt = 0;
    }
  } catch (error) {
    if (active?.id === capturingRun.id) {
      captureFailureCount += 1;
      captureRetryAt = Date.now() + Math.min(60_000, 5000 * 2 ** (captureFailureCount - 1));
    }
    throw error;
  } finally {
    captureInFlight = false;
  }
}

function inspectPage(): void {
  if (!active || active.captureSent) return;
  const { adapter } = active;
  if (location.origin !== adapter.origin) {
    reportTerminalEventually('interrupted', 'Provider tab navigated away.');
    return;
  }
  if (captureInFlight) return;
  const researchTimedOut = active.status === 'researching'
    && Boolean(active.submittedAt && Date.now() - active.submittedAt >= RESEARCH_TIMEOUT_MS);
  const finalRoots = responseRoots(adapter);
  if (active.status !== 'capturing' && captureFailureCount === 0
    && findElement(adapter.selectors.quotaNotice, document, finalRoots)) {
    reportTerminalEventually('quota_exhausted', `${adapter.label} deep research limit reached.`);
    return;
  }
  const plan = adapter.selectors.planApproval && findElement(adapter.selectors.planApproval);
  const latestResponse = finalRoots.at(-1) ?? null;
  const newResponse = isNewFinalResponse(latestResponse, active.finalResponseBaseline) ? latestResponse : null;
  const streaming = findElement(adapter.selectors.streamingIndicator);
  if ((active.status === 'manual_required' || active.status === 'submitting')
    && (newResponse || isInteractiveProgressIndicator(streaming) || plan)) {
    reportEventually('researching');
    return;
  }
  if (plan) {
    if (active.geminiAutoApprove) plan.click();
    else if (active.status !== 'awaiting_user') reportEventually('awaiting_user', 'Approve the Gemini research plan to continue.');
    return;
  }
  const root = newResponse;
  if (streaming) {
    active.completionCandidate = undefined;
    if (researchTimedOut) reportEventually('manual_required', `${adapter.label} has not completed after 45 minutes. Check the provider tab.`);
    else if (active.status === 'awaiting_user') reportEventually('researching');
    return;
  }
  const responseSnapshot = root ? createResponseSnapshot(root) : undefined;
  if (active.status !== 'capturing' && isClarifyingResponse(newResponse, adapter.clarifyingPromptPattern, responseSnapshot)) {
    active.completionCandidate = undefined;
    if (active.status !== 'awaiting_user') reportEventually('awaiting_user', `${adapter.label} is asking a clarifying question.`);
    return;
  }
  if (active.status !== 'capturing' && isQuotaResponse(newResponse, adapter.quotaResponsePattern, responseSnapshot)) {
    reportTerminalEventually('quota_exhausted', `${adapter.label} deep research limit reached.`);
    return;
  }
  const copy = root
    ? findResponseControl(root, finalRoots, adapter.selectors.copyButton, active.copyButtonBaseline, true)
    : null;
  if (isProgressResponse(newResponse, adapter.progressResponsePattern, Boolean(copy), responseSnapshot)) {
    active.completionCandidate = undefined;
    if (researchTimedOut) reportEventually('manual_required', `${adapter.label} has not completed after 45 minutes. Check the provider tab.`);
    else if (active.status === 'awaiting_user') reportEventually('researching');
    return;
  }
  const completion = evaluateStableResponse(root, Boolean(copy), active.completionCandidate, Date.now(), active.completionDebounceMs);
  active.completionCandidate = completion.candidate;
  if (researchTimedOut && !completion.candidate) {
    reportEventually('manual_required', `${adapter.label} has not completed after 45 minutes. Check the provider tab.`);
    return;
  }
  if (completion.ready && root) {
    if (Date.now() < captureRetryAt) return;
    void capture(root).catch((error) => console.error('Could not deliver captured report to the coordinator.', error));
  }
}

function scheduleInspection(): void {
  if (inspectionScheduled) return;
  inspectionScheduled = true;
  queueMicrotask(() => {
    inspectionScheduled = false;
    inspectPage();
  });
}

function beginMonitoring(): void {
  observer?.disconnect();
  observer = new MutationObserver(scheduleInspection);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = window.setInterval(scheduleInspection, 2000);
  scheduleInspection();
}

function stopMonitoring(): void {
  observer?.disconnect();
  observer = undefined;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
}

async function start(event: Extract<BackgroundEvent, { type: 'content:start' }>): Promise<void> {
  if (active?.id === event.runId) {
    if (event.resumeOnly || active.automationStarted) return;
    stopMonitoring();
    active.finalResponseBaseline = createFinalResponseBaseline(responseRoots(active.adapter));
    active.copyButtonBaseline = new Set(findAll(active.adapter.selectors.copyButton, document, HOVER_COPY_VISIBILITY));
    active.captureSent = false;
    active.automationStarted = true;
    captureFailureCount = 0;
    captureRetryAt = 0;
    await automate();
    return;
  }
  stopMonitoring();
  captureFailureCount = 0;
  captureRetryAt = 0;
  const adapter = ADAPTERS[event.provider];
  const streaming = findElement(adapter.selectors.streamingIndicator);
  const plan = adapter.selectors.planApproval && findElement(adapter.selectors.planApproval);
  const resumedSubmissionConfirmed = event.resumeOnly
    && event.status === 'submitting'
    && (isInteractiveProgressIndicator(streaming) || Boolean(plan));
  const resumeExistingResponse = (event.resumeOnly
    && !['opening', 'awaiting_ready', 'setting_mode', 'submitting'].includes(event.status))
    || resumedSubmissionConfirmed;
  const finalResponseBaseline = createFinalResponseBaseline(resumeExistingResponse ? [] : responseRoots(adapter));
  const copyButtonBaseline = new Set(resumeExistingResponse
    ? []
    : findAll(adapter.selectors.copyButton, document, HOVER_COPY_VISIBILITY));
  active = {
    id: event.runId,
    adapter,
    submittedQuery: event.appendString.trim() ? `${event.query}\n${event.appendString}` : event.query,
    geminiAutoApprove: event.geminiAutoApprove,
    completionDebounceMs: event.completionDebounceMs,
    status: event.status,
    submittedAt: event.submittedAt ?? (event.status === 'researching' ? Date.now() : undefined),
    captureSent: event.captureAccepted === true,
    finalResponseBaseline,
    copyButtonBaseline,
    automationStarted: !event.resumeOnly,
  };
  if (event.resumeOnly) {
    if (event.status === 'submitting') {
      if (active.captureSent) return;
      if (resumedSubmissionConfirmed) await report('researching', undefined, Date.now());
      else await report('manual_required', 'Submission could not be confirmed after reload. Check the provider tab before sending again.');
    }
    if (!active.captureSent) beginMonitoring();
    return;
  }
  await automate();
}

export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://claude.ai/*', 'https://gemini.google.com/*', 'https://grok.com/*'],
  runAt: 'document_idle',
  main() {
    const provider = providerFromLocation(location);
    if (!provider) return;
    browser.runtime.onMessage.addListener(async (message: BackgroundEvent) => {
      if (message.type === 'content:start' && message.provider === provider) {
        await start(message);
        return { ok: true };
      }
      if (message.type === 'capture:copy-now' && active) {
        const roots = responseRoots(active.adapter);
        const root = roots.at(-1) ?? null;
        const button = root ? findResponseControl(root, roots, active.adapter.selectors.copyButton, new Set(), true) : null;
        if (!button) throw new Error('Provider copy button is unavailable.');
        button.click();
        return { ok: true };
      }
      if (message.type === 'content:stop' && active?.id === message.runId) {
        active.captureSent = true;
        stopMonitoring();
        return { ok: true };
      }
      return undefined;
    });
    const hello = () => sendContentMessage({ type: 'content:hello', provider, url: location.href });
    void hello();
  },
});
