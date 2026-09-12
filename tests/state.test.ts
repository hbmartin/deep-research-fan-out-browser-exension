import { describe, expect, it } from 'vitest';
import { canTransition, createDownloadFolder, deriveRunStatus, slugify } from '../src/state';
import type { ProviderRun, Run } from '../src/types';

function provider(status: ProviderRun['status']): ProviderRun {
  return { provider: 'chatgpt', tabId: 1, status, submittedQuery: 'query', appendString: '', attempts: 0, degraded: false, adapterVersion: 'test' };
}

function run(statuses: ProviderRun['status'][]): Run {
  return {
    id: 'run', query: 'query', createdAt: 0, windowId: 1, status: 'active', slug: 'query', downloadFolder: 'deep-research/query',
    providerRuns: Object.fromEntries(statuses.map((status, index) => [['chatgpt', 'claude', 'gemini', 'grok'][index], { ...provider(status), provider: ['chatgpt', 'claude', 'gemini', 'grok'][index] }])) as Run['providerRuns'],
  };
}

describe('provider state machine', () => {
  it('keeps manual states recoverable and nonterminal', () => {
    expect(canTransition('manual_required', 'researching')).toBe(true);
    expect(canTransition('awaiting_user', 'capturing')).toBe(true);
    expect(deriveRunStatus(run(['manual_required', 'complete']))).toBe('needs_attention');
  });

  it('completes only when every provider is terminal', () => {
    expect(deriveRunStatus(run(['complete', 'failed', 'abandoned', 'interrupted']))).toBe('complete');
    expect(canTransition('complete', 'researching')).toBe(false);
  });
});

describe('run naming', () => {
  it('creates a safe bounded slug and local folder', () => {
    expect(slugify('  Génétique / reimbursement: 2026!  ')).toBe('genetique-reimbursement-2026');
    expect(slugify('x'.repeat(80))).toHaveLength(48);
    expect(createDownloadFolder('deep-research', new Date(2026, 8, 12, 14, 32).getTime(), 'topic', 'abcd-1234')).toBe('deep-research/2026-09-12_1432_topic_abcd1234');
  });

  it('gives same-minute runs distinct folders', () => {
    const createdAt = new Date(2026, 8, 12, 14, 32).getTime();
    const first = createDownloadFolder('deep-research', createdAt, 'topic', '11111111-aaaa');
    const second = createDownloadFolder('deep-research', createdAt, 'topic', '22222222-bbbb');
    expect(first).not.toBe(second);
  });
});
