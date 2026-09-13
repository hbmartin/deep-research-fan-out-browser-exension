import TurndownService from 'turndown';
import { ADAPTERS, providerFromLocation, type ProviderAdapter } from '@/src/adapters';
import { createFinalResponseBaseline, domCitationInventory, evaluateStableResponse, isClarifyingResponse, isNewFinalResponse, isProgressResponse, isQuotaResponse, mergeCitationInventories, shouldOpenSourceToggle, sourceToggleState, type FinalResponseBaseline, type StableResponseCandidate } from '@/src/dom-capture';
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function report(status: ProviderRunStatus, detail?: string, submittedAt?: number): Promise<void> {
  if (!active) return;
  active.status = status;
  await sendContentMessage({ type: 'content:state', runId: active.id, provider: active.adapter.id, status, detail, submittedAt });
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
  await report('awaiting_ready');
  let composer: HTMLElement | null = null;
  for (let attempt = 0; attempt < 2 && !composer; attempt += 1) {
    if (findElement(adapter.selectors.loginWall)) return report('unauthenticated', `Not signed in to ${adapter.label}.`);
    if (findElement(adapter.selectors.quotaNotice, document, findAll(adapter.selectors.finalMessageRoot))) {
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
    return !text.trim() && findElement(adapter.selectors.streamingIndicator) ? composer : null;
  }, 5000);
  if (!submitted) {
    await report('manual_required', 'The query may not have sent. Check the provider tab.');
    beginMonitoring();
    return;
  }
  await report('researching', undefined, Date.now());
  beginMonitoring();
}

function domToMarkdown(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('button, script, style, svg, [aria-hidden="true"]').forEach((element) => element.remove());
  const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  turndown.addRule('removeUnsafe', { filter: ['form', 'input', 'textarea'], replacement: () => '' });
  return turndown.turndown(clone).trim();
}

async function capture(root: HTMLElement): Promise<void> {
  if (!active || active.captureSent || captureInFlight) return;
  captureInFlight = true;
  const capturingRun = active;
  try {
    await report('capturing');
    const before = domCitationInventory(root, capturingRun.adapter);
    const toggle = capturingRun.adapter.selectors.sourcesPanelToggle && (findElement(capturingRun.adapter.selectors.sourcesPanelToggle, root) || findElement(capturingRun.adapter.selectors.sourcesPanelToggle));
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
      if (initialToggleState === 'unknown') {
        toggle.click();
        if (after.length < before.length) after = before;
      }
    }
    try {
      await sendContentMessage({
        type: 'content:capture',
        runId: capturingRun.id,
        provider: capturingRun.adapter.id,
        domMarkdown: domToMarkdown(root),
        domCitations: mergeCitationInventories(before, after),
        researchTrail,
        title: root.querySelector('h1, h2, h3')?.textContent?.trim(),
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
  if (!active || active.captureSent || Date.now() < captureRetryAt) return;
  const { adapter } = active;
  const finalRoots = findAll(adapter.selectors.finalMessageRoot);
  if (location.origin !== adapter.origin) {
    void report('interrupted', 'Provider tab navigated away.');
    stopMonitoring();
    return;
  }
  if (findElement(adapter.selectors.quotaNotice, document, finalRoots)) {
    void report('quota_exhausted', `${adapter.label} deep research limit reached.`);
    stopMonitoring();
    return;
  }
  const plan = adapter.selectors.planApproval && findElement(adapter.selectors.planApproval);
  if (plan) {
    if (active.geminiAutoApprove) plan.click();
    else if (active.status !== 'awaiting_user') void report('awaiting_user', 'Approve the Gemini research plan to continue.');
    return;
  }
  const latestResponse = finalRoots.at(-1) ?? null;
  const newResponse = isNewFinalResponse(latestResponse, active.finalResponseBaseline) ? latestResponse : null;
  if (isProgressResponse(newResponse, adapter.progressResponsePattern)) {
    active.completionCandidate = undefined;
    if (active.status !== 'researching') void report('researching');
    return;
  }
  if (isClarifyingResponse(newResponse, adapter.clarifyingPromptPattern)) {
    active.completionCandidate = undefined;
    if (active.status !== 'awaiting_user') void report('awaiting_user', `${adapter.label} is asking a clarifying question.`);
    return;
  }
  const streaming = findElement(adapter.selectors.streamingIndicator);
  if (streaming) {
    active.completionCandidate = undefined;
    if (active.status === 'awaiting_user' || active.status === 'manual_required') void report('researching');
    return;
  }
  if (isQuotaResponse(newResponse, adapter.quotaResponsePattern)) {
    void report('quota_exhausted', `${adapter.label} deep research limit reached.`);
    stopMonitoring();
    return;
  }
  const root = newResponse;
  const scopedCopy = root ? findElement(adapter.selectors.copyButton, root) : null;
  const globalCopy = root ? findElement(adapter.selectors.copyButton) : null;
  const copy = scopedCopy || (globalCopy && !active.copyButtonBaseline.has(globalCopy) ? globalCopy : null);
  const completion = evaluateStableResponse(root, Boolean(copy), active.completionCandidate, Date.now(), active.completionDebounceMs);
  active.completionCandidate = completion.candidate;
  if (completion.ready && root) {
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
    active.finalResponseBaseline = createFinalResponseBaseline(findAll(active.adapter.selectors.finalMessageRoot));
    active.copyButtonBaseline = new Set(findAll(active.adapter.selectors.copyButton));
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
  const resumeExistingResponse = event.resumeOnly && !['opening', 'awaiting_ready', 'setting_mode', 'submitting'].includes(event.status);
  const finalResponseBaseline = createFinalResponseBaseline(resumeExistingResponse ? [] : findAll(adapter.selectors.finalMessageRoot));
  const copyButtonBaseline = new Set(resumeExistingResponse ? [] : findAll(adapter.selectors.copyButton));
  active = {
    id: event.runId,
    adapter,
    submittedQuery: event.appendString.trim() ? `${event.query}\n${event.appendString}` : event.query,
    geminiAutoApprove: event.geminiAutoApprove,
    completionDebounceMs: event.completionDebounceMs,
    status: event.status,
    captureSent: event.status === 'capturing',
    finalResponseBaseline,
    copyButtonBaseline,
    automationStarted: !event.resumeOnly,
  };
  if (event.resumeOnly) {
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
        const root = findElement(active.adapter.selectors.finalMessageRoot);
        const button = root ? findElement(active.adapter.selectors.copyButton, root) || findElement(active.adapter.selectors.copyButton) : null;
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
