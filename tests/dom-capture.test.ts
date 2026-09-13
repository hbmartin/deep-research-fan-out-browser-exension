import { describe, expect, it } from 'vitest';
import { ADAPTERS } from '../src/adapters';
import { createFinalResponseBaseline, domCitationInventory, evaluateStableResponse, isClarifyingResponse, isNewFinalResponse, isProgressResponse, isQuotaResponse, mergeCitationInventories, shouldOpenSourceToggle, sourceToggleState } from '../src/dom-capture';
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

  it('opens collapsed and unknown source toggles without closing expanded panels', () => {
    const expanded = document.createElement('button');
    expanded.setAttribute('aria-expanded', 'true');
    const collapsed = document.createElement('button');
    collapsed.setAttribute('data-state', 'closed');
    const unknown = document.createElement('button');
    expect(sourceToggleState(expanded)).toBe('expanded');
    expect(sourceToggleState(collapsed)).toBe('collapsed');
    expect(sourceToggleState(unknown)).toBe('unknown');
    expect(shouldOpenSourceToggle(expanded)).toBe(false);
    expect(shouldOpenSourceToggle(collapsed)).toBe(true);
    expect(shouldOpenSourceToggle(unknown)).toBe(true);
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

  it('treats the post-toggle order as authoritative when positions shift', () => {
    const citation = (url: string, markerText: string, domOrder: number) => ({
      url, markerText, domOrder, contextBefore: markerText, contextAfter: '',
    });
    const merged = mergeCitationInventories(
      [citation('https://a.test', 'A', 0), citation('https://b.test', 'B', 1)],
      [citation('https://b.test', 'B', 0), citation('https://a.test', 'A', 1)],
    );
    expect(merged.map((item) => item.url)).toEqual(['https://b.test', 'https://a.test']);
  });

  it('distinguishes report prose from assistant quota notices and long clarification prompts', () => {
    const report = visible(document.createElement('article'));
    report.innerHTML = '<span>Research usage limit reached in a cited experiment.</span>';
    visible(report.firstElementChild as HTMLElement);
    document.body.replaceChildren(report);
    expect(findElement(ADAPTERS.claude.selectors.quotaNotice, document, [report])).toBeNull();
    expect(isQuotaResponse(report, ADAPTERS.claude.quotaResponsePattern)).toBe(false);

    Object.defineProperty(report, 'innerText', { configurable: true, value: 'Research suggests the available evidence is limited by sample size.' });
    expect(isQuotaResponse(report, ADAPTERS.grok.quotaResponsePattern)).toBe(false);
    Object.defineProperty(report, 'innerText', { configurable: true, value: 'Before the deep research, is there a budget limit?' });
    expect(isQuotaResponse(report, ADAPTERS.chatgpt.quotaResponsePattern)).toBe(false);

    Object.defineProperty(report, 'innerText', { configurable: true, value: 'Before I begin, could you specify the target market?' });
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(true);
    Object.defineProperty(report, 'innerText', { configurable: true, value: 'Great — before I begin, could you clarify the target market?' });
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(true);
    Object.defineProperty(report, 'innerText', { configurable: true, value: 'Thanks! Could you specify the target market?' });
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(true);
    Object.defineProperty(report, 'innerText', { configurable: true, value: `Before I begin, ${'long report '.repeat(70)}` });
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(true);
    Object.defineProperty(report, 'innerText', { configurable: true, value: `Clarification of GDPR Article 6. ${'report '.repeat(1000)}` });
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(false);
    Object.defineProperty(report, 'innerText', { configurable: true, value: 'The report cites a passage saying before I begin.' });
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(false);
    Object.defineProperty(report, 'innerText', { configurable: true, value: 'Your deep research limit has been reached.' });
    expect(isQuotaResponse(report, ADAPTERS.chatgpt.quotaResponsePattern)).toBe(true);
    Object.defineProperty(report, 'innerText', { configurable: true, value: "You've reached your usage limit." });
    expect(isQuotaResponse(report, ADAPTERS.claude.quotaResponsePattern)).toBe(true);
    Object.defineProperty(report, 'innerText', { configurable: true, value: 'Starting research across the requested sources…' });
    expect(isProgressResponse(report, ADAPTERS.chatgpt.progressResponsePattern)).toBe(true);
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

  it('accepts only responses that appear after monitoring is baselined', () => {
    const prior = document.createElement('article');
    prior.textContent = 'An earlier completed report.';
    const baseline = createFinalResponseBaseline([prior]);
    expect(isNewFinalResponse(prior, baseline)).toBe(false);

    const rerenderedPrior = document.createElement('article');
    rerenderedPrior.textContent = prior.textContent;
    expect(isNewFinalResponse(rerenderedPrior, baseline)).toBe(false);

    const current = document.createElement('article');
    current.textContent = 'A newly completed report.';
    expect(isNewFinalResponse(current, baseline)).toBe(true);
  });

  it('prefers a copy control but permits a long stable DOM-only response after an extended debounce', () => {
    const response = document.createElement('article');
    response.textContent = 'Starting research…';
    expect(evaluateStableResponse(response, false, undefined, 1000, 10_000)).toEqual({ ready: false });
    const initial = evaluateStableResponse(response, true, undefined, 1000, 10_000);
    expect(initial.ready).toBe(false);
    response.textContent = 'The final research report.';
    const changed = evaluateStableResponse(response, true, initial.candidate, 11_000, 10_000);
    expect(changed.ready).toBe(false);
    expect(evaluateStableResponse(response, true, changed.candidate, 21_000, 10_000).ready).toBe(true);

    response.textContent = 'Detailed research result. '.repeat(50);
    const domOnly = evaluateStableResponse(response, false, undefined, 30_000, 10_000);
    expect(domOnly.ready).toBe(false);
    expect(evaluateStableResponse(response, false, domOnly.candidate, 59_999, 10_000).ready).toBe(false);
    expect(evaluateStableResponse(response, false, domOnly.candidate, 60_000, 10_000).ready).toBe(true);
  });
});
