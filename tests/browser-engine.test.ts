import { describe, expect, it } from 'vitest';
import { injectQuery } from '../src/injection';
import { findElement } from '../src/selectors';

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
});
