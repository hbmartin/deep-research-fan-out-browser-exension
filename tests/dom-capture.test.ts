import { describe, expect, it } from 'vitest';
import { ADAPTERS } from '../src/adapters';
import { createFinalResponseBaseline, createResponseSnapshot, domCitationInventory, evaluateStableResponse, finalResponseFingerprint, isClarifyingResponse, isNewFinalResponse, isProgressResponse, isQuotaResponse, mergeCitationInventories, shouldOpenSourceToggle, sourceToggleState } from '../src/dom-capture';
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

    report.textContent = 'Research suggests the available evidence is limited by sample size.';
    expect(isQuotaResponse(report, ADAPTERS.grok.quotaResponsePattern)).toBe(false);
    report.textContent = 'Before the deep research, is there a budget limit?';
    expect(isQuotaResponse(report, ADAPTERS.chatgpt.quotaResponsePattern)).toBe(false);

    report.textContent = 'Before I begin, could you specify the target market?';
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(true);
    report.textContent = 'Great — before I begin, could you clarify the target market?';
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(true);
    report.textContent = 'Thanks! Could you specify the target market?';
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(true);
    report.textContent = `Before I begin, ${'long report '.repeat(70)}`;
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(true);
    report.textContent = `Clarification of GDPR Article 6. ${'report '.repeat(1000)}`;
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(false);
    report.textContent = 'The report cites a passage saying before I begin.';
    expect(isClarifyingResponse(report, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(false);
    report.textContent = 'Your deep research limit has been reached.';
    expect(isQuotaResponse(report, ADAPTERS.chatgpt.quotaResponsePattern)).toBe(true);
    report.textContent = "You've reached your usage limit.";
    expect(isQuotaResponse(report, ADAPTERS.claude.quotaResponsePattern)).toBe(true);
    report.textContent = 'Starting research across the requested sources…';
    expect(isProgressResponse(report, ADAPTERS.chatgpt.progressResponsePattern)).toBe(true);
  });

  it('recognizes only complete progress messages while ignoring hidden and copy-control text', () => {
    const report = visible(document.createElement('article'));
    report.innerHTML = `
      <button>Researching the latest CRISPR trials…</button>
      <button aria-label="Copy response">Copy</button>
      <span style="display:none">A hidden final report.</span>
      <script>A script-generated final report.</script>
    `;
    document.body.replaceChildren(report);
    expect(isProgressResponse(report, ADAPTERS.chatgpt.progressResponsePattern, true)).toBe(true);

    report.replaceChildren(document.createTextNode("I'll start researching the topic. Here is the finished report."));
    expect(isProgressResponse(report, ADAPTERS.chatgpt.progressResponsePattern, true)).toBe(false);
    report.textContent = 'Searching for extraterrestrial intelligence. Radio surveys found no confirmed signal.';
    expect(isProgressResponse(report, ADAPTERS.chatgpt.progressResponsePattern, true)).toBe(false);
  });

  it('recognizes a bounded status follow-up without accepting report prose', () => {
    const response = visible(document.createElement('article'));
    response.textContent = "I'll start researching the topic now. This may take 10 to 30 minutes.";
    expect(isProgressResponse(response, ADAPTERS.chatgpt.progressResponsePattern, true)).toBe(true);
    response.textContent = "I'll start researching the topic now. Here is the finished report.";
    expect(isProgressResponse(response, ADAPTERS.chatgpt.progressResponsePattern, true)).toBe(false);
  });

  it('does not let a stale progress button override finished response text', () => {
    const response = visible(document.createElement('article'));
    response.innerHTML = '<div>A finished report with substantive findings and recommendations.</div><button>Searching 42 sources</button>';
    document.body.replaceChildren(response);
    expect(isProgressResponse(response, ADAPTERS.chatgpt.progressResponsePattern, false)).toBe(false);
  });

  it('preserves block boundaries for quota and clarification matching', () => {
    const response = visible(document.createElement('article'));
    response.innerHTML = '<p>Your usage limit</p><p>has been reached.</p>';
    expect(isQuotaResponse(response, ADAPTERS.chatgpt.quotaResponsePattern)).toBe(true);
    response.innerHTML = '<p>Before I begin</p><p>What market should I cover?</p>';
    expect(isClarifyingResponse(response, ADAPTERS.chatgpt.clarifyingPromptPattern)).toBe(true);
  });

  it('uses the response as the visibility boundary while pruning hidden descendants', () => {
    const overlayed = document.createElement('div');
    overlayed.setAttribute('aria-hidden', 'true');
    overlayed.style.opacity = '0';
    const response = document.createElement('article');
    response.innerHTML = `
      <p>Visible report body</p>
      <p style="display:none">Hidden duplicate</p>
      <section hidden="until-found">Collapsed evidence</section>
    `;
    overlayed.append(response);
    document.body.replaceChildren(overlayed);
    const snapshot = createResponseSnapshot(response);
    expect(snapshot.text).toContain('Visible report body');
    expect(snapshot.text).toContain('Collapsed evidence');
    expect(snapshot.text).not.toContain('Hidden duplicate');
  });

  it('preserves report timestamps and semantic live-region content', () => {
    const response = document.createElement('article');
    response.innerHTML = `
      <time datetime="2026-09-13T12:34:00Z">12:34</time>
      <span>09:45</span>
      <p role="status">Final status: complete</p>
      <div role="progressbar">Survey completion was 87 percent.</div>
      <span>Elapsed 00:30</span>
      <span aria-label="Elapsed time">00:31</span>
      <span aria-label="Elapsed time"><strong>00:32</strong></span>
      <span aria-label="Elapsed time">1m 23s</span>
      <span>Elapsed time: 1h 2m 3s</span>
      <span aria-label="Elapsed company history">The company was founded in 1982.</span>
      <p>Elapsed time: 1:23:45</p>
      <p><span aria-label="Elapsed time">00:33</span></p>
      <li>Researching evidence — elapsed time: 2m 3s</li>
      <table><tbody><tr><td>Elapsed time: 1:23:45</td></tr></tbody></table>
    `;
    const snapshot = createResponseSnapshot(response);
    expect(snapshot.text).toContain('12:34');
    expect(snapshot.text).toContain('09:45');
    expect(snapshot.text).toContain('Final status: complete');
    expect(snapshot.text).toContain('Survey completion was 87 percent.');
    expect(snapshot.text).not.toContain('Elapsed 00:30');
    expect(snapshot.text).not.toContain('00:31');
    expect(snapshot.text).not.toContain('00:32');
    expect(snapshot.text).not.toContain('1m 23s');
    expect(snapshot.text).not.toContain('1h 2m 3s');
    expect(snapshot.text).toContain('The company was founded in 1982.');
    expect(snapshot.text.match(/Elapsed time: 1:23:45/g)).toHaveLength(2);
    expect(snapshot.text).toContain('00:33');
    expect(snapshot.text).toContain('Researching evidence — elapsed time: 2m 3s');
    expect(snapshot.activityText).not.toMatch(/00:33|1:23:45|2m 3s/);
    expect(snapshot.activityText).toContain('Researching evidence');
  });

  it('uses timer-stripped text for response activity fingerprints', () => {
    const response = document.createElement('article');
    response.id = 'response';
    response.innerHTML = `
      <p>Researching the requested topic.</p>
      <p><span aria-label="Elapsed time">00:31</span></p>
      <li>Progress details — elapsed time: 1m 31s</li>
    `;
    const first = finalResponseFingerprint(response);
    response.querySelector('span')!.textContent = '00:32';
    response.querySelector('li')!.textContent = 'Progress details — elapsed time: 1m 32s';
    expect(finalResponseFingerprint(response)).toBe(first);
    response.querySelector('li')!.textContent = 'Different progress details — elapsed time: 1m 33s';
    expect(finalResponseFingerprint(response)).not.toBe(first);
  });

  it('classifies progress using timer-stripped text while preserving the exported timer', () => {
    const response = document.createElement('article');
    response.innerHTML = '<p>Searching… <span aria-label="Elapsed time">00:30</span></p>';
    const snapshot = createResponseSnapshot(response);

    expect(snapshot.text).toContain('00:30');
    expect(snapshot.activityText).toBe('Searching…');
    expect(isProgressResponse(response, ADAPTERS.chatgpt.progressResponsePattern, false, snapshot)).toBe(true);
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
    response.textContent = 'The final research report with substantive findings and recommendations.';
    const changed = evaluateStableResponse(response, true, initial.candidate, 11_000, 10_000);
    expect(changed.ready).toBe(false);
    expect(evaluateStableResponse(response, true, changed.candidate, 21_000, 10_000).ready).toBe(true);

    response.textContent = 'Detailed research result. '.repeat(50);
    const domOnly = evaluateStableResponse(response, false, undefined, 30_000, 10_000);
    expect(domOnly.ready).toBe(false);
    expect(evaluateStableResponse(response, false, domOnly.candidate, 59_999, 10_000).ready).toBe(false);
    expect(evaluateStableResponse(response, false, domOnly.candidate, 60_000, 10_000).ready).toBe(true);

    response.textContent = 'OK';
    const short = evaluateStableResponse(response, true, undefined, 70_000, 1000);
    expect(short.ready).toBe(false);
    expect(evaluateStableResponse(response, true, short.candidate, 71_000, 1000).ready).toBe(true);
  });
});
