import { afterEach, describe, expect, it } from 'vitest';
import { ADAPTERS } from '../src/adapters';
import { ResponseControlIndex } from '../src/response-controls';

const copy = '<button style="position:fixed" aria-label="Copy response">Copy</button>';
const selectors = ADAPTERS.chatgpt.selectors.copyButton;
afterEach(() => { document.body.replaceChildren(); });
function index() {
  const roots = Array.from(document.querySelectorAll<HTMLElement>('article'));
  return { roots, controls: new ResponseControlIndex(roots) };
}

describe('bounded response ownership', () => {
  it.each(['dialog open', 'form', 'aside', 'main'])('does not borrow a Copy control from %s', (tag) => {
    document.body.innerHTML = `<section><article>Report</article></section><${tag}>${copy}</${tag.split(' ')[0]}>`;
    const { roots, controls } = index();
    expect(controls.find(roots[0]!, selectors, new Set(), true)).toBeNull();
  });
  it('rejects unrelated dialogs even when nested inside a response', () => {
    document.body.innerHTML = `<article>Report<dialog open>${copy}</dialog></article>`;
    const { roots, controls } = index();
    expect(controls.find(roots[0]!, selectors)).toBeNull();
  });
  it('finds deeply nested hover toolbars, including programmatic pointer-events none controls', () => {
    document.body.innerHTML = `<section><div><div><div><article>Report</article></div></div></div><div style="opacity:0;pointer-events:none">${copy}</div></section>`;
    const { roots, controls } = index();
    expect(controls.find(roots[0]!, selectors, new Set(), true)).toBe(document.querySelector('button'));
  });
  it('assigns a shared plain-container control to the nearest preceding response', () => {
    document.body.innerHTML = `<div><article>Earlier</article><article>Latest</article>${copy}</div>`;
    const { roots, controls } = index();
    expect(controls.find(roots[0]!, selectors, new Set(), true)).toBeNull();
    expect(controls.find(roots[1]!, selectors, new Set(), true)).toBe(document.querySelector('button'));
  });
  it('assigns a control between responses to the preceding response', () => {
    document.body.innerHTML = `<div><article>Earlier</article>${copy}<article>Later</article></div>`;
    const { roots, controls } = index();
    expect(controls.find(roots[0]!, selectors, new Set(), true)).toBe(document.querySelector('button'));
    expect(controls.find(roots[1]!, selectors, new Set(), true)).toBeNull();
  });
  it('does not assign a control across a page-level boundary', () => {
    document.body.innerHTML = `<main><article>Earlier</article><article>Latest</article>${copy}</main>`;
    const { roots, controls } = index();
    expect(controls.find(roots[1]!, selectors, new Set(), true)).toBeNull();
  });
  it('does not let aria-controls bypass a page-level boundary', () => {
    document.body.innerHTML = `<main><article id="answer">Report</article><button style="position:fixed" aria-controls="answer" aria-label="Copy response">Copy</button></main>`;
    const { roots, controls } = index();
    expect(controls.find(roots[0]!, selectors, new Set(), true)).toBeNull();
  });
  it('does not reject an owned control merely because its container also has a separate form', () => {
    document.body.innerHTML = `<section><form><textarea></textarea></form><article>Report</article>${copy}</section>`;
    const { roots, controls } = index();
    expect(controls.find(roots[0]!, selectors, new Set(), true)).toBe(document.querySelector('button'));
  });
  it('distinguishes discovery of modal-blocked sources from permission to click', () => {
    document.body.innerHTML = `<main aria-hidden="true"><section><article>Report</article>${copy}</section></main>`;
    const { roots, controls } = index();
    expect(controls.find(roots[0]!, selectors, new Set(), true)).toBeNull();
    expect(controls.find(roots[0]!, selectors, new Set(), true, true)).toBe(document.querySelector('button'));
  });
  it('rejects disabled and inert actions', () => {
    document.body.innerHTML = `<section inert><article>Report</article>${copy}</section>`;
    let current = index();
    expect(current.controls.find(current.roots[0]!, selectors)).toBeNull();
    document.querySelector('section')!.removeAttribute('inert');
    document.querySelector('button')!.disabled = true;
    current = index();
    expect(current.controls.find(current.roots[0]!, selectors)).toBeNull();
  });
  it('uses linear ancestry work for a long conversation and reuses ownership across lookups', () => {
    document.body.innerHTML = Array.from({ length: 200 }, (_, i) => `<section><article>Report ${i}</article><div>${copy}</div></section>`).join('');
    const { roots, controls } = index();
    for (const root of roots) expect(controls.find(root, selectors)).not.toBeNull();
    expect(controls.ancestorVisits).toBeLessThan(200 * 10);
    const visits = controls.ancestorVisits;
    controls.find(roots[199]!, selectors);
    expect(controls.ancestorVisits).toBe(visits);
  });
});
