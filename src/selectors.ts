import type { Selector, SelectorChain } from './adapters';

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

export function findElement(chain: SelectorChain, root: ParentNode = document, excludedRoots: readonly HTMLElement[] = []): HTMLElement | null {
  for (const selector of chain) {
    let results: HTMLElement[];
    try {
      results = allForSelector(selector, root).filter((element) => isVisible(element) && !excludedRoots.some((excluded) => excluded.contains(element)));
    } catch {
      continue;
    }
    if (results.length) return selector.pick === 'last' ? results.at(-1)! : results[0]!;
  }
  return null;
}

export function findAll(chain: SelectorChain, root: ParentNode = document): HTMLElement[] {
  for (const selector of chain) {
    try {
      const results = allForSelector(selector, root).filter(isVisible);
      if (results.length) return results;
    } catch {
      // Try the next selector in the chain.
    }
  }
  return [];
}

export function isVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && !element.hasAttribute('disabled')
    && element.getAttribute('aria-disabled')?.toLowerCase() !== 'true'
    && (rect.width > 0 || rect.height > 0 || style.position === 'fixed');
}
