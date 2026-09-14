import type { ProviderAdapter, SelectorChain } from './adapters';
import { findAll, isVisible } from './selectors';

const PAGE_BOUNDARY = 'html, body, main, [role="main"], [role="dialog"], dialog, aside';
const FOREIGN_REGION = 'form, [contenteditable="true"], textarea, [data-message-author-role="user"], [role="dialog"], dialog, aside';
const EXCLUDED_CONTROL = 'pre, code, table';
const TURN = 'section, article, [data-message-id], [data-testid^="conversation-turn"]';
const DISCOVERY = { allowTransparent: true, ignoreAncestorAriaHidden: true, ignoreAncestorOpacity: true } as const;

interface Container { roots: HTMLElement[] }

/** Short-lived index: ancestry is built once, never once per response/control pair. */
export class ResponseControlIndex {
  private roots: Set<HTMLElement>;
  private containers = new Map<HTMLElement, Container>();
  private foreignContainers = new Set<HTMLElement>();
  private uniqueIds = new Map<string, HTMLElement | undefined>();
  private owners = new Map<HTMLElement, HTMLElement | undefined>();
  private candidates = new Map<SelectorChain, HTMLElement[]>();
  ancestorVisits = 0;

  constructor(roots: readonly HTMLElement[], private adapter?: ProviderAdapter) {
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
    for (const region of document.querySelectorAll<HTMLElement>(FOREIGN_REGION)) {
      for (let node: HTMLElement | null = region; node; node = node.parentElement) {
        this.ancestorVisits++;
        if (this.foreignContainers.has(node)) break;
        this.foreignContainers.add(node);
        if (node.matches(PAGE_BOUNDARY)) break;
      }
    }
    for (const element of document.querySelectorAll<HTMLElement>('[id]')) {
      const id = element.id;
      if (!id) continue;
      this.uniqueIds.set(id, this.uniqueIds.has(id) ? undefined : element);
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
    const candidateRegion = candidate.closest(FOREIGN_REGION);
    for (let node: HTMLElement | null = candidate; node; node = node.parentElement) {
      if (this.roots.has(node)) {
        return candidateRegion === node.closest(FOREIGN_REGION) ? node : undefined;
      }
      if (node.matches(PAGE_BOUNDARY)) break;
    }
    const controlledIds = (candidate.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean);
    let controlledOwner: HTMLElement | undefined;
    for (const id of controlledIds) {
      const controlled = this.uniqueIds.get(id);
      if (!controlled) return undefined;
      let controlledNode: HTMLElement | null = controlled;
      let info: Container | undefined;
      while (controlledNode && !info) {
        info = this.containers.get(controlledNode);
        if (controlledNode.matches(PAGE_BOUNDARY)) break;
        controlledNode = controlledNode.parentElement;
      }
      const owner = info?.roots.length === 1 ? info.roots[0] : undefined;
      if (!owner || candidate.closest(PAGE_BOUNDARY) !== owner.closest(PAGE_BOUNDARY)
        || candidateRegion !== owner.closest(FOREIGN_REGION)
        || (controlledOwner && controlledOwner !== owner)) return undefined;
      controlledOwner = owner;
    }
    if (controlledOwner) return controlledOwner;
    for (let node: HTMLElement | null = candidate; node; node = node.parentElement) {
      this.ancestorVisits++;
      if (node.matches(PAGE_BOUNDARY)) return undefined;
      const info = this.containers.get(node);
      if (!info) continue;
      const providerContainer = this.adapter?.responseContainerSelector;
      if ((!node.matches(TURN) && !(providerContainer && node.matches(providerContainer)))
        || this.foreignContainers.has(node)) continue;
      let preceding: HTMLElement | undefined;
      for (const root of info.roots) {
        if (candidateRegion !== root.closest(FOREIGN_REGION)) continue;
        if (!(root.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        if (!preceding || (preceding.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING)) preceding = root;
      }
      if (preceding) return preceding;
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
