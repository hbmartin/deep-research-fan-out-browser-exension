// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeUrl, reconcileCitations, tokenSimilarity } from '../src/citations';
import type { DomCitation } from '../src/types';

const citation = (url: string, markerText?: string, contextBefore = ''): DomCitation => ({
  url, markerText, contextBefore, contextAfter: '', domOrder: 0,
});

describe('URL normalization', () => {
  it('strips fixed tracking parameters and normalizes hosts and slashes', () => {
    expect(normalizeUrl('https://EXAMPLE.com/path/?utm_source=x&gclid=y&q=1#part')).toBe('https://example.com/path?q=1');
  });
});

describe('citation reconciliation', () => {
  it('processes the twelve-case provider fixture corpus', () => {
    const fixtures = JSON.parse(readFileSync(new URL('./fixtures/provider-reports.json', import.meta.url), 'utf8')) as Array<{
      provider: string; case: number; style: 'markdown_link' | 'superscript'; body: string;
    }>;
    expect(fixtures).toHaveLength(12);
    expect(new Set(fixtures.map((fixture) => fixture.provider))).toEqual(new Set(['chatgpt', 'claude', 'gemini', 'grok']));
    for (const fixture of fixtures) {
      const url = fixture.style === 'markdown_link'
        ? fixture.body.match(/https?:\/\/[^)]+/)![0]
        : `https://gemini-${fixture.case}.test`;
      const marker = fixture.style === 'superscript' ? fixture.body.match(/[¹²³]/)?.[0] : undefined;
      const result = reconcileCitations(fixture.body, [citation(url, marker)], fixture.style);
      expect(result.citations[0]?.placement, `${fixture.provider} case ${fixture.case}`).toBe('inline');
    }
  });

  it('normalizes surviving Markdown links', () => {
    const result = reconcileCitations(
      'A claim [Source](https://example.com/a?utm_source=x).',
      [citation('https://example.com/a')],
      'markdown_link',
    );
    expect(result.markdown).toContain('[1](https://example.com/a)');
    expect(result.citations[0]).toMatchObject({ index: 1, placement: 'inline' });
  });

  it('maps numeric markers only when counts match', () => {
    const result = reconcileCitations('First claim [7]. Second claim [8].', [citation('https://a.test'), citation('https://b.test')], 'numeric_bracket');
    expect(result.markdown).toContain('[1](https://a.test/)');
    expect(result.markdown).toContain('[2](https://b.test/)');
    expect(result.unplacedCitationCount).toBe(0);
  });

  it('places unambiguous stripped citations and leaves weak matches unplaced', () => {
    const body = 'The reviewed evidence indicates a durable response. A separate observation follows.';
    const result = reconcileCitations(body, [
      citation('https://a.test', undefined, 'The reviewed evidence indicates a durable response.'),
      { ...citation('https://b.test', undefined, 'words absent from the report entirely'), domOrder: 1 },
    ], 'none');
    expect(result.citations.some((item) => item.placement === 'inline')).toBe(true);
    expect(result.unplacedCitationCount).toBe(1);
  });

  it('uses a conservative token similarity score', () => {
    expect(tokenSimilarity('alpha beta gamma', 'alpha beta gamma')).toBe(1);
    expect(tokenSimilarity('alpha beta', 'unrelated terms')).toBe(0);
  });
});
