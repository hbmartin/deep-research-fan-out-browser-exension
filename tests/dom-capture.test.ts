import { describe, expect, it } from 'vitest';
import { ADAPTERS } from '../src/adapters';
import { domCitationInventory, isClarifyingResponse, mergeCitationInventories, sourceToggleState } from '../src/dom-capture';
import { findElement } from '../src/selectors';

function visible(element: HTMLElement): HTMLElement {
  element.style.position = 'fixed';
  return element;
}

describe('provider DOM capture', () => {
  it('uses the same whitespace normalization for multiline anchors and report text', () => {
    const root = visible(document.createElement('article'));
    const anchor = visible(document.createElement('a')) as HTMLAnchorElement;
    anchor.href = 'https://example.com/source';
    anchor.textContent = 'Source title';
    root.append('Evidence before ', anchor, ' evidence after');
    Object.defineProperty(root, 'innerText', { configurable: true, value: 'Evidence before Source\n  title evidence after' });
    Object.defineProperty(anchor, 'innerText', { configurable: true, value: 'Source\n  title' });
    document.body.replaceChildren(root);

    const inventory = domCitationInventory(root, ADAPTERS.chatgpt);
    expect(inventory[0]?.markerText).toBe('Source title');
    expect(inventory[0]?.contextBefore).toBe('Evidence before ');
    expect(inventory[0]?.contextAfter).toBe(' evidence after');
  });

  it('opens only explicitly collapsed source toggles', () => {
    const expanded = document.createElement('button');
    expanded.setAttribute('aria-expanded', 'true');
    const collapsed = document.createElement('button');
    collapsed.setAttribute('data-state', 'closed');
    const unknown = document.createElement('button');
    expect(sourceToggleState(expanded)).toBe('expanded');
    expect(sourceToggleState(collapsed)).toBe('collapsed');
    expect(sourceToggleState(unknown)).toBe('unknown');
  });

  it('merges pre-toggle and post-toggle inventories without losing duplicate URL occurrences', () => {
    const base = { url: 'https://example.com', contextBefore: '', contextAfter: '', markerText: '¹' };
    const merged = mergeCitationInventories(
      [{ ...base, domOrder: 0 }],
      [{ ...base, domOrder: 0 }, { ...base, markerText: '²', domOrder: 1 }],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((item) => item.markerText)).toEqual(['¹', '²']);
  });

  it('excludes report prose from quota matching and bounds clarification matching', () => {
    const report = visible(document.createElement('article'));
    report.innerHTML = '<span>Research usage limit reached in a cited experiment.</span>';
    visible(report.firstElementChild as HTMLElement);
    document.body.replaceChildren(report);
    expect(findElement(ADAPTERS.claude.selectors.quotaNotice, document, [report])).toBeNull();

    Object.defineProperty(report, 'innerText', { configurable: true, value: 'Before I begin, could you specify the target market?' });
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(true);
    Object.defineProperty(report, 'innerText', { configurable: true, value: `Before I begin, ${'long report '.repeat(70)}` });
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(false);
  });

  it('requires an interactive Gemini plan approval control', () => {
    const prose = visible(document.createElement('span'));
    prose.textContent = 'Begin research';
    document.body.replaceChildren(prose);
    expect(findElement(ADAPTERS.gemini.selectors.planApproval!)).toBeNull();
    const button = visible(document.createElement('button'));
    button.setAttribute('aria-label', 'Begin research');
    document.body.append(button);
    expect(findElement(ADAPTERS.gemini.selectors.planApproval!)).toBe(button);
  });
});
