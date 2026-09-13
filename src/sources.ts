import { normalizeUrl } from './citations';
import { isEffectivelyHidden } from './selectors';
import type {
  CapturedResearchTrail,
  CapturedSearch,
  CapturedSource,
  Citation,
  ResearchSearchKind,
  ResearchSource,
  ResearchTrail,
} from './types';

const HTTP_URL = /^https?:\/\//i;
const X_STATUS_URL = /^https:\/\/(?:www\.)?x\.com\/[^/]+\/status\/\d+/i;

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function renderedLines(element: Element): string[] {
  const rendered = element instanceof HTMLElement ? element.innerText : element.textContent;
  const lines = (rendered ?? '').split(/\n+/).map(cleanText).filter(Boolean);
  const leaves = Array.from(element.querySelectorAll<HTMLElement>('div, span, p, a'))
    .filter((item) => item.children.length === 0)
    .map((item) => cleanText(item.textContent))
    .filter(Boolean);
  const distinctLeaves = leaves.filter((line, index) => line !== leaves[index - 1]);
  return distinctLeaves.length > lines.length ? distinctLeaves : lines;
}

function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const value = labelledBy.split(/\s+/)
      .map((id) => cleanText(element.ownerDocument.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(' ');
    if (value) return value;
  }
  return cleanText(element.getAttribute('aria-label') || element.getAttribute('title') || (element as HTMLElement).innerText || element.textContent);
}

function sourceFromWebAnchor(anchor: HTMLAnchorElement): CapturedSource {
  const lines = renderedLines(anchor);
  const title = lines[0] || cleanText(anchor.getAttribute('aria-label')) || anchor.hostname;
  const snippet = cleanText(lines.slice(1).join(' '));
  const outboundUrls = Array.from(anchor.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .map((item) => item.href)
    .filter((url) => HTTP_URL.test(url) && normalizeUrl(url) !== normalizeUrl(anchor.href));
  return { url: anchor.href, title, snippet: snippet || undefined, outboundUrls: [...new Set(outboundUrls)] };
}

function sourceFromXAnchor(anchor: HTMLAnchorElement): CapturedSource {
  const spans = Array.from(anchor.querySelectorAll('span')).map((span) => cleanText(span.textContent)).filter(Boolean);
  const handle = spans.find((value) => /^@[A-Za-z0-9_]+$/.test(value));
  const displayName = spans.find((value) => value !== handle && !/^\d{1,2}[hmd]$/i.test(value) && !/^[A-Z][a-z]{2}\s+\d{1,2}$/.test(value));
  const title = handle
    ? `${displayName ? `${displayName} (${handle})` : handle} on X`
    : `${displayName || 'Post'} on X`;
  const snippet = cleanText(anchor.querySelector('p')?.textContent);
  const outboundUrls = Array.from(anchor.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .map((item) => item.href)
    .filter((url) => HTTP_URL.test(url) && normalizeUrl(url) !== normalizeUrl(anchor.href));
  return { url: anchor.href, title, snippet: snippet || undefined, outboundUrls: [...new Set(outboundUrls)] };
}

function parseSearchButton(button: HTMLButtonElement): Omit<CapturedSearch, 'results'> | undefined {
  const lines = renderedLines(button);
  const kindLineIndex = lines.findIndex((line) => /^Searched\s+(?:web|𝕏|X)$/i.test(line));
  const countIndex = lines.findLastIndex((line) => /^\d+$/.test(line));
  if (kindLineIndex < 0 || countIndex <= kindLineIndex + 1) return undefined;
  const kind: ResearchSearchKind = /web/i.test(lines[kindLineIndex]!) ? 'web' : 'x';
  return {
    kind,
    query: cleanText(lines.slice(kindLineIndex + 1, countIndex).join(' ')),
    expectedResultCount: Number(lines[countIndex]),
  };
}

function webResults(panel: HTMLElement): CapturedSource[] {
  const cards = Array.from(panel.querySelectorAll<HTMLElement>('[class*="group/search-result"]'));
  if (cards.length) {
    return cards.flatMap((card) => {
      const anchor = card.querySelector<HTMLAnchorElement>('a[href^="http"]');
      return anchor ? [sourceFromWebAnchor(anchor)] : [];
    });
  }
  const anchors = Array.from(panel.querySelectorAll<HTMLAnchorElement>('a[href^="http"]'));
  const seen = new Set<string>();
  return anchors.flatMap((anchor) => {
    const url = normalizeUrl(anchor.href);
    if (seen.has(url)) return [];
    seen.add(url);
    return [sourceFromWebAnchor(anchor)];
  });
}

function xResults(panel: HTMLElement): CapturedSource[] {
  const anchors = Array.from(panel.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .filter((anchor) => X_STATUS_URL.test(anchor.href))
    .filter((anchor) => !anchor.parentElement?.closest('a[href*="x.com/"][href*="/status/"]'));
  return anchors.map(sourceFromXAnchor);
}

function searchButtons(sidebar: HTMLElement): HTMLButtonElement[] {
  return Array.from(sidebar.querySelectorAll<HTMLButtonElement>('button[aria-controls]'))
    .filter((button) => renderedLines(button).some((line) => /^Searched\s+(?:web|𝕏|X)$/i.test(line)));
}

function findSourcesSidebar(document: Document): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('aside'))
    .find((aside) => !isEffectivelyHidden(aside) && renderedLines(aside).some((line) => line === 'Sources'));
}

function sidebarCloseButton(sidebar: HTMLElement): HTMLButtonElement | undefined {
  return Array.from(sidebar.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => /^close$/i.test(accessibleName(button)));
}

function sidebarBelongsToToggle(sidebar: HTMLElement, toggle: HTMLElement): boolean {
  if (toggle.getAttribute('aria-expanded') !== 'true') return false;
  const controls = toggle.getAttribute('aria-controls')?.split(/\s+/) ?? [];
  return controls.some((id) => {
    const controlled = sidebar.ownerDocument.getElementById(id);
    return controlled === sidebar || Boolean(controlled && sidebar.contains(controlled));
  });
}

function findOpenedPages(sidebar: HTMLElement): CapturedSource[] {
  const candidates = Array.from(sidebar.querySelectorAll<HTMLElement>('div'))
    .filter((element) => renderedLines(element)[0] === 'Opened page')
    .filter((element) => element.querySelector<HTMLAnchorElement>('a[href^="http"]'));
  const smallest = candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other)));
  const seen = new Set<string>();
  return smallest.flatMap((element) => {
    const anchor = element.querySelector<HTMLAnchorElement>('a[href^="http"]');
    if (!anchor) return [];
    const url = normalizeUrl(anchor.href);
    if (seen.has(url)) return [];
    seen.add(url);
    const lines = renderedLines(element);
    return [{ url: anchor.href, title: cleanText(lines.slice(1).join(' ')) || anchor.hostname }];
  });
}

function reportedCount(toggle: HTMLElement): number | undefined {
  const match = accessibleName(toggle).match(/(\d+)\s+sources/i);
  return match ? Number(match[1]) : undefined;
}

async function waitFor<T>(read: () => T | undefined, deadline: number): Promise<T | undefined> {
  let value = read();
  while (value === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = read();
  }
  return value;
}

export async function captureGrokResearchTrail(
  document: Document,
  toggle?: HTMLElement | null,
  timeoutMs = 5000,
): Promise<CapturedResearchTrail> {
  const warnings: string[] = [];
  const total = toggle ? reportedCount(toggle) : undefined;
  let sidebar = findSourcesSidebar(document);
  if (!toggle) {
    return { reportedResultCount: total, searches: [], openedPages: [], warnings: ['Grok Sources control was not found.'] };
  }
  // An open sidebar may belong to an older answer. Close it before activating
  // the requested answer unless its expanded control explicitly owns the panel.
  if (sidebar && !sidebarBelongsToToggle(sidebar, toggle)) {
    const close = sidebarCloseButton(sidebar);
    close?.click();
    const priorSidebar = sidebar;
    const closed = close && await waitFor(
      () => !priorSidebar.isConnected || isEffectivelyHidden(priorSidebar) ? true : undefined,
      Date.now() + Math.min(timeoutMs, 3000),
    );
    if (!closed) {
      return { reportedResultCount: total, searches: [], openedPages: [], warnings: ['Could not verify which answer owns the open Grok Sources sidebar.'] };
    }
    sidebar = undefined;
  }
  const openedByCapture = !sidebar;
  if (!sidebar) {
    toggle.click();
    sidebar = await waitFor(() => findSourcesSidebar(document), Date.now() + Math.min(timeoutMs, 3000));
  }
  if (!sidebar) {
    warnings.push('Grok Sources sidebar did not open.');
    return { reportedResultCount: total, searches: [], openedPages: [], warnings };
  }

  const buttons = searchButtons(sidebar);
  if (!buttons.length) warnings.push('No Grok search groups were found in the Sources sidebar.');
  const searches: CapturedSearch[] = [];
  const groupWaitMs = Math.max(50, Math.floor(timeoutMs / Math.max(1, buttons.length)));
  for (const button of buttons) {
    const parsed = parseSearchButton(button);
    if (!parsed) {
      warnings.push('A Grok search group heading could not be parsed.');
      continue;
    }
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    const groupDeadline = Date.now() + groupWaitMs;
    const panelId = button.getAttribute('aria-controls');
    const panel = panelId
      ? await waitFor(() => document.getElementById(panelId) as HTMLElement | null || undefined, groupDeadline)
      : undefined;
    if (!panel) {
      warnings.push(`The ${parsed.kind} search “${parsed.query}” did not expose a results panel.`);
      searches.push({ ...parsed, results: [] });
      continue;
    }
    const readResults = () => parsed.kind === 'web' ? webResults(panel) : xResults(panel);
    let results = readResults();
    while (results.length < parsed.expectedResultCount && Date.now() < groupDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      results = readResults();
    }
    if (results.length !== parsed.expectedResultCount) {
      warnings.push(`The ${parsed.kind} search “${parsed.query}” reported ${parsed.expectedResultCount} results but ${results.length} were captured.`);
    }
    searches.push({ ...parsed, results });
  }

  const openedPages = findOpenedPages(sidebar);
  const capturedCount = searches.reduce((sum, search) => sum + search.results.length, 0);
  if (total !== undefined && capturedCount !== total) {
    warnings.push(`Grok reported ${total} sources but ${capturedCount} search results were captured.`);
  }

  if (openedByCapture) {
    sidebarCloseButton(sidebar)?.click();
  }
  return { reportedResultCount: total, searches, openedPages, warnings: [...new Set(warnings)] };
}

export function normalizeResearchTrail(captured: CapturedResearchTrail, citations: Citation[]): ResearchTrail {
  const sources: ResearchSource[] = [];
  const byUrl = new Map<string, ResearchSource>();
  const citedUrls = new Set(citations.map((citation) => normalizeUrl(citation.url)));
  const warnings = [...captured.warnings];

  const merge = (candidate: CapturedSource, searchIndex?: number, opened = false): ResearchSource | undefined => {
    if (!HTTP_URL.test(candidate.url)) return undefined;
    const url = normalizeUrl(candidate.url);
    let source = byUrl.get(url);
    if (!source) {
      source = {
        id: `SRC-${String(sources.length + 1).padStart(3, '0')}`,
        url,
        title: cleanText(candidate.title) || url,
        snippet: cleanText(candidate.snippet) || undefined,
        outboundUrls: [],
        searchIndexes: [],
        opened: false,
        cited: citedUrls.has(url),
      };
      sources.push(source);
      byUrl.set(url, source);
    } else if (cleanText(candidate.snippet).length > cleanText(source.snippet).length) {
      source.snippet = cleanText(candidate.snippet);
    }
    if (searchIndex !== undefined && !source.searchIndexes.includes(searchIndex)) source.searchIndexes.push(searchIndex);
    source.opened ||= opened;
    for (const outbound of candidate.outboundUrls ?? []) {
      if (!HTTP_URL.test(outbound)) continue;
      const normalized = normalizeUrl(outbound);
      if (normalized !== url && !source.outboundUrls.includes(normalized)) source.outboundUrls.push(normalized);
    }
    return source;
  };

  const searches = captured.searches.map((search, offset) => {
    const index = offset + 1;
    const sourceIds = search.results.flatMap((candidate) => {
      const source = merge(candidate, index);
      return source ? [source.id] : [];
    });
    const mismatchAlreadyReported = warnings.some((warning) => warning.includes(`search “${search.query}” reported`));
    if (sourceIds.length !== search.expectedResultCount && !mismatchAlreadyReported) {
      warnings.push(`Search ${index} expected ${search.expectedResultCount} results but captured ${sourceIds.length}.`);
    }
    return {
      index,
      kind: search.kind,
      query: search.query,
      expectedResultCount: search.expectedResultCount,
      capturedResultCount: sourceIds.length,
      sourceIds,
    };
  });
  for (const opened of captured.openedPages) merge(opened, undefined, true);

  const capturedResultCount = searches.reduce((sum, search) => sum + search.capturedResultCount, 0);
  const expectedResultCount = captured.reportedResultCount
    ?? searches.reduce((sum, search) => sum + search.expectedResultCount, 0);
  const totalMismatchAlreadyReported = warnings.some((warning) => warning.includes(`Grok reported ${expectedResultCount} sources`));
  if (capturedResultCount !== expectedResultCount && !totalMismatchAlreadyReported) {
    warnings.push(`Expected ${expectedResultCount} total search results but captured ${capturedResultCount}.`);
  }
  const uniqueWarnings = [...new Set(warnings)];
  return {
    searches,
    sources,
    expectedResultCount,
    capturedResultCount,
    complete: uniqueWarnings.length === 0 && capturedResultCount === expectedResultCount,
    warnings: uniqueWarnings,
  };
}
