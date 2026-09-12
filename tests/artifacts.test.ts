import { describe, expect, it } from 'vitest';
import { buildArtifact } from '../src/artifacts';
import type { Capture, ProviderRun, Run } from '../src/types';

const providerRun: ProviderRun = {
  provider: 'gemini', tabId: 3, status: 'complete', submittedQuery: 'Query\nSuffix', appendString: 'Suffix',
  startedAt: 1000, completedAt: 5000, attempts: 0, degraded: false, adapterVersion: 'gemini@test',
};
const run: Run = {
  id: 'run-id', query: 'Query', createdAt: 1000, completedAt: 5000, windowId: 1,
  providerRuns: { gemini: providerRun }, status: 'complete', slug: 'query', downloadFolder: 'deep-research/query',
};
const capture: Capture = {
  rawMarkdown: 'Report', normalizedMarkdown: 'Report [1](https://example.com)',
  citations: [{ index: 1, url: 'https://example.com', title: 'Example', placement: 'inline' }],
  captureMethod: 'copy+dom', unplacedCitationCount: 0, capturedAt: 5000, urlsResolved: 1, urlsUnresolved: 0,
};

describe('Markdown artifacts', () => {
  it('includes deterministic metadata, report, and references', () => {
    const artifact = buildArtifact(run, providerRun, capture);
    expect(artifact).toContain('query: "Query"');
    expect(artifact).toContain('duration_seconds: 4');
    expect(artifact).toContain('## References');
    expect(artifact).toContain('[1] Example — https://example.com');
  });

  it('emits a useful status file without a capture', () => {
    const failed = { ...providerRun, status: 'failed' as const, statusDetail: 'Capture failed.' };
    const artifact = buildArtifact({ ...run, providerRuns: { gemini: failed } }, failed);
    expect(artifact).toContain('# Gemini report unavailable');
    expect(artifact).toContain('Capture failed.');
  });
});
