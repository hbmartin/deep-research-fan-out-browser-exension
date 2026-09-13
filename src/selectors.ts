import type { Selector, SelectorChain } from './adapters';

export interface VisibilityOptions {
  allowTransparent?: boolean;
  ignoreAncestorAriaHidden?: boolean;
  ignoreAncestorOpacity?: boolean;
}

function implicitRole(element: Element): string | null {
  if (element.hasAttribute('role')) return element.getAttribute('role');
  if (element instanceof HTMLButtonElement) return 'button';
  if (element instanceof HTMLTextAreaElement) return 'textbox';
  if (element instanceof HTMLInputElement) {
    switch (element.type) {
      case 'button':
      case 'image':
      case 'reset':
      case 'submit': return 'button';
      case 'checkbox': return 'checkbox';
      case 'radio': return 'radio';
      case 'number': return 'spinbutton';
      case 'range': return 'slider';
      case 'search': return element.list ? 'combobox' : 'searchbox';
      case 'email':
      case 'tel':
      case 'text':
      case 'url': return element.list ? 'combobox' : 'textbox';
      default: return null;
    }
  }
  if (element instanceof HTMLAnchorElement) return 'link';
  return null;
}

function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const label = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    if (label) return label;
  }
  return (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').trim();
}

function matches(value: string, expected?: string | RegExp): boolean {
  if (expected === undefined) return true;
  return typeof expected === 'string' ? value.toLowerCase() === expected.toLowerCase() : expected.test(value);
}

function allForSelector(selector: Selector, root: ParentNode): HTMLElement[] {
  if (selector.kind === 'css') return Array.from(root.querySelectorAll<HTMLElement>(selector.value));
  if (selector.kind === 'testid') {
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(selector.value) : selector.value.replace(/["\\]/g, '\\$&');
    return Array.from(root.querySelectorAll<HTMLElement>(`[data-testid="${escaped}"], [data-test-id="${escaped}"]`));
  }
  const scope = selector.kind === 'text' && selector.within ? root.querySelector(selector.within) ?? root : root;
  const elements = Array.from(scope.querySelectorAll<HTMLElement>('*'));
  if (selector.kind === 'aria') {
    return elements.filter((element) => implicitRole(element) === selector.role && matches(accessibleName(element), selector.name));
  }
  return elements.filter((element) => element.children.length === 0 && matches((element.textContent ?? '').trim(), selector.value));
}

export function findElement(
  chain: SelectorChain,
  root: ParentNode = document,
  excludedRoots: readonly HTMLElement[] = [],
  visibilityOptions: VisibilityOptions = {},
): HTMLElement | null {
  for (const selector of chain) {
    let results: HTMLElement[];
    try {
      results = allForSelector(selector, root)
        .filter((element) => isVisible(element, visibilityOptions) && !excludedRoots.some((excluded) => excluded.contains(element)));
    } catch {
      continue;
    }
    if (results.length) return selector.pick === 'last' ? results.at(-1)! : results[0]!;
  }
  return null;
}

export function findAll(chain: SelectorChain, root: ParentNode = document, visibilityOptions: VisibilityOptions = {}): HTMLElement[] {
  for (const selector of chain) {
    try {
      const results = allForSelector(selector, root).filter((element) => isVisible(element, visibilityOptions));
      if (results.length) return results;
    } catch {
      // Try the next selector in the chain.
    }
  }
  return [];
}

function isUntilFound(element: HTMLElement): boolean {
  return element.getAttribute('hidden')?.toLowerCase() === 'until-found';
}

export function isEffectivelyHidden(element: HTMLElement, options: VisibilityOptions = {}): boolean {
  const elementStyle = getComputedStyle(element);
  if (elementStyle.visibility === 'hidden' || elementStyle.visibility === 'collapse') return true;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = current === element ? elementStyle : getComputedStyle(current);
    const opacity = Number.parseFloat(style.opacity);
    const ancestor = current !== element;
    if ((current.hidden && !isUntilFound(current))
      || (!(ancestor && options.ignoreAncestorAriaHidden) && current.getAttribute('aria-hidden')?.toLowerCase() === 'true')
      || style.display === 'none'
      || (!(ancestor && options.ignoreAncestorOpacity) && !options.allowTransparent && !Number.isNaN(opacity) && opacity <= 0)) return true;
  }
  return false;
}

export function isVisible(element: HTMLElement, options: VisibilityOptions = {}): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return !isEffectivelyHidden(element, options)
    && !element.hasAttribute('disabled')
    && element.getAttribute('aria-disabled')?.toLowerCase() !== 'true'
    && (rect.width > 0 || rect.height > 0 || style.position === 'fixed');
}

export function cloneVisibleContent(root: HTMLElement, excludedSelector: string): HTMLElement {
  const clone = root.cloneNode(true) as HTMLElement;

  const prune = (originalParent: HTMLElement, cloneParent: HTMLElement, hiddenByAncestor: boolean): void => {
    const originalChildren = Array.from(originalParent.children) as HTMLElement[];
    const cloneChildren = Array.from(cloneParent.children) as HTMLElement[];
    for (let index = 0; index < originalChildren.length; index += 1) {
      const original = originalChildren[index]!;
      const copy = cloneChildren[index]!;
      if (original.matches(excludedSelector)) {
        copy.remove();
        continue;
      }
      const style = getComputedStyle(original);
      const opacity = Number.parseFloat(style.opacity);
      const irreversiblyHidden = hiddenByAncestor
        || (original.hidden && !isUntilFound(original))
        || original.getAttribute('aria-hidden')?.toLowerCase() === 'true'
        || style.display === 'none'
        || (!Number.isNaN(opacity) && opacity <= 0);
      if (irreversiblyHidden) {
        copy.remove();
        continue;
      }
      const visibilityHidden = style.visibility === 'hidden' || style.visibility === 'collapse';
      if (visibilityHidden) {
        for (const child of Array.from(copy.childNodes)) {
          if (child.nodeType === Node.TEXT_NODE) child.remove();
        }
      }
      prune(original, copy, false);
      if (visibilityHidden && !(copy.textContent ?? '').trim() && copy.children.length === 0) copy.remove();
    }
  };

  // The response root is an extraction boundary. Temporary state on an outer
  // dialog or sheet must not erase the response, while hidden descendants are
  // still pruned from the exported content.
  prune(root, clone, false);
  return clone;
}
