import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureGrokResearchTrail, normalizeResearchTrail } from '../src/sources';
import type { CapturedResearchTrail, Citation } from '../src/types';

const queries = [
  { kind: 'web', query: 'Codex remote control protocol', ids: Array.from({ length: 15 }, (_, index) => index) },
  { kind: 'web', query: '"Codex" "remote control" protocol reverse engineer OR reverse-engineering', ids: Array.from({ length: 10 }, (_, index) => index + 10) },
  { kind: 'web', query: 'Codex Mac remote control protocol', ids: Array.from({ length: 10 }, (_, index) => index + 17) },
  { kind: 'x', query: 'Codex remote control protocol', ids: Array.from({ length: 10 }, (_, index) => index) },
  { kind: 'x', query: '"codex" "remote control" (protocol OR reverse OR reverse-engineer OR RE)', ids: Array.from({ length: 10 }, (_, index) => index + 10) },
  { kind: 'x', query: 'how Codex remote control protocol works reverse engineering', ids: Array.from({ length: 9 }, (_, index) => index + 20) },
  { kind: 'x', query: '"remote-control" (WHAM OR biscuit OR enroll OR app-server) (codex OR openai)', ids: Array.from({ length: 10 }, (_, index) => index + 29) },
] as const;

function searchGroup(kind: 'web' | 'x', query: string, ids: readonly number[], groupIndex: number): string {
  const results = ids.map((id) => kind === 'web'
    ? `<div class="group/search-result"><a href="https://web.example/source-${id}"><div>Web source ${id}</div><p>Snippet for web source ${id}</p></a><a href="https://web.example/source-${id}">Web</a></div>`
    : `<a href="https://x.com/researcher_${id}/status/${1000 + id}?referrer=grok-com"><div><span>Researcher ${id}</span><span>Sep 1</span><span>@researcher_${id}</span></div><p>X source ${id} text${id < 17 ? ` <a href="https://t.co/link-${id}">https://t.co/link-${id}</a>` : ''}</p></a>`).join('');
  const label = kind === 'web' ? 'Searched web' : 'Searched 𝕏';
  return `<div class="border-0 group"><h3><button aria-controls="group-${groupIndex}" aria-expanded="true"><div>${label}</div><div>${query}</div><span>${ids.length}</span></button></h3><div id="group-${groupIndex}"><div><div>${results}</div></div></div></div>`;
}

function sidebarHtml(): string {
  const groups = queries.map((entry, index) => searchGroup(entry.kind, entry.query, entry.ids, index)).join('');
  const opened = Array.from({ length: 4 }, (_, index) => `<div><span>Opened page</span><a href="https://web.example/source-${index}">web.example/source-${index}</a></div>`).join('');
  return `<aside><header><div>Sources</div><button aria-label="Close"></button></header>${groups}${opened}</aside>`;
}

describe('Grok Sources sidebar capture', () => {
  beforeEach(() => { document.body.replaceChildren(); });
  afterEach(() => { vi.useRealTimers(); });

  it('captures the inspected seven-search, 74-result shape and globally deduplicates it', async () => {
    document.body.innerHTML = `<button aria-label="74 sources" aria-controls="sources" aria-expanded="true"></button>${sidebarHtml()}`;
    document.querySelector('aside')!.id = 'sources';
    const firstXPost = document.querySelector<HTMLAnchorElement>('a[href^="https://x.com/researcher_0/status/"]')!;
    const outbound = document.createElement('a');
    outbound.href = 'https://t.co/link-0';
    outbound.textContent = 'https://t.co/link-0';
    firstXPost.querySelector('p')!.append(' ', outbound);
    const toggle = document.querySelector<HTMLElement>('button[aria-label="74 sources"]')!;
    const captured = await captureGrokResearchTrail(document, toggle, 50);
    const citations: Citation[] = [
      { index: 1, url: 'https://web.example/source-0', title: 'Web source 0', placement: 'inline' },
      { index: 2, url: 'https://x.com/researcher_0/status/1000?referrer=grok-com', title: 'X source 0', placement: 'inline' },
    ];
    const trail = normalizeResearchTrail(captured, citations);

    expect(captured.searches.map((search) => [search.kind, search.query, search.results.length])).toEqual(
      queries.map((entry) => [entry.kind, entry.query, entry.ids.length]),
    );
    expect(trail.capturedResultCount).toBe(74);
    expect(trail.expectedResultCount).toBe(74);
    expect(trail.sources).toHaveLength(66);
    expect(trail.complete).toBe(true);
    expect(trail.sources[0]).toMatchObject({
      id: 'SRC-001',
      title: 'Web source 0',
      opened: true,
      cited: true,
      searchIndexes: [1],
    });
    expect(trail.sources.find((source) => source.url.includes('x.com/researcher_0'))).toMatchObject({
      title: 'Researcher 0 (@researcher_0) on X',
      cited: true,
      outboundUrls: ['https://t.co/link-0'],
    });
    expect(trail.searches[1]?.sourceIds.slice(0, 5)).toEqual(trail.searches[0]?.sourceIds.slice(10, 15));
  });

  it('restores a sidebar that it opened', async () => {
    document.body.innerHTML = '<button aria-label="1 sources"></button>';
    const toggle = document.querySelector<HTMLElement>('button')!;
    toggle.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', `<aside><div>Sources</div><button aria-label="Close"></button>${searchGroup('web', 'one query', [1], 1)}</aside>`);
      document.querySelector<HTMLButtonElement>('aside button[aria-label="Close"]')!.addEventListener('click', () => document.querySelector('aside')?.remove());
    }, { once: true });

    const captured = await captureGrokResearchTrail(document, toggle, 50);
    expect(captured.searches[0]?.results).toHaveLength(1);
    expect(document.querySelector('aside')).toBeNull();
  });

  it('gives later search groups time to render after an earlier group stalls', async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<button id="toggle" aria-controls="sources" aria-expanded="true"></button><aside id="sources"><div>Sources</div>${searchGroup('web', 'stalled query', [1], 1)}${searchGroup('web', 'later query', [2], 2)}</aside>`;
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('aside button[aria-controls]'));
    buttons[0]!.querySelector('span')!.textContent = '2';
    const laterPanel = document.querySelector<HTMLElement>('#group-2')!;
    laterPanel.remove();
    buttons[1]!.setAttribute('aria-expanded', 'false');
    buttons[1]!.addEventListener('click', () => {
      setTimeout(() => document.querySelector('aside')!.append(laterPanel), 25);
    }, { once: true });

    const pending = captureGrokResearchTrail(document, document.querySelector<HTMLElement>('#toggle'), 100);
    await vi.runAllTimersAsync();
    const captured = await pending;
    expect(captured.searches[0]?.results).toHaveLength(1);
    expect(captured.searches[1]?.results).toHaveLength(1);
  });

  it('keeps partial source data and reports count mismatches', () => {
    const captured: CapturedResearchTrail = {
      reportedResultCount: 2,
      searches: [{
        kind: 'web', query: 'partial', expectedResultCount: 2,
        results: [{ url: 'https://example.com/one', title: 'One', snippet: 'Available result' }],
      }],
      openedPages: [],
      warnings: [],
    };
    const trail = normalizeResearchTrail(captured, []);
    expect(trail.sources).toHaveLength(1);
    expect(trail.complete).toBe(false);
    expect(trail.warnings.join(' ')).toContain('Expected 2 total search results but captured 1');
  });

  it('reopens the target answer sources when an unrelated sidebar is already open', async () => {
    document.body.innerHTML = `<button id="target" aria-label="1 sources"></button><aside><div>Sources</div><button aria-label="Close"></button>${searchGroup('web', 'old query', [1], 1)}</aside>`;
    document.querySelector('aside button')!.addEventListener('click', () => document.querySelector('aside')!.remove());
    const toggle = document.querySelector<HTMLElement>('#target')!;
    toggle.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', `<aside><div>Sources</div>${searchGroup('web', 'current query', [2], 2)}</aside>`);
    });
    const trail = normalizeResearchTrail(await captureGrokResearchTrail(document, toggle, 50), []);
    expect(trail.searches.map((search) => search.query)).toEqual(['current query']);
    expect(trail.sources.map((source) => source.url)).toEqual(['https://web.example/source-2']);
    expect(trail.complete).toBe(true);
  });

  it('reopens a production-style toggle without ownership ARIA after the prior sidebar closes visually', async () => {
    document.body.innerHTML = `<button id="target" aria-label="1 sources"></button><aside><div>Sources</div><button aria-label="Close"></button>${searchGroup('web', 'old query', [1], 1)}</aside>`;
    const priorSidebar = document.querySelector<HTMLElement>('aside')!;
    document.querySelector<HTMLButtonElement>('aside button')!.addEventListener('click', () => { priorSidebar.style.opacity = '0'; });
    const toggle = document.querySelector<HTMLElement>('#target')!;
    toggle.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', `<aside><div>Sources</div>${searchGroup('web', 'current query', [2], 2)}</aside>`);
    });

    const trail = normalizeResearchTrail(await captureGrokResearchTrail(document, toggle, 50), []);
    expect(trail.searches.map((search) => search.query)).toEqual(['current query']);
    expect(trail.sources.map((source) => source.url)).toEqual(['https://web.example/source-2']);
  });

  it('rejects a stale sidebar re-created while the previous one closes', async () => {
    document.body.innerHTML = `<button id="target" aria-label="1 sources"></button><aside><div>Sources</div><button aria-label="Close"></button>${searchGroup('web', 'old query', [1], 1)}</aside>`;
    document.querySelector<HTMLButtonElement>('aside button')!.addEventListener('click', () => {
      document.querySelector('aside')!.remove();
      document.body.insertAdjacentHTML('beforeend', `<aside><div>Sources</div>${searchGroup('web', 'stale query', [1], 1)}</aside>`);
    });
    const toggle = document.querySelector<HTMLElement>('#target')!;
    toggle.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', `<aside><div>Sources</div>${searchGroup('web', 'current query', [2], 2)}</aside>`);
    });

    const trail = normalizeResearchTrail(await captureGrokResearchTrail(document, toggle, 50), []);
    expect(trail.sources).toEqual([]);
    expect(trail.warnings.join(' ')).toContain('which answer owns');
  });

  it.each(['collapse', 'hidden'] as const)('ignores a stale sidebar with visibility: %s', async (visibility) => {
    document.body.innerHTML = `<button id="target" aria-label="1 sources"></button><aside style="visibility:${visibility}"><div>Sources</div>${searchGroup('web', 'stale query', [1], 1)}</aside>`;
    const toggle = document.querySelector<HTMLElement>('#target')!;
    toggle.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', `<aside><div>Sources</div>${searchGroup('web', 'current query', [2], 2)}</aside>`);
    });

    const trail = normalizeResearchTrail(await captureGrokResearchTrail(document, toggle, 50), []);
    expect(trail.searches.map((search) => search.query)).toEqual(['current query']);
  });

  it('warns instead of exporting sources when sidebar ownership cannot be established', async () => {
    document.body.innerHTML = `<button id="target" aria-label="1 sources"></button><aside><div>Sources</div>${searchGroup('web', 'old query', [1], 1)}</aside>`;
    const trail = normalizeResearchTrail(await captureGrokResearchTrail(document, document.querySelector<HTMLElement>('#target'), 50), []);
    expect(trail.sources).toEqual([]);
    expect(trail.complete).toBe(false);
    expect(trail.warnings.join(' ')).toContain('which answer owns');
  });

  it('does not duplicate mismatch warnings already recorded during capture', () => {
    const captured: CapturedResearchTrail = {
      reportedResultCount: 2,
      searches: [{
        kind: 'web', query: 'partial', expectedResultCount: 2,
        results: [{ url: 'https://example.com/one', title: 'One' }],
      }],
      openedPages: [],
      warnings: [
        'The web search “partial” reported 2 results but 1 were captured.',
        'Grok reported 2 sources but 1 search results were captured.',
      ],
    };
    const trail = normalizeResearchTrail(captured, []);
    expect(trail.warnings).toEqual(captured.warnings);
  });
});

it('accepts a reused sidebar node that becomes visible without ownership ARIA', async () => {
  document.body.innerHTML = `<button id="target" aria-label="1 sources"></button><aside hidden><div>Sources</div><button aria-label="Close"></button>${searchGroup('web','current query',[2],2)}</aside>`;
  const panel=document.querySelector<HTMLElement>('aside')!;
  const toggle=document.querySelector<HTMLElement>('#target')!;
  toggle.addEventListener('click',()=> {panel.hidden=false;});
  panel.querySelector('button')!.addEventListener('click',()=> {panel.hidden=true;});
  const result=await captureGrokResearchTrail(document,toggle,50);
  expect(result.searches.map((search)=>search.query)).toEqual(['current query']);
  expect(result.warnings).toEqual([]);
  expect(panel.hidden).toBe(true);
  document.body.replaceChildren();
});

it('rejects ambiguous simultaneously opened sidebars', async () => {
  document.body.innerHTML = '<button id="target" aria-label="1 sources"></button>';
  const toggle=document.querySelector<HTMLElement>('#target')!;
  toggle.addEventListener('click',()=> {document.body.insertAdjacentHTML('beforeend','<aside><div>Sources</div></aside><aside><div>Sources</div></aside>');});
  const result=await captureGrokResearchTrail(document,toggle,50);
  expect(result.searches).toEqual([]);
  expect(result.warnings).toContain('Grok Sources sidebar did not open.');
  document.body.replaceChildren();
});
