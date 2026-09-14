import type { ProviderAdapter } from './adapters';
import { normalizeUrl } from './citations';
import { cloneVisibleContent, findAll, isEffectivelyHidden } from './selectors';
import type { DomCitation } from './types';

const DOM_ONLY_COMPLETION_MIN_CHARS = 1000;
const DOM_ONLY_COMPLETION_MIN_MS = 30_000;
const RESPONSE_CONTENT_EXCLUSIONS = 'button, script, style, svg, form, input, textarea';

export function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function citationAnchors(root: HTMLElement, adapter: ProviderAdapter): HTMLAnchorElement[] {
  return findAll(adapter.selectors.citationAnchors, root, { extractionRoot: root })
    .filter((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement);
}

export function domCitationCount(root: HTMLElement, adapter: ProviderAdapter): number {
  return citationAnchors(root, adapter).filter((anchor) => anchor.href.startsWith('http')).length;
}

export function domCitationInventory(root: HTMLElement, adapter: ProviderAdapter, snapshot?: ResponseSnapshot): DomCitation[] {
  const anchors = citationAnchors(root, adapter);
  const fullText = (snapshot?.root === root ? snapshot : createResponseSnapshot(root)).text;
  let cursor = 0;
  return anchors.flatMap((anchor, domOrder) => {
    const url = anchor.href;
    if (!url.startsWith('http')) return [];
    const markerText = normalizeVisibleText(anchor.innerText || anchor.textContent || '');
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

export function mergeCitationInventories(before: DomCitation[], after: DomCitation[]): DomCitation[] {
  if (!after.length) return before.map((citation, domOrder) => ({ ...citation, domOrder }));
  const occurrenceKey = (citation: DomCitation) => normalizeUrl(citation.url);
  const remainingAfter = new Map<string, number>();
  for (const citation of after) {
    const key = occurrenceKey(citation);
    remainingAfter.set(key, (remainingAfter.get(key) ?? 0) + 1);
  }
  const beforeOnly = before.filter((citation) => {
    const key = occurrenceKey(citation);
    const remaining = remainingAfter.get(key) ?? 0;
    if (!remaining) return true;
    remainingAfter.set(key, remaining - 1);
    return false;
  });
  return [...after, ...beforeOnly].map((citation, domOrder) => ({ ...citation, domOrder }));
}

export type ToggleState = 'expanded' | 'collapsed' | 'unknown';

export function sourceToggleState(toggle: HTMLElement): ToggleState {
  const expanded = toggle.getAttribute('aria-expanded')?.toLowerCase();
  if (expanded === 'true') return 'expanded';
  if (expanded === 'false') return 'collapsed';
  const state = toggle.getAttribute('data-state')?.toLowerCase();
  if (state === 'open' || state === 'expanded') return 'expanded';
  if (state === 'closed' || state === 'collapsed') return 'collapsed';
  return 'unknown';
}

export function shouldOpenSourceToggle(toggle: HTMLElement): boolean {
  return sourceToggleState(toggle) !== 'expanded';
}

export function cloneResponseContent(root: HTMLElement): HTMLElement {
  return cloneVisibleContent(root, RESPONSE_CONTENT_EXCLUSIONS);
}

export interface ResponseSnapshot {
  root: HTMLElement;
  content: HTMLElement;
  text: string;
}

const DURATION = String.raw`(?:\d{1,3}:\d{2}(?::\d{2})?|(?:\d+\s*(?:h(?:ours?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\s*){1,3})`;
const BARE_DURATION = new RegExp(`^${DURATION}$`, 'i');
const EXPLICIT_ELAPSED_DURATION = new RegExp(`^(?:elapsed(?: time)?[:\\s]+${DURATION}|${DURATION}\\s+elapsed)$`, 'i');
const REPORT_BEARING_ELEMENT = 'p, li, h1, h2, h3, h4, h5, h6, table, thead, tbody, tfoot, tr, th, td';

function isElapsedTimerElement(element: Element): boolean {
  if (element.matches(REPORT_BEARING_ELEMENT) || element.querySelector(REPORT_BEARING_ELEMENT)) return false;
  const text = normalizeVisibleText(element.textContent ?? '');
  if (EXPLICIT_ELAPSED_DURATION.test(text)) return true;
  if (!BARE_DURATION.test(text)) return false;
  return [element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('data-testid')]
    .some((value) => value !== null && /\belapsed(?:[\s_-]+(?:time|timer))?\b/i.test(value));
}

const TEXT_BOUNDARY_ELEMENTS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

function structurallySeparatedText(root: HTMLElement): string {
  let output = '';
  const boundary = () => {
    if (output && !/\s$/.test(output)) output += ' ';
  };
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      output += node.textContent ?? '';
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const separatesText = TEXT_BOUNDARY_ELEMENTS.has(node.tagName);
    if (separatesText) boundary();
    for (const child of Array.from(node.childNodes)) visit(child);
    if (separatesText) boundary();
  };
  visit(root);
  return normalizeVisibleText(output);
}

export function createResponseSnapshot(root: HTMLElement): ResponseSnapshot {
  const content = cloneResponseContent(root);
  for (const element of Array.from(content.querySelectorAll('*'))) {
    if (isElapsedTimerElement(element)) element.remove();
  }
  return { root, content, text: structurallySeparatedText(content) };
}

function isTextMatch(text: string, pattern?: RegExp, maximumLength?: number): boolean {
  if (!pattern || !text || (maximumLength !== undefined && text.length > maximumLength)) return false;
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function isResponseMatch(root: HTMLElement | null, pattern?: RegExp, maximumLength?: number, snapshot?: ResponseSnapshot): boolean {
  if (!root || !pattern) return false;
  const text = snapshot?.root === root ? snapshot.text : createResponseSnapshot(root).text;
  return isTextMatch(text, pattern, maximumLength);
}

export function isClarifyingResponse(root: HTMLElement | null, pattern?: RegExp, snapshot?: ResponseSnapshot): boolean {
  return isResponseMatch(root, pattern, 5000, snapshot);
}

export function isProgressResponse(root: HTMLElement | null, pattern?: RegExp, copyAvailable = false, snapshot?: ResponseSnapshot): boolean {
  if (!root) return false;
  const response = snapshot?.root === root ? snapshot : createResponseSnapshot(root);
  const { content, text } = response;
  const hasReportBody = Array.from(content.querySelectorAll('p, li, table'))
    .some((element) => normalizeVisibleText(element.textContent ?? '').length >= 80);
  if (copyAvailable && content.querySelector('h1, h2, h3') && hasReportBody) return false;
  if (isTextMatch(text, pattern, 1000)) return true;
  if (text.length >= 40) return false;
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button'))
    .filter((button) => !isEffectivelyHidden(button, { extractionRoot: root }))
    .some((button) => isTextMatch(normalizeVisibleText(button.innerText || button.textContent || ''), pattern, 1000));
}

export function isQuotaResponse(root: HTMLElement | null, pattern?: RegExp, snapshot?: ResponseSnapshot): boolean {
  return isResponseMatch(root, pattern, 2000, snapshot);
}

export interface FinalResponseBaseline {
  roots: ReadonlySet<HTMLElement>;
  signatures: ReadonlySet<string>;
}

function finalResponseSignature(root: HTMLElement): string {
  const stableId = root.getAttribute('data-message-id') || root.id;
  return stableId ? `id:${stableId}` : `text:${normalizeVisibleText(root.innerText || root.textContent || '')}`;
}

export function finalResponseFingerprint(root: HTMLElement, snapshot?: ResponseSnapshot): string {
  const stableId = root.getAttribute('data-message-id') || root.id;
  const text = (snapshot?.root === root ? snapshot : createResponseSnapshot(root)).text;
  return `${stableId ? `id:${stableId}` : 'anonymous'}\u0000${text}`;
}

export interface StableResponseCandidate {
  fingerprint: string;
  since: number;
}

export function evaluateStableResponse(
  root: HTMLElement | null,
  copyAvailable: boolean,
  candidate: StableResponseCandidate | undefined,
  now: number,
  debounceMs: number,
  snapshot?: ResponseSnapshot,
): { candidate?: StableResponseCandidate; ready: boolean } {
  if (!root) return { ready: false };
  const text = (snapshot?.root === root ? snapshot : createResponseSnapshot(root)).text;
  if (text.length < (copyAvailable ? 1 : DOM_ONLY_COMPLETION_MIN_CHARS)) return { ready: false };
  const fingerprint = `${root.getAttribute('data-message-id') || root.id}\u0000${text}`;
  if (candidate?.fingerprint !== fingerprint) {
    return { candidate: { fingerprint, since: now }, ready: false };
  }
  const requiredStabilityMs = copyAvailable ? debounceMs : Math.max(DOM_ONLY_COMPLETION_MIN_MS, debounceMs * 3);
  return { candidate, ready: now - candidate.since >= requiredStabilityMs };
}

export function createFinalResponseBaseline(roots: readonly HTMLElement[]): FinalResponseBaseline {
  return {
    roots: new Set(roots),
    signatures: new Set(roots.map(finalResponseSignature)),
  };
}

export function isNewFinalResponse(root: HTMLElement | null, baseline: FinalResponseBaseline): root is HTMLElement {
  return Boolean(root && !baseline.roots.has(root) && !baseline.signatures.has(finalResponseSignature(root)));
}
