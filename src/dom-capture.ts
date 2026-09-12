import type { ProviderAdapter } from './adapters';
import { normalizeUrl } from './citations';
import { findAll } from './selectors';
import type { DomCitation } from './types';

export function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function domCitationInventory(root: HTMLElement, adapter: ProviderAdapter): DomCitation[] {
  const anchors = findAll(adapter.selectors.citationAnchors, root)
    .filter((element): element is HTMLAnchorElement => element instanceof HTMLAnchorElement);
  const fullText = normalizeVisibleText(root.innerText || root.textContent || '');
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
  const merged = new Map<string, DomCitation>();
  for (const citation of [...before, ...after]) {
    const key = `${normalizeUrl(citation.url)}\u0000${citation.domOrder}`;
    merged.set(key, citation);
  }
  return [...merged.values()]
    .sort((left, right) => left.domOrder - right.domOrder)
    .map((citation, domOrder) => ({ ...citation, domOrder }));
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

export function isClarifyingResponse(root: HTMLElement | null, pattern?: RegExp, maximumLength = 600): boolean {
  if (!root || !pattern) return false;
  const text = normalizeVisibleText(root.innerText || root.textContent || '');
  if (!text || text.length > maximumLength) return false;
  pattern.lastIndex = 0;
  return pattern.test(text);
}
