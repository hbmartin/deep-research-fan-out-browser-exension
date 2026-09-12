import TurndownService from 'turndown';
import { ADAPTERS, providerFromLocation, type ProviderAdapter } from '@/src/adapters';
import { injectQuery, submitWithEnter } from '@/src/injection';
import type { BackgroundEvent, RuntimeRequest } from '@/src/messages';
import { findAll, findElement, isVisible } from '@/src/selectors';
import type { DomCitation, ProviderRunStatus, RunId } from '@/src/types';

interface ActiveRun {
  id: RunId;
  adapter: ProviderAdapter;
  submittedQuery: string;
  geminiAutoApprove: boolean;
  completionDebounceMs: number;
  status: ProviderRunStatus;
  completionCandidateAt?: number;
  captureSent: boolean;
}

let active: ActiveRun | undefined;
let observer: MutationObserver | undefined;
let sweepTimer: number | undefined;
let inspectionScheduled = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function send(message: RuntimeRequest): Promise<void> {
  await browser.runtime.sendMessage(message).catch(() => undefined);
}

async function report(status: ProviderRunStatus, detail?: string, submittedAt?: number): Promise<void> {
  if (!active) return;
  active.status = status;
  await send({ type: 'content:state', runId: active.id, provider: active.adapter.id, status, detail, submittedAt });
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
    if (findElement(adapter.selectors.quotaNotice)) return report('quota_exhausted', `${adapter.label} deep research limit reached.`);
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

function domCitationInventory(root: HTMLElement, adapter: ProviderAdapter): DomCitation[] {
  const anchors = findAll(adapter.selectors.citationAnchors, root).filter((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement);
  const fullText = (root.innerText || root.textContent || '').replace(/\s+/g, ' ');
  let cursor = 0;
  return anchors.flatMap((anchor, domOrder) => {
    const url = anchor.href;
    if (!url.startsWith('http')) return [];
    const markerText = (anchor.innerText || anchor.textContent || '').trim();
    let position = markerText ? fullText.indexOf(markerText, cursor) : cursor;
    if (position < 0) position = cursor;
    cursor = position + markerText.length;
    return [{
      url,
      title: anchor.getAttribute('aria-label') || anchor.getAttribute('title') || markerText || undefined,
      markerText: markerText || undefined,
      domOrder,
      contextBefore: fullText.slice(Math.max(0, position - 120), position),
      contextAfter: fullText.slice(cursor, cursor + 60),
    }];
  });
}

function domToMarkdown(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('button, script, style, svg, [aria-hidden="true"]').forEach((element) => element.remove());
  const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  turndown.addRule('removeUnsafe', { filter: ['form', 'input', 'textarea'], replacement: () => '' });
  return turndown.turndown(clone).trim();
}

async function capture(root: HTMLElement): Promise<void> {
  if (!active || active.captureSent) return;
  active.captureSent = true;
  await report('capturing');
  const toggle = active.adapter.selectors.sourcesPanelToggle && (findElement(active.adapter.selectors.sourcesPanelToggle, root) || findElement(active.adapter.selectors.sourcesPanelToggle));
  if (toggle) {
    toggle.click();
    await delay(300);
  }
  await send({
    type: 'content:capture',
    runId: active.id,
    provider: active.adapter.id,
    domMarkdown: domToMarkdown(root),
    domCitations: domCitationInventory(root, active.adapter),
    title: root.querySelector('h1, h2, h3')?.textContent?.trim(),
  });
}

function inspectPage(): void {
  if (!active || active.captureSent) return;
  const { adapter } = active;
  if (location.origin !== adapter.origin) {
    void report('interrupted', 'Provider tab navigated away.');
    stopMonitoring();
    return;
  }
  if (findElement(adapter.selectors.quotaNotice)) {
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
  if (adapter.selectors.clarifyingPrompt && findElement(adapter.selectors.clarifyingPrompt)) {
    if (active.status !== 'awaiting_user') void report('awaiting_user', `${adapter.label} is asking a clarifying question.`);
    return;
  }
  const streaming = findElement(adapter.selectors.streamingIndicator);
  if (streaming) {
    active.completionCandidateAt = undefined;
    if (active.status === 'awaiting_user' || active.status === 'manual_required') void report('researching');
    return;
  }
  const root = findElement(adapter.selectors.finalMessageRoot);
  const copy = root ? findElement(adapter.selectors.copyButton, root) || findElement(adapter.selectors.copyButton) : null;
  if (!root || !copy) {
    active.completionCandidateAt = undefined;
    return;
  }
  active.completionCandidateAt ??= Date.now();
  if (Date.now() - active.completionCandidateAt >= active.completionDebounceMs) void capture(root);
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
  active = {
    id: event.runId,
    adapter,
    submittedQuery: event.appendString.trim() ? `${event.query}\n${event.appendString}` : event.query,
    geminiAutoApprove: event.geminiAutoApprove,
    completionDebounceMs: event.completionDebounceMs,
    status: 'opening',
    captureSent: false,
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
    const hello = () => send({ type: 'content:hello', provider, url: location.href });
    void hello();
    window.setInterval(hello, 10_000);
  },
});
