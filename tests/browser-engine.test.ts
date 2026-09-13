import { describe, expect, it, vi } from 'vitest';
import { injectionTestHooks, injectQuery } from '../src/injection';
import { cloneVisibleContent, findElement } from '../src/selectors';
import { ADAPTERS } from '../src/adapters';

function visible(element: HTMLElement): HTMLElement {
  element.style.position = 'fixed';
  return element;
}

describe('selector engine', () => {
  it('uses ordered fallbacks and supports selecting the last result', () => {
    document.body.innerHTML = '<button aria-label="Copy">First</button><button aria-label="Copy">Second</button>';
    document.querySelectorAll('button').forEach((item) => visible(item));
    expect(findElement([{ kind: 'testid', value: 'missing' }, { kind: 'aria', role: 'button', name: /copy/i, pick: 'last' }])?.textContent).toBe('Second');
  });

  it('requires selected-state selectors for research mode confirmation', () => {
    document.body.innerHTML = '<button aria-label="Deep research" aria-pressed="false">Deep research</button>';
    visible(document.querySelector('button')!);
    expect(findElement([{ kind: 'css', value: 'button[aria-pressed="true"][aria-label*="deep research" i]' }])).toBeNull();
  });

  it('maps input elements to their HTML-AAM implicit roles', () => {
    document.body.innerHTML = `
      <input type="submit" aria-label="Send">
      <input type="checkbox" aria-label="Include">
      <input type="radio" aria-label="Choice">
      <input type="number" aria-label="Count">
      <input type="range" aria-label="Volume">
      <input type="search" aria-label="Search">
      <input type="text" list="choices" aria-label="Preset">
      <datalist id="choices"><option value="one"></datalist>
      <input type="password" aria-label="Secret">
    `;
    document.querySelectorAll<HTMLElement>('input').forEach(visible);
    expect(findElement([{ kind: 'aria', role: 'button', name: 'Send' }])).toBeInstanceOf(HTMLInputElement);
    expect(findElement([{ kind: 'aria', role: 'checkbox', name: 'Include' }])).toBeInstanceOf(HTMLInputElement);
    expect(findElement([{ kind: 'aria', role: 'radio', name: 'Choice' }])).toBeInstanceOf(HTMLInputElement);
    expect(findElement([{ kind: 'aria', role: 'spinbutton', name: 'Count' }])).toBeInstanceOf(HTMLInputElement);
    expect(findElement([{ kind: 'aria', role: 'slider', name: 'Volume' }])).toBeInstanceOf(HTMLInputElement);
    expect(findElement([{ kind: 'aria', role: 'searchbox', name: 'Search' }])).toBeInstanceOf(HTMLInputElement);
    expect(findElement([{ kind: 'aria', role: 'combobox', name: 'Preset' }])).toBeInstanceOf(HTMLInputElement);
    expect(findElement([{ kind: 'aria', role: 'textbox', name: 'Secret' }])).toBeNull();
  });

  it('does not select aria-disabled controls', () => {
    document.body.innerHTML = '<button aria-label="Send" aria-disabled="true">Send</button>';
    visible(document.querySelector('button')!);
    expect(findElement([{ kind: 'aria', role: 'button', name: 'Send' }])).toBeNull();
  });

  it.each([
    ['opacity', '0'],
    ['visibility', 'collapse'],
  ])('does not select controls hidden by ancestor %s', (property, value) => {
    document.body.innerHTML = `<div style="${property}:${value}"><button style="position:fixed" aria-label="Send">Send</button></div>`;
    expect(findElement([{ kind: 'aria', role: 'button', name: 'Send' }])).toBeNull();
  });

  it('discovers a transparent hover control without accepting one under a hidden ancestor', () => {
    document.body.innerHTML = `
      <button id="hover-copy" style="position:fixed;opacity:0" aria-label="Copy response">Copy</button>
      <div aria-hidden="true" style="opacity:0">
        <button id="hidden-copy" style="position:fixed;opacity:0" aria-label="Copy response">Copy</button>
      </div>
    `;
    expect(findElement(
      [{ kind: 'aria', role: 'button', name: 'Copy response', pick: 'last' }],
      document,
      [],
      { allowTransparent: true },
    )).toBe(document.querySelector('#hover-copy'));
  });

  it('honors a descendant visibility override and keeps until-found content discoverable', () => {
    document.body.innerHTML = `
      <div style="visibility:hidden"><button style="position:fixed;visibility:visible" aria-label="Override">Override</button></div>
      <button hidden="until-found" style="position:fixed" aria-label="Collapsible">Collapsible</button>
    `;
    expect(findElement([{ kind: 'aria', role: 'button', name: 'Override' }])).toBe(document.querySelector('[aria-label="Override"]'));
    expect(findElement([{ kind: 'aria', role: 'button', name: 'Collapsible' }])).toBe(document.querySelector('[aria-label="Collapsible"]'));
  });

  it('targets Grok Copy response rather than nested table and code copy buttons', () => {
    document.body.innerHTML = '<div id="answer"><button aria-label="Copy">Table</button><button aria-label="Copy">Code</button></div><button aria-label="Copy response">Response</button>';
    document.querySelectorAll<HTMLElement>('button').forEach(visible);
    const root = document.querySelector<HTMLElement>('#answer')!;
    expect(findElement(ADAPTERS.grok.selectors.copyButton, root)).toBeNull();
    expect(findElement(ADAPTERS.grok.selectors.copyButton)?.textContent).toBe('Response');
  });

  it('does not treat ordinary report prose as a loose streaming indicator', () => {
    document.body.innerHTML = `
      <p style="position:fixed">The team is researching new battery materials.</p>
      <span style="position:fixed">Searching…</span>
    `;
    expect(findElement(ADAPTERS.gemini.selectors.streamingIndicator)).toBeNull();
    expect(findElement(ADAPTERS.grok.selectors.streamingIndicator)?.textContent).toBe('Searching…');
  });

  it('checks each captured descendant style once instead of walking every ancestor', () => {
    const root = document.createElement('div');
    root.innerHTML = '<section><article><p><span>Report</span></p></article></section><section><p>More</p></section>';
    document.body.replaceChildren(root);
    const descendants = root.querySelectorAll('*').length;
    const getStyle = vi.spyOn(globalThis, 'getComputedStyle');
    cloneVisibleContent(root, 'button, script');
    expect(getStyle).toHaveBeenCalledTimes(descendants);
    getStyle.mockRestore();
  });
});

describe('query injection', () => {
  it('uses the native textarea setter and verifies the final value', async () => {
    const textarea = visible(document.createElement('textarea')) as HTMLTextAreaElement;
    document.body.replaceChildren(textarea);
    let inputs = 0;
    textarea.addEventListener('input', () => { inputs += 1; });
    await expect(injectQuery(textarea, 'textarea', 'line one\nline two')).resolves.toBe(true);
    expect(textarea.value).toBe('line one\nline two');
    expect(inputs).toBe(1);
  });

  it('accepts browser-expanded line breaks while preserving line boundaries', () => {
    const blocks = document.createElement('div');
    Object.defineProperty(blocks, 'innerText', { configurable: true, value: 'alpha\n  beta' });
    expect(injectionTestHooks.verified(blocks, 'alpha\r\n  beta')).toBe(true);
    expect(injectionTestHooks.verified(blocks, 'alpha\nbeta')).toBe(true);
    expect(injectionTestHooks.verified(blocks, 'alpha beta')).toBe(false);

    const breaks = document.createElement('div');
    Object.defineProperty(breaks, 'innerText', { configurable: true, value: 'alpha\n\nbeta\u00a0gamma' });
    expect(injectionTestHooks.verified(breaks, 'alpha\r\n\r\nbeta gamma')).toBe(true);
    expect(injectionTestHooks.verified(breaks, 'alpha\nbeta gamma')).toBe(true);
    expect(injectionTestHooks.verified(breaks, 'alpha\n\nbeta  gamma')).toBe(true);
  });
});
