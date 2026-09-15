import { describe, expect, it } from 'vitest';
import { buildArtifact, buildCurrentResponseCopy } from '../src/artifacts';
import type { Capture, ProviderRun, Run } from '../src/types';

const providerRun: ProviderRun = {
  provider: 'gemini', tabId: 3, status: 'complete', submittedQuery: 'Query\nSuffix', appendString: 'Suffix',
  startedAt: 1000, completedAt: 5000, attempts: 0, degraded: false, adapterVersion: 'gemini@test',
};
const run: Run = {
  id: 'run-id', query: 'Query', createdAt: 1000, completedAt: 5000, windowId: 1,
  providerRuns: { gemini: providerRun }, status: 'complete', slug: 'query', reportFolder: 'query-runid000', downloadFolder: 'deep-research/query-runid000',
};
const capture: Capture = {
  rawMarkdown: 'Report', normalizedMarkdown: 'Report [1](https://example.com)',
  citations: [{ index: 1, url: 'https://example.com', title: 'Example', placement: 'inline' }],
  captureMethod: 'copy+dom', unplacedCitationCount: 0, capturedAt: 5000, urlsResolved: 1, urlsUnresolved: 0,
};

const researchCapture: Capture = {
  ...capture,
  researchTrail: {
    expectedResultCount: 2,
    capturedResultCount: 1,
    complete: false,
    warnings: ['Search 1 expected 2 results but captured 1.'],
    searches: [{
      index: 1, kind: 'web', query: 'source `query`', expectedResultCount: 2,
      capturedResultCount: 1, sourceIds: ['SRC-001'],
    }],
    sources: [{
      id: 'SRC-001', url: 'https://example.com/source', title: 'Source [title]',
      snippet: 'A useful source snippet.', outboundUrls: ['https://example.com/outbound'],
      searchIndexes: [1], opened: true, cited: true,
    }],
  },
};

describe('Markdown artifacts', () => {
  it('includes deterministic metadata, report, and references', () => {
    const artifact = buildArtifact(run, providerRun, capture);
    expect(artifact).toContain('query: "Query"');
    expect(artifact).toContain('duration_seconds: 4');
    expect(artifact).toContain('## References');
    expect(artifact).toContain('[1] Example — https://example.com');
  });

  it('copies only the normalized current body and non-empty references', () => {
    const current = buildCurrentResponseCopy('Current report [1].', capture.citations);
    expect(current).toBe('Current report [1].\n\n## References\n\n[1] Example — https://example.com\n');
    expect(buildCurrentResponseCopy('Current report.', [])).toBe('Current report.\n');
    expect(current).not.toContain('run_id:');
  });

  it('emits a useful status file without a capture', () => {
    const failed = { ...providerRun, status: 'failed' as const, statusDetail: 'Capture failed.' };
    const artifact = buildArtifact({ ...run, providerRuns: { gemini: failed } }, failed);
    expect(artifact).toContain('# Gemini report unavailable');
    expect(artifact).toContain('Capture failed.');
  });

  it('renders a search index, deduplicated source catalog, and partial warning', () => {
    const artifact = buildArtifact(run, providerRun, researchCapture, { includeSourceSnippets: true });
    expect(artifact).toContain('expected_source_results: 2');
    expect(artifact).toContain('## Searches');
    expect(artifact).toContain('`` source `query` ``');
    expect(artifact).toContain('Sources: SRC-001');
    expect(artifact).toContain('## Sources');
    expect(artifact).toContain('[Source \\[title\\]](https://example.com/source)');
    expect(artifact).toContain('A useful source snippet.');
    expect(artifact).toContain('Outbound links: <https://example.com/outbound>');
    expect(artifact).toContain('Source capture warning');
  });

  it('omits snippets and nested links when configured while retaining titles and URLs', () => {
    const artifact = buildArtifact(run, providerRun, researchCapture, { includeSourceSnippets: false });
    expect(artifact).toContain('[Source \\[title\\]](https://example.com/source)');
    expect(artifact).not.toContain('A useful source snippet.');
    expect(artifact).not.toContain('https://example.com/outbound');
  });

});
