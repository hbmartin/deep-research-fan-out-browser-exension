import TurndownService from 'turndown';
import { ADAPTERS, providerFromLocation, type ProviderAdapter } from '@/src/adapters';
import { createFinalResponseBaseline, domCitationInventory, isClarifyingResponse, isNewFinalResponse, mergeCitationInventories, sourceToggleState, type FinalResponseBaseline } from '@/src/dom-capture';
import { sendContentMessage } from '@/src/content-messaging';
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
  completionCandidateAt?: number;
  captureSent: boolean;
  finalResponseBaseline: FinalResponseBaseline;
}

let active: ActiveRun | undefined;
let observer: MutationObserver | undefined;
let sweepTimer: number | undefined;
let inspectionScheduled = false;
let captureInFlight = false;

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
    if (capturingRun.adapter.id !== 'grok' && toggle && sourceToggleState(toggle) === 'collapsed') {
      toggle.click();
      const started = Date.now();
      do {
        await delay(100);
        after = domCitationInventory(root, capturingRun.adapter);
      } while (Date.now() - started < 1000 && after.length === before.length);
    }
    await sendContentMessage({
      type: 'content:capture',
      runId: capturingRun.id,
      provider: capturingRun.adapter.id,
      domMarkdown: domToMarkdown(root),
      domCitations: mergeCitationInventories(before, after),
      researchTrail,
      title: root.querySelector('h1, h2, h3')?.textContent?.trim(),
    });
    if (active?.id === capturingRun.id) active.captureSent = true;
  } finally {
    captureInFlight = false;
  }
}

function inspectPage(): void {
  if (!active || active.captureSent) return;
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
  if (isClarifyingResponse(newResponse, adapter.clarifyingPromptPattern)) {
    if (active.status !== 'awaiting_user') void report('awaiting_user', `${adapter.label} is asking a clarifying question.`);
    return;
  }
  const streaming = findElement(adapter.selectors.streamingIndicator);
  if (streaming) {
    active.completionCandidateAt = undefined;
    if (active.status === 'awaiting_user' || active.status === 'manual_required') void report('researching');
    return;
  }
  const root = newResponse;
  if (!root) {
    active.completionCandidateAt = undefined;
    return;
  }
  active.completionCandidateAt ??= Date.now();
  if (Date.now() - active.completionCandidateAt >= active.completionDebounceMs) {
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
  if (active?.id === event.runId) return;
  stopMonitoring();
  const adapter = ADAPTERS[event.provider];
  const finalResponseBaseline = createFinalResponseBaseline(findAll(adapter.selectors.finalMessageRoot));
  active = {
    id: event.runId,
    adapter,
    submittedQuery: event.appendString.trim() ? `${event.query}\n${event.appendString}` : event.query,
    geminiAutoApprove: event.geminiAutoApprove,
    completionDebounceMs: event.completionDebounceMs,
    status: 'opening',
    captureSent: false,
    finalResponseBaseline,
  };
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
      return undefined;
    });
    const hello = () => sendContentMessage({ type: 'content:hello', provider, url: location.href });
    void hello();
  },
});
