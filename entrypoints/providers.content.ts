import TurndownService from 'turndown';
import { ADAPTERS, classifyProviderPage, conversationKeysMatch, normalizeConversationKey, providerFromLocation, type ProviderAdapter, type ProviderPageIdentity, type SelectorChain } from '@/src/adapters';
import { tokenContainment } from '@/src/citations';
import { createFinalResponseBaseline, createResponseSnapshot, domCitationCount, domCitationInventory, evaluateStableResponse, isClarifyingResponse, isNewFinalResponse, isProgressResponse, isQuotaResponse, mergeCitationInventories, normalizeActivityText, shouldOpenSourceToggle, sourceToggleState, type FinalResponseBaseline, type ResponseSnapshot, type StableResponseCandidate } from '@/src/dom-capture';
import { ContentMessageError, sendContentMessage } from '@/src/content-messaging';
import { injectQuery, submitWithEnter } from '@/src/injection';
import type { BackgroundEvent, CurrentResponseSnapshot, ProviderSnapshot } from '@/src/messages';
import { findAll, findElement, isVisible } from '@/src/selectors';
import { captureGrokResearchTrail } from '@/src/sources';
import { isSetupProviderStatus } from '@/src/state';
import { isTerminalProviderStatus, type ProviderRunStatus, type RunId } from '@/src/types';
import { ProviderReporter } from '@/src/provider-reporting';
import { ResponseControlIndex, isResponseControlActionable } from '@/src/response-controls';

interface ActiveRun {
  id: RunId;
  adapter: ProviderAdapter;
  submittedQuery: string;
  geminiAutoApprove: boolean;
  completionDebounceMs: number;
  status: ProviderRunStatus;
  submittedAt?: number;
  researchTimedOutAt?: number;
  conversationKey?: string;
  reporter: ProviderReporter;
  stopped: boolean;
  abort: AbortController;
  captureInFlight: boolean;
  captureFailureCount: number;
  captureRetryAt: number;
  completionCandidate?: StableResponseCandidate;
  timeoutGraceUntil?: number;
  captureSent: boolean;
  finalResponseBaseline: FinalResponseBaseline;
  copyButtonBaseline: ReadonlySet<HTMLElement>;
  automationInFlight: boolean;
  submissionAttempted: boolean;
  manualSetupRequired: boolean;
  timeoutActivity: TimeoutActivity;
  planApproval: PlanApprovalState;
}

interface PlanApprovalState {
  seen: boolean;
  attempts: number;
  lastAttemptAt: number;
  confirmed: boolean;
  element?: HTMLElement;
  responseGuard?: PlanResponseGuard;
}

interface PlanResponseGuard {
  root: HTMLElement;
  activityText: string;
}

interface ActivitySignature {
  response?: string;
  progress?: string;
}

type TimeoutActivity =
  | { phase: 'hydrating' }
  | {
    phase: 'baseline';
    signature: ActivitySignature;
    responseArmed: boolean;
    responseStableSince: number;
  };

let active: ActiveRun | undefined;
let observer: MutationObserver | undefined;
let sweepTimer: number | undefined;
let inspectionTimer: number | undefined;
let lastInspectionAt = 0;
const RESEARCH_TIMEOUT_MS = 45 * 60 * 1000;
const INSPECTION_THROTTLE_MS = 250;
const RESPONSE_VISIBILITY = { ignoreAncestorAriaHidden: true, ignoreAncestorOpacity: true } as const;
const HOVER_COPY_VISIBILITY = { allowTransparent: true, ignoreAncestorOpacity: true } as const;
const PAGE_QUOTA_REGION = '[role="alert"], [role="dialog"], dialog, [role="status"], [aria-live="assertive"], [aria-live="polite"]';
const PAGE_QUOTA_EXCLUDED_REGION = 'nav, aside, [role="navigation"], form, [contenteditable="true"], textarea, [data-message-author-role="user"], user-query, [data-test-id="user-query"], [data-testid*="user-message" i]';
const PLAN_APPENDED_REPORT_MIN_CHARS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertCurrent(run: ActiveRun): void {
  if (active !== run || run.stopped || run.captureSent) throw new Error('Provider run is no longer active.');
}

function applyProviderState(run: ActiveRun, snapshot: ProviderSnapshot): void {
  if (active !== run || run.stopped || run.captureSent) return;
  run.status = snapshot.status;
  run.submittedAt = snapshot.submittedAt;
  run.researchTimedOutAt = snapshot.researchTimedOutAt;
  run.conversationKey = normalizeConversationKey(snapshot.conversationKey, run.adapter.id) ?? run.conversationKey;
  if (snapshot.researchTimedOutAt === undefined) {
    run.timeoutActivity = { phase: 'hydrating' };
    run.timeoutGraceUntil = undefined;
  }
  if (isTerminalProviderStatus(snapshot.status)) stopRun(run);
}

async function report(status: ProviderRunStatus, detail?: string, submittedAt?: number, reason?: 'research_timeout'): Promise<void> {
  if (!active) return;
  const run = active;
  assertCurrent(run);
  observeConversation(run);
  const continuingResearch = run.status === 'researching' && run.researchTimedOutAt === undefined;
  const reportSubmittedAt = status === 'researching'
    ? submittedAt ?? (continuingResearch ? run.submittedAt : Date.now())
    : run.submittedAt;
  await run.reporter.report({
    type: 'content:state', runId: run.id, provider: run.adapter.id,
    status, detail, submittedAt: reportSubmittedAt, reason, conversationKey: run.conversationKey,
  });
  if (!isTerminalProviderStatus(status)) assertCurrent(run);
}

function reportEventually(status: ProviderRunStatus, detail?: string, submittedAt?: number, reason?: 'research_timeout'): void {
  if (!active || active.stopped || active.captureSent) return;
  // Errors are reconciled by the per-run reporter; inspections don't log a
  // permanently rejected transition on every DOM mutation.
  void report(status, detail, submittedAt, reason).catch(() => undefined);
}

function reportTimeout(signature: ActivitySignature = {}): void {
  if (!active || active.researchTimedOutAt !== undefined) return;
  const now = Date.now();
  active.researchTimedOutAt = now;
  active.timeoutActivity = signature.response === undefined && signature.progress === undefined
    ? { phase: 'hydrating' }
    : { phase: 'baseline', signature, responseArmed: false, responseStableSince: now };
  reportEventually('manual_required', `${active.adapter.label} has not completed after 45 minutes. Check the provider tab.`, undefined, 'research_timeout');
}

function waitFor(predicate: () => HTMLElement | null, timeoutMs: number): Promise<HTMLElement | null> {
  const signal = active?.abort.signal;
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null);
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
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    }
    const onAbort = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });
    localObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  });
}

async function prefillOnly(detail: string): Promise<void> {
  if (!active) return;
  const run = active;
  run.manualSetupRequired = true;
  const composer = findElement(run.adapter.selectors.composer);
  if (composer && !run.submissionAttempted) await injectQuery(composer, run.adapter.composerKind, run.submittedQuery);
  assertCurrent(run);
  beginMonitoring();
  reportEventually('manual_required', detail);
}

async function automate(): Promise<void> {
  if (!active) return;
  const run = active;
  const { adapter } = run;
  const submissionBaseline = run.finalResponseBaseline;
  if (run.status === 'pending') await report('opening');
  if (run.status !== 'setting_mode') await report('awaiting_ready');
  let composer: HTMLElement | null = null;
  for (let attempt = 0; attempt < 2 && !composer; attempt += 1) {
    if (findElement(adapter.selectors.loginWall)) return report('unauthenticated', `Not signed in to ${adapter.label}.`);
    if (findTrustedPageQuotaNotice(adapter, candidateResponseRoots(adapter))) {
      return report('quota_exhausted', `${adapter.label} deep research limit reached.`);
    }
    composer = await waitFor(() => findElement(adapter.selectors.composer), 15_000);
    assertCurrent(run);
    if (!composer && attempt === 0) await delay(2000);
    assertCurrent(run);
  }
  if (!composer) return prefillOnly('Page did not become ready after two attempts.');

  if (run.status !== 'setting_mode') await report('setting_mode');
  if (!findElement(adapter.selectors.modeConfirmed)) {
    const entry = findElement(adapter.selectors.modeEntry);
    if (!entry) return prefillOnly('Could not find the deep research mode control.');
    entry.click();
    const option = await waitFor(() => findElement(adapter.selectors.modeOption), 3000);
    assertCurrent(run);
    if (!option) return prefillOnly('Could not find the deep research mode option.');
    option.click();
    const confirmed = await waitFor(() => findElement(adapter.selectors.modeConfirmed), 3000);
    assertCurrent(run);
    if (!confirmed) return prefillOnly('Could not confirm deep research mode. Set it manually and send.');
  }

  await report('submitting');
  if (!(await injectQuery(composer, adapter.composerKind, run.submittedQuery))) {
    return prefillOnly('Could not enter the complete query. Paste it manually.');
  }
  assertCurrent(run);
  run.submissionAttempted = true;
  if (adapter.submitStrategy === 'enter') submitWithEnter(composer);
  else {
    const submit = findElement(adapter.selectors.submitButton);
    if (!submit || !isVisible(submit)) return prefillOnly('The send control was unavailable. Send the pre-filled query manually.');
    submit.click();
  }
  const submitted = await waitFor(() => {
    const text = composer instanceof HTMLTextAreaElement ? composer.value : composer.textContent ?? '';
    const latestResponse = candidateResponseRoots(adapter).at(-1) ?? null;
    const streaming = findStreamingIndicator(adapter, latestResponse);
    const plan = adapter.selectors.planApproval && findElement(adapter.selectors.planApproval);
    const responseStarted = isNewFinalResponse(latestResponse, submissionBaseline);
    return !text.trim() && (isInteractiveProgressIndicator(streaming) || plan || responseStarted) ? composer : null;
  }, 5000);
  assertCurrent(run);
  beginMonitoring();
  if (!submitted) {
    reportEventually('manual_required', 'The query may not have sent. Check the provider tab.');
    return;
  }
  observeConversation(run);
  reportEventually('researching', undefined, Date.now());
}

function contentToMarkdown(content: HTMLElement): string {
  const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  turndown.addRule('removeUnsafe', { filter: ['form', 'input', 'textarea'], replacement: () => '' });
  return turndown.turndown(content).trim();
}

function normalizeResponseRoots(roots: readonly HTMLElement[]): HTMLElement[] {
  const unique = Array.from(new Set(roots));
  const outermost = unique.filter((candidate) => !unique.some((other) => other !== candidate && other.contains(candidate)));
  return outermost.sort((left, right) => {
    if (left === right) return 0;
    return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  });
}

function candidateResponseRoots(adapter: ProviderAdapter): HTMLElement[] {
  return normalizeResponseRoots(
    adapter.selectors.finalMessageRoot.flatMap((selector) => findAll([selector], document, RESPONSE_VISIBILITY)),
  );
}

function completedResponseRoots(adapter: ProviderAdapter): HTMLElement[] {
  const candidates = candidateResponseRoots(adapter);
  return completedResponseRootsForCandidates(adapter, candidates);
}

function completedResponseRootsForCandidates(
  adapter: ProviderAdapter,
  candidates: readonly HTMLElement[],
): HTMLElement[] {
  const completed = findAll(adapter.selectors.finalMessageRoot, document, RESPONSE_VISIBILITY);
  return normalizeResponseRoots(completed.map((root) => (
    candidates.find((candidate) => candidate === root || candidate.contains(root)) ?? root
  )));
}

function responseActivityTextWithoutCitations(snapshot: ResponseSnapshot): string {
  return snapshot.activityTextWithoutCitations;
}

function planResponseStillGuarded(
  root: HTMLElement,
  snapshot: ResponseSnapshot,
  guard: PlanResponseGuard | undefined,
): boolean {
  if (!guard || guard.root !== root) return false;
  const currentText = responseActivityTextWithoutCitations(snapshot);
  if (currentText === guard.activityText) return true;
  const planIndex = currentText.indexOf(guard.activityText);
  const planRemains = planIndex >= 0 || tokenContainment(currentText, guard.activityText) >= 0.8;
  if (!planRemains) return false;
  const appendedLength = planIndex >= 0
    ? normalizeActivityText(
      `${currentText.slice(0, planIndex)} ${currentText.slice(planIndex + guard.activityText.length)}`,
    ).length
    : Math.max(0, currentText.length - guard.activityText.length);
  return appendedLength < PLAN_APPENDED_REPORT_MIN_CHARS;
}

function findTrustedPageQuotaNotice(
  adapter: ProviderAdapter,
  responseRoots: readonly HTMLElement[],
): HTMLElement | null {
  return findAll(adapter.selectors.quotaNotice, document).find((element) => (
    !responseRoots.some((root) => root.contains(element))
    && !element.closest(PAGE_QUOTA_EXCLUDED_REGION)
    && Boolean(element.closest(PAGE_QUOTA_REGION))
  )) ?? null;
}

function currentResponseSnapshot(
  adapter: ProviderAdapter,
  expectedRunId?: RunId,
  expectedConversationKey?: string,
): CurrentResponseSnapshot {
  const pageIdentity = classifyProviderPage(location.href, adapter.id);
  if (pageIdentity.kind === 'unsupported') {
    throw new Error(`The current ${adapter.label} page is not a conversation or entry page.`);
  }
  const currentConversationKey = pageIdentity.kind === 'conversation' ? pageIdentity.key : undefined;
  if (expectedRunId !== undefined) {
    if (active && active.id !== expectedRunId) throw new Error('The provider tab is attached to a different run.');
    if (expectedConversationKey && (!conversationKeysMatch(expectedConversationKey, currentConversationKey, adapter.id)
      || (active?.conversationKey && !conversationKeysMatch(expectedConversationKey, active.conversationKey, adapter.id)))) {
      throw new Error('The provider tab is showing a different or unverified conversation.');
    }
    if (!expectedConversationKey && (pageIdentity.kind !== 'entry' || active?.conversationKey !== undefined)) {
      throw new Error('The provider tab could not verify the expected entry-page run.');
    }
  }
  const root = candidateResponseRoots(adapter).at(-1);
  if (!root) throw new Error(`No ${adapter.label} response is available to copy.`);
  const snapshot = createResponseSnapshot(root);
  const domMarkdown = contentToMarkdown(snapshot.content);
  if (!snapshot.text || !domMarkdown) throw new Error(`The current ${adapter.label} response is empty.`);
  return {
    provider: adapter.id,
    pageUrl: location.href,
    activeRunId: active?.id,
    conversationKey: currentConversationKey,
    domMarkdown,
    domCitations: domCitationInventory(root, adapter, snapshot),
  };
}

function observeConversation(run: ActiveRun): ProviderPageIdentity {
  const identity = classifyProviderPage(location.href, run.adapter.id);
  if (!run.conversationKey && identity.kind === 'conversation') run.conversationKey = identity.key;
  return identity;
}

function obscuringAncestors(element: HTMLElement): Set<HTMLElement> {
  const ancestors = new Set<HTMLElement>();
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const opacity = Number.parseFloat(getComputedStyle(current).opacity);
    if (current.getAttribute('aria-hidden')?.toLowerCase() === 'true'
      || current.hasAttribute('inert')
      || (!Number.isNaN(opacity) && opacity <= 0)) ancestors.add(current);
  }
  return ancestors;
}

function isModalBlockedControl(control: HTMLElement, root: HTMLElement): boolean {
  const rootObscurers = obscuringAncestors(root);
  return rootObscurers.size > 0
    && Array.from(obscuringAncestors(control)).some((ancestor) => rootObscurers.has(ancestor));
}

function findStreamingIndicator(adapter: ProviderAdapter, root?: HTMLElement | null): HTMLElement | null {
  const visible = findElement(adapter.selectors.streamingIndicator);
  if (visible || !root) return visible;
  const rootObscurers = obscuringAncestors(root);
  if (!rootObscurers.size) return null;
  return findAll(adapter.selectors.streamingIndicator, document, RESPONSE_VISIBILITY)
    .find((candidate) => Array.from(obscuringAncestors(candidate)).some((ancestor) => rootObscurers.has(ancestor))) ?? null;
}

function isInteractiveProgressIndicator(element: HTMLElement | null): boolean {
  return Boolean(element && (element instanceof HTMLButtonElement
    || element.getAttribute('role') === 'button'
    || (element instanceof HTMLInputElement && ['button', 'submit'].includes(element.type))));
}

function progressActivitySignature(element: HTMLElement | null): string | undefined {
  if (!element) return undefined;
  return [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-state'),
    element.textContent]
    .map((value) => normalizeActivityText(value ?? ''))
    .join('\u0000');
}

function activitySignature(
  root: HTMLElement | null,
  snapshot: ResponseSnapshot | undefined,
  progress: HTMLElement | null,
): ActivitySignature {
  const stableId = root?.getAttribute('data-message-id') || root?.id;
  const responseText = root && snapshot ? responseActivityTextWithoutCitations(snapshot) : undefined;
  return {
    response: responseText === undefined ? undefined : `${stableId ? `id:${stableId}` : 'anonymous'}\u0000${responseText}`,
    progress: progressActivitySignature(progress),
  };
}

function timedOutActivityResumed(run: ActiveRun, signature: ActivitySignature, now = Date.now()): boolean {
  if (run.researchTimedOutAt === undefined) return false;
  if (run.timeoutActivity.phase === 'hydrating') {
    if (signature.response !== undefined || signature.progress !== undefined) {
      run.timeoutActivity = {
        phase: 'baseline', signature, responseArmed: false, responseStableSince: now,
      };
    }
    return false;
  }
  const checkpoint = run.timeoutActivity;
  if (signature.progress !== undefined && signature.progress !== checkpoint.signature.progress) return true;
  if (signature.response === undefined) return false;
  if (checkpoint.signature.response === undefined) {
    checkpoint.signature.response = signature.response;
    checkpoint.responseArmed = false;
    checkpoint.responseStableSince = now;
    return false;
  }
  if (signature.response !== checkpoint.signature.response) {
    if (checkpoint.responseArmed) return true;
    checkpoint.signature.response = signature.response;
    checkpoint.responseStableSince = now;
    return false;
  }
  if (!checkpoint.responseArmed && now - checkpoint.responseStableSince >= run.completionDebounceMs) {
    checkpoint.responseArmed = true;
  }
  return false;
}

function copyControlFields(button: HTMLElement): string[] {
  return [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent]
    .map((value) => (value ?? '').replace(/\s+/g, ' ').trim());
}

function isCopiedSuccessText(value: string): boolean {
  return !/\b(?:not|never|wasn['’]t|couldn['’]t|failed\s+to)\s+(?:be\s+)?copied\b|\bcopy\s+failed\b/i.test(value)
    && /\b(?:copied(?:\s+to\s+(?:the\s+)?clipboard)?|response\s+copied|copy\s+successful)\b/i.test(value);
}

async function clickCopyControl(button: HTMLElement, adapter: ProviderAdapter): Promise<boolean> {
  const initialFields = copyControlFields(button);
  const success = () => Boolean(adapter.copySuccessSelector
    && (button.matches(adapter.copySuccessSelector) || button.querySelector(adapter.copySuccessSelector)));
  const initialSuccess = success();
  let copyEventObserved = false;
  let clicking = false;
  const onCopy = (event: Event) => {
    if (clicking || (event.target instanceof Node && button.contains(event.target))) copyEventObserved = true;
  };
  document.addEventListener('copy', onCopy, true);
  try {
    clicking = true;
    try { button.click(); } finally { clicking = false; }
    const deadline = Date.now() + 500;
    do {
      const currentFields = copyControlFields(button);
      const copiedText = currentFields.some((value, index) => value !== initialFields[index]
        && isCopiedSuccessText(value));
      if (copyEventObserved
        || (!initialSuccess && success())
        || copiedText) return true;
      await delay(50);
    } while (Date.now() < deadline);
    return false;
  } finally {
    document.removeEventListener('copy', onCopy, true);
  }
}

export function findResponseControl(
  root: HTMLElement,
  roots: readonly HTMLElement[],
  selectors: SelectorChain,
  baseline: ReadonlySet<HTMLElement> = new Set(),
  allowHoverTransparent = false,
): HTMLElement | null {
  return new ResponseControlIndex(roots, { rootsAreNormalized: true })
    .find(root, selectors, baseline, allowHoverTransparent);
}

async function capture(root: HTMLElement, copyControlObserved: boolean): Promise<void> {
  if (!active || active.captureSent || active.captureInFlight || active.stopped) return;
  const capturingRun = active;
  capturingRun.captureInFlight = true;
  try {
    const pageIdentity = observeConversation(capturingRun);
    if (pageIdentity.kind === 'unsupported'
      || (capturingRun.conversationKey
        && (pageIdentity.kind !== 'conversation'
          || !conversationKeysMatch(capturingRun.conversationKey, pageIdentity.key, capturingRun.adapter.id)))) {
      throw new Error('Cannot capture an unverified or different provider conversation.');
    }
    const initialSnapshot = createResponseSnapshot(root);
    const before = domCitationInventory(root, capturingRun.adapter, initialSnapshot);
    const title = initialSnapshot.content.querySelector('h1, h2, h3')?.textContent?.trim();
    await capturingRun.reporter.idle();
    assertCurrent(capturingRun);
    let toggle: HTMLElement | null = null;
    const sourceSelectors = capturingRun.adapter.selectors.sourcesPanelToggle;
    if (root.isConnected && sourceSelectors) {
      const refreshedRoots = completedResponseRoots(capturingRun.adapter);
      const refreshedControls = new ResponseControlIndex(refreshedRoots, { rootsAreNormalized: true });
      const possibleToggle = refreshedControls.find(root, sourceSelectors, new Set(), true, true);
      if (possibleToggle?.isConnected) {
        const actionable = isResponseControlActionable(possibleToggle, true, root);
        if (!actionable && isModalBlockedControl(possibleToggle, root)) return;
        if (actionable) toggle = possibleToggle;
      }
    }
    let after = before;
    const researchTrail = capturingRun.adapter.id === 'grok'
      ? await captureGrokResearchTrail(document, toggle, 5000, capturingRun.abort.signal)
      : undefined;
    if (capturingRun.adapter.id !== 'grok' && toggle && shouldOpenSourceToggle(toggle)) {
      const initialToggleState = sourceToggleState(toggle);
      toggle.click();
      const started = Date.now();
      try {
        do {
          await delay(100);
          assertCurrent(capturingRun);
        } while (root.isConnected && Date.now() - started < 1000
          && domCitationCount(root, capturingRun.adapter) === before.length);
        if (root.isConnected) {
          const expandedSnapshot = createResponseSnapshot(root);
          after = domCitationInventory(root, capturingRun.adapter, expandedSnapshot);
        }
      } finally {
        if (toggle.isConnected) toggle.click();
      }
      if (initialToggleState === 'unknown' && after.length < before.length) after = before;
    }
    const refreshedSnapshot = root.isConnected ? createResponseSnapshot(root) : undefined;
    const finalContent = refreshedSnapshot && refreshedSnapshot.text.length >= initialSnapshot.text.length
      ? refreshedSnapshot.content
      : initialSnapshot.content;
    try {
      await capturingRun.reporter.idle();
      assertCurrent(capturingRun);
      const response = await sendContentMessage({
        type: 'content:capture',
        runId: capturingRun.id,
        provider: capturingRun.adapter.id,
        conversationKey: capturingRun.conversationKey,
        domMarkdown: contentToMarkdown(finalContent),
        domCitations: mergeCitationInventories(before, after),
        researchTrail,
        title,
        copyControlObserved,
      });
      applyProviderState(capturingRun, response?.providerState ?? {
        status: 'capturing',
        submittedAt: capturingRun.submittedAt,
        researchTimedOutAt: capturingRun.researchTimedOutAt,
        conversationKey: capturingRun.conversationKey,
      });
    } catch (error) {
      if (error instanceof ContentMessageError && error.providerState) applyProviderState(capturingRun, error.providerState);
      if (error instanceof ContentMessageError && error.code === 'invalid_transition') return;
      if (error instanceof ContentMessageError && ['provider_terminal', 'run_not_found'].includes(error.code ?? '')) {
        if (active === capturingRun) stopRun(capturingRun);
        return;
      }
      throw error;
    }
    if (active === capturingRun && !capturingRun.stopped) {
      active.captureSent = true;
      capturingRun.captureFailureCount = 0;
      capturingRun.captureRetryAt = 0;
      capturingRun.reporter.cancel();
      stopMonitoring();
    }
  } catch (error) {
    if (active === capturingRun && !capturingRun.stopped) {
      capturingRun.captureFailureCount += 1;
      capturingRun.captureRetryAt = Date.now() + Math.min(60_000, 5000 * 2 ** (capturingRun.captureFailureCount - 1));
      if (capturingRun.status === 'researching' && capturingRun.submittedAt !== undefined
        && Date.now() - capturingRun.submittedAt >= RESEARCH_TIMEOUT_MS) reportTimeout();
    }
    throw error;
  } finally {
    capturingRun.captureInFlight = false;
  }
}

function inspectPage(): void {
  if (!active || active.captureSent || active.stopped) return;
  const { adapter } = active;
  if (location.origin !== adapter.origin) {
    reportEventually('interrupted', 'Provider tab navigated away.');
    return;
  }
  if (active.captureInFlight || active.automationInFlight || isSetupProviderStatus(active.status)) return;
  const now = Date.now();
  const researchTimeoutDue = active.researchTimedOutAt === undefined
    && active.status === 'researching' && active.submittedAt !== undefined
    && now - active.submittedAt >= RESEARCH_TIMEOUT_MS;
  const pageIdentity = classifyProviderPage(location.href, adapter.id);
  const conversationWasBound = active.conversationKey !== undefined;
  if (active.conversationKey) {
    if (pageIdentity.kind !== 'conversation'
      || !conversationKeysMatch(active.conversationKey, pageIdentity.key, adapter.id)) {
      reportEventually('interrupted', 'Provider tab navigated to a different conversation.');
      return;
    }
  } else if (pageIdentity.kind === 'conversation') {
    active.conversationKey = pageIdentity.key;
  }
  if (pageIdentity.kind === 'unsupported') return;

  const candidateRoots = candidateResponseRoots(adapter);
  const finalRoots = completedResponseRootsForCandidates(adapter, candidateRoots);
  const latestResponse = candidateRoots.at(-1) ?? null;
  const latestFinalResponse = latestResponse && finalRoots.includes(latestResponse) ? latestResponse : null;
  const plan = adapter.selectors.planApproval ? findElement(adapter.selectors.planApproval) : null;
  let latestSnapshot: ResponseSnapshot | undefined;
  const getLatestSnapshot = () => {
    if (latestResponse && !latestSnapshot) latestSnapshot = createResponseSnapshot(latestResponse);
    return latestSnapshot;
  };
  const planState = active.planApproval;
  if (plan) {
    planState.element = plan;
    if (!planState.seen) {
      planState.seen = true;
      const snapshot = getLatestSnapshot();
      if (latestResponse && snapshot) {
        planState.responseGuard = {
          root: latestResponse,
          activityText: responseActivityTextWithoutCitations(snapshot),
        };
      }
    }
  }

  // Only semantic page-level notices preempt streaming. Generic matching text in
  // the conversation, sidebar, or composer is classified in its local context.
  if (active.status !== 'capturing' && active.captureFailureCount === 0
    && findTrustedPageQuotaNotice(adapter, candidateRoots)) {
    reportEventually('quota_exhausted', `${adapter.label} deep research limit reached.`);
    return;
  }

  const streaming = findStreamingIndicator(adapter, latestResponse);
  if (streaming) {
    const approvedPlan = planState.seen && !planState.confirmed;
    if (approvedPlan) planState.confirmed = true;
    const activitySnapshot = active.researchTimedOutAt !== undefined || researchTimeoutDue
      ? getLatestSnapshot()
      : undefined;
    const signature = activitySignature(latestResponse, activitySnapshot, streaming);
    active.completionCandidate = undefined;
    if (approvedPlan || (active.researchTimedOutAt !== undefined
      ? timedOutActivityResumed(active, signature, now)
      : !researchTimeoutDue && ['awaiting_user', 'manual_required', 'submitting'].includes(active.status))) {
      reportEventually('researching', undefined, Date.now());
    } else if (researchTimeoutDue) {
      reportTimeout(signature);
    } else if (!conversationWasBound && active.conversationKey && active.status === 'researching') {
      reportEventually('researching', undefined, active.submittedAt);
    }
    return;
  }

  if (plan && !planState.confirmed) {
    active.completionCandidate = undefined;
    const activitySnapshot = active.researchTimedOutAt !== undefined || researchTimeoutDue
      ? getLatestSnapshot()
      : undefined;
    const signature = activitySignature(latestResponse, activitySnapshot, plan);
    if (researchTimeoutDue) reportTimeout(signature);
    else if (active.researchTimedOutAt !== undefined) timedOutActivityResumed(active, signature, now);
    else if (!conversationWasBound && active.conversationKey && active.status === 'researching') {
      reportEventually('researching', undefined, active.submittedAt);
    }
    if (active.geminiAutoApprove && planState.attempts < 3
      && now - planState.lastAttemptAt >= 1000) {
      planState.attempts += 1;
      planState.lastAttemptAt = now;
      plan.click();
    }
    if ((!active.geminiAutoApprove || planState.attempts >= 3) && active.status !== 'awaiting_user') {
      reportEventually('awaiting_user', 'Approve the Gemini research plan to continue.');
    }
    return;
  }

  if (!plan && planState.seen && !planState.confirmed) {
    active.completionCandidate = undefined;
    if (planState.element?.isConnected) return;
    planState.confirmed = true;
    reportEventually('researching', undefined, now);
    return;
  }

  latestSnapshot = getLatestSnapshot();
  const baselineAllowsResponse = isNewFinalResponse(
    latestFinalResponse,
    active.finalResponseBaseline,
    latestSnapshot,
  );
  const responseSnapshot = baselineAllowsResponse ? latestSnapshot : undefined;
  const root = baselineAllowsResponse && latestFinalResponse && responseSnapshot
    && !planResponseStillGuarded(latestFinalResponse, responseSnapshot, planState.responseGuard)
    ? latestFinalResponse
    : null;
  const newResponse = root;
  const signature = activitySignature(latestResponse, latestSnapshot, null);
  if (!conversationWasBound && active.conversationKey && active.status === 'researching'
    && !researchTimeoutDue && active.researchTimedOutAt === undefined) {
    reportEventually('researching', undefined, active.submittedAt);
  }
  if (active.status !== 'capturing' && isClarifyingResponse(newResponse, adapter.clarifyingPromptPattern, responseSnapshot)) {
    active.completionCandidate = undefined;
    if (active.status !== 'awaiting_user') reportEventually('awaiting_user', `${adapter.label} is asking a clarifying question.`);
    return;
  }
  if (active.status !== 'capturing' && isQuotaResponse(newResponse, adapter.quotaResponsePattern, responseSnapshot)) {
    reportEventually('quota_exhausted', `${adapter.label} deep research limit reached.`);
    return;
  }
  if (isProgressResponse(newResponse, adapter.progressResponsePattern, false, responseSnapshot)) {
    active.completionCandidate = undefined;
    if (researchTimeoutDue) reportTimeout(signature);
    else if (active.researchTimedOutAt !== undefined ? timedOutActivityResumed(active, signature)
      : ['awaiting_user', 'manual_required', 'submitting'].includes(active.status)) {
      reportEventually('researching', undefined, Date.now());
    }
    return;
  }
  const controls = new ResponseControlIndex(finalRoots, { rootsAreNormalized: true });
  const copy = root
    ? controls.find(root, adapter.selectors.copyButton, active.copyButtonBaseline, true)
    : null;
  if (active.researchTimedOutAt === undefined
    && (active.status === 'manual_required' || active.status === 'submitting') && root) {
    reportEventually('researching', undefined, Date.now());
    return;
  }
  // Copy-backed short responses are deliberately considered only after plan,
  // clarification, quota, progress, and streaming classifiers have all failed.
  const completion = evaluateStableResponse(root, Boolean(copy), active.completionCandidate, now, active.completionDebounceMs, responseSnapshot);
  active.completionCandidate = completion.candidate;
  if (researchTimeoutDue && !completion.ready) {
    active.timeoutGraceUntil ??= now + (copy ? active.completionDebounceMs : Math.max(30_000, active.completionDebounceMs * 3));
    if (!completion.candidate || now >= active.timeoutGraceUntil) reportTimeout(signature);
  } else if (active.researchTimedOutAt !== undefined && !completion.ready
    && timedOutActivityResumed(active, signature, now)) {
    reportEventually('researching', undefined, Date.now());
    return;
  }
  if (completion.ready && root) {
    if (now < active.captureRetryAt) return;
    const sourceSelectors = adapter.selectors.sourcesPanelToggle;
    if (sourceSelectors) {
      const possibleToggle = controls.find(root, sourceSelectors, new Set(), true, true);
      if (possibleToggle?.isConnected
        && !isResponseControlActionable(possibleToggle, true, root)
        && isModalBlockedControl(possibleToggle, root)) {
        if (researchTimeoutDue) reportTimeout(signature);
        return;
      }
    }
    void capture(root, Boolean(copy)).catch((error) => console.error('Could not deliver captured report to the coordinator.', error));
  }
}

function runInspection(): void {
  lastInspectionAt = Date.now();
  try { inspectPage(); } catch (error) {
    console.error('Could not inspect provider response.', error);
    if (active?.status === 'researching' && active.submittedAt !== undefined
      && Date.now() - active.submittedAt >= RESEARCH_TIMEOUT_MS) reportTimeout();
  }
}

function scheduleInspection(): void {
  if (inspectionTimer !== undefined) return;
  const wait = Math.max(0, INSPECTION_THROTTLE_MS - (Date.now() - lastInspectionAt));
  inspectionTimer = window.setTimeout(() => {
    inspectionTimer = undefined;
    runInspection();
  }, wait);
}

function beginMonitoring(): void {
  if (!active || active.stopped || active.captureSent) return;
  if (observer) { scheduleInspection(); return; }
  observer = new MutationObserver(scheduleInspection);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = window.setInterval(() => {
    if (inspectionTimer === undefined && Date.now() - lastInspectionAt >= INSPECTION_THROTTLE_MS) runInspection();
  }, 2000);
  scheduleInspection();
}

function stopMonitoring(): void {
  observer?.disconnect();
  observer = undefined;
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
  if (inspectionTimer !== undefined) clearTimeout(inspectionTimer);
  inspectionTimer = undefined;
}

function stopRun(run: ActiveRun): void {
  run.stopped = true;
  run.abort.abort();
  run.reporter.cancel();
  if (active === run) stopMonitoring();
}

async function runAutomation(run: ActiveRun): Promise<void> {
  if (run.automationInFlight || run.submissionAttempted || run.manualSetupRequired || run.stopped || run.captureSent
    || !isSetupProviderStatus(run.status)) return;
  run.automationInFlight = true;
  try { await automate(); }
  catch (error) {
    if (active === run && !run.stopped && !(error instanceof ContentMessageError)) {
      run.manualSetupRequired = true;
      reportEventually('manual_required', 'Automatic setup could not finish. Check the provider tab before sending.');
    }
    throw error;
  }
  finally {
    run.automationInFlight = false;
    if (active === run) beginMonitoring();
  }
}

async function start(event: Extract<BackgroundEvent, { type: 'content:start' }>): Promise<void> {
  if (active?.id === event.runId) {
    if (active.stopped || active.captureSent) return;
    active.conversationKey ??= normalizeConversationKey(event.conversationKey, active.adapter.id);
    observeConversation(active);
    beginMonitoring();
    if (event.resumeOnly || active.submissionAttempted || active.manualSetupRequired) return;
    await runAutomation(active);
    return;
  }
  if (active) stopRun(active);
  const adapter = ADAPTERS[event.provider];
  const existingCandidates = candidateResponseRoots(adapter);
  const existingRoots = completedResponseRootsForCandidates(adapter, existingCandidates);
  const latestExistingResponse = existingCandidates.at(-1) ?? null;
  const streaming = findStreamingIndicator(adapter, latestExistingResponse);
  const plan = adapter.selectors.planApproval && findElement(adapter.selectors.planApproval);
  const setup = isSetupProviderStatus(event.status);
  const resumedSubmissionConfirmed = !setup && event.status === 'submitting'
    && (Boolean(streaming) || Boolean(plan));
  const resumeExistingResponse = (!setup && event.status !== 'submitting') || resumedSubmissionConfirmed;
  const latestExistingIsCompleted = latestExistingResponse !== null && existingRoots.includes(latestExistingResponse);
  const run: ActiveRun = {
    id: event.runId, adapter,
    submittedQuery: event.appendString.trim() ? `${event.query}\n${event.appendString}` : event.query,
    geminiAutoApprove: event.geminiAutoApprove,
    completionDebounceMs: event.completionDebounceMs,
    status: event.status,
    submittedAt: event.submittedAt ?? (event.status === 'researching' ? Date.now() : undefined),
    researchTimedOutAt: event.researchTimedOutAt,
    conversationKey: normalizeConversationKey(event.conversationKey, adapter.id),
    captureSent: event.captureAccepted === true,
    stopped: false, abort: new AbortController(), captureInFlight: false, captureFailureCount: 0, captureRetryAt: 0,
    finalResponseBaseline: createFinalResponseBaseline(
      resumeExistingResponse && latestExistingIsCompleted ? [] : existingRoots,
    ),
    copyButtonBaseline: new Set(resumeExistingResponse ? [] : findAll(adapter.selectors.copyButton, document, HOVER_COPY_VISIBILITY)),
    automationInFlight: false,
    submissionAttempted: !setup,
    manualSetupRequired: false,
    timeoutActivity: { phase: 'hydrating' },
    planApproval: { seen: false, attempts: 0, lastAttemptAt: 0, confirmed: false },
    reporter: new ProviderReporter((request, response) => {
      applyProviderState(run, response?.providerState ?? {
        status: request.status,
        submittedAt: request.submittedAt,
        researchTimedOutAt: request.status === 'researching' ? undefined : run.researchTimedOutAt,
        conversationKey: request.conversationKey ?? run.conversationKey,
      });
    }, (error) => {
      if (active !== run) return;
      if (error.providerState) applyProviderState(run, error.providerState);
      if (error.code === 'provider_terminal' || error.code === 'run_not_found') stopRun(run);
    }),
  };
  active = run;
  observeConversation(run);
  if (isTerminalProviderStatus(event.status)) { stopRun(run); return; }
  beginMonitoring();
  if (!setup || event.resumeOnly) {
    if (event.status === 'submitting' && !run.captureSent) {
      if (resumedSubmissionConfirmed) reportEventually('researching', undefined, Date.now());
      else reportEventually('manual_required', 'Submission could not be confirmed after reload. Check the provider tab before sending again.');
    }
    return;
  }
  await runAutomation(run);
}

export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://claude.ai/*', 'https://gemini.google.com/*', 'https://grok.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    const provider = providerFromLocation(location);
    if (!provider) return;
    const listener = async (message: BackgroundEvent) => {
      if (message.type === 'content:ping' && message.provider === provider) return { ok: true };
      if (message.type === 'content:start' && message.provider === provider) {
        // Acknowledges attachment, not completion of setup. A worker must never
        // wait for the same worker's state-report retries to finish.
        void start(message).catch((error) => console.error('Provider startup could not finish.', error));
        return { ok: true };
      }
      if (message.type === 'capture:dom-current' && message.provider === provider) {
        return currentResponseSnapshot(ADAPTERS[provider], message.runId, message.conversationKey);
      }
      if (message.type === 'capture:copy-now' && active) {
        const pageIdentity = observeConversation(active);
        const expectedJobId = `${active.id}:${active.adapter.id}`;
        const entryFallback = pageIdentity.kind === 'entry'
          && !active.conversationKey && !message.conversationKey;
        const conversationVerified = pageIdentity.kind === 'conversation'
          && conversationKeysMatch(message.conversationKey, pageIdentity.key, active.adapter.id)
          && conversationKeysMatch(active.conversationKey, pageIdentity.key, active.adapter.id);
        if (message.jobId !== expectedJobId || (!entryFallback && !conversationVerified)) {
          throw new Error('Provider copy rejected because the conversation changed.');
        }
        const roots = completedResponseRoots(active.adapter);
        const root = roots.at(-1) ?? null;
        const button = root ? findResponseControl(root, roots, active.adapter.selectors.copyButton, new Set(), true) : null;
        if (!button || !isResponseControlActionable(button, true, root ?? undefined)) {
          throw new Error('Provider copy button is unavailable.');
        }
        return { ok: true, copyConfirmed: await clickCopyControl(button, active.adapter) };
      }
      if (message.type === 'content:stop' && active?.id === message.runId) {
        stopRun(active);
        return { ok: true };
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(listener);
    ctx?.onInvalidated(() => {
      browser.runtime.onMessage.removeListener(listener);
      if (active) stopRun(active);
    });
    const hello = () => sendContentMessage({ type: 'content:hello', provider, url: location.href });
    void hello();
  },
});
