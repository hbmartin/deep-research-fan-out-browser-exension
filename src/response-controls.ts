import type { ProviderAdapter, SelectorChain } from './adapters';
import { findAll, isVisible } from './selectors';

const PAGE_BOUNDARY = 'html, body, main, [role="main"], [role="dialog"], dialog, aside';
const EXCLUDED_CONTROL = 'pre, code, table, form, [contenteditable="true"], textarea, [data-message-author-role="user"], [role="dialog"], dialog, aside';
const DISCOVERY = { allowTransparent: true, ignoreAncestorAriaHidden: true, ignoreAncestorOpacity: true } as const;

interface Container { roots: HTMLElement[] }

/** Short-lived index: ancestry is built once, never once per response/control pair. */
export class ResponseControlIndex {
  private roots: Set<HTMLElement>;
  private containers = new Map<HTMLElement, Container>();
  private owners = new Map<HTMLElement, HTMLElement | undefined>();
  private candidates = new Map<SelectorChain, HTMLElement[]>();
  ancestorVisits = 0;

  constructor(roots: readonly HTMLElement[], _adapter?: ProviderAdapter) {
    this.roots = new Set(roots);
    for (const root of roots) {
      for (let node: HTMLElement | null = root; node; node = node.parentElement) {
        this.ancestorVisits++;
        const info = this.containers.get(node) ?? { roots: [] };
        info.roots.push(root);
        this.containers.set(node, info);
        if (node.matches(PAGE_BOUNDARY)) break;
      }
    }
  }

  owner(candidate: HTMLElement): HTMLElement | undefined {
    if (this.owners.has(candidate)) return this.owners.get(candidate);
    const owner = this.resolveOwner(candidate);
    this.owners.set(candidate, owner);
    return owner;
  }

  private resolveOwner(candidate: HTMLElement): HTMLElement | undefined {
    if (candidate.closest(EXCLUDED_CONTROL)) return undefined;
    for (const id of (candidate.getAttribute('aria-controls') ?? '').split(/\s+/)) {
      if (!id) continue;
      const controlled = document.getElementById(id);
      const info = controlled ? this.containers.get(controlled) : undefined;
      const owner = info?.roots.length === 1 ? info.roots[0] : undefined;
      if (owner) {
        for (let node: HTMLElement | null = candidate; node; node = node.parentElement) {
          if (node.matches(PAGE_BOUNDARY)) break;
          if (node.contains(owner)) return owner;
        }
      }
    }
    for (let node: HTMLElement | null = candidate; node; node = node.parentElement) {
      this.ancestorVisits++;
      if (this.roots.has(node)) return node;
      if (node.matches(PAGE_BOUNDARY)) return undefined;
      const info = this.containers.get(node);
      if (!info) continue;
      if (info.roots.length === 1) return info.roots[0];
      let preceding: HTMLElement | undefined;
      for (const root of info.roots) {
        if (!(root.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        if (!preceding || (preceding.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING)) preceding = root;
      }
      return preceding;
    }
    return undefined;
  }

  find(root: HTMLElement, selectors: SelectorChain, baseline: ReadonlySet<HTMLElement> = new Set(), hover = false, includeBlocked = false): HTMLElement | null {
    let candidates = this.candidates.get(selectors);
    if (!candidates) {
      candidates = findAll(selectors, document, DISCOVERY);
      this.candidates.set(selectors, candidates);
    }
    let result: HTMLElement | null = null;
    let contained: HTMLElement | null = null;
    for (const candidate of candidates) {
      if (!candidate.isConnected || baseline.has(candidate) || this.owner(candidate) !== root) continue;
      if (!includeBlocked && !isResponseControlActionable(candidate, hover, root)) continue;
      result = candidate;
      if (root.contains(candidate)) contained = candidate;
    }
    return contained ?? result;
  }
}

export function isResponseControlActionable(control: HTMLElement, hover = false, root?: HTMLElement): boolean {
  let container: HTMLElement | undefined;
  if (hover && root) {
    for (let node = control.parentElement; node; node = node.parentElement) {
      if (node.contains(root) || node === root) { container = node; break; }
    }
  }
  return control.isConnected && !control.closest('[inert]')
    && isVisible(control, hover ? { allowTransparent: true, transparentWithin: container } : {});
}
