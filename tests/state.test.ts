import { describe, expect, it } from 'vitest';
import { canTransition, createDownloadFolder, createReportFolder, deriveRunStatus, isSetupProviderStatus, slugify } from '../src/state';
import type { ProviderRun, Run } from '../src/types';

function provider(status: ProviderRun['status']): ProviderRun {
  return { provider: 'chatgpt', tabId: 1, status, submittedQuery: 'query', appendString: '', attempts: 0, degraded: false, adapterVersion: 'test' };
}

function run(statuses: ProviderRun['status'][]): Run {
  return {
    recordVersion: 2, id: 'run', query: 'query', createdAt: 0, windowId: 1, status: 'active', slug: 'query', reportFolder: 'query-run00000', downloadFolder: 'deep-research/query-run00000',
    providerRuns: Object.fromEntries(statuses.map((status, index) => [['chatgpt', 'claude', 'gemini', 'grok'][index], { ...provider(status), provider: ['chatgpt', 'claude', 'gemini', 'grok'][index] }])) as Run['providerRuns'],
  };
}

describe('provider state machine', () => {
  it('keeps manual states recoverable and nonterminal', () => {
    expect(canTransition('manual_required', 'researching')).toBe(true);
    expect(canTransition('manual_required', 'awaiting_user')).toBe(true);
    expect(canTransition('awaiting_user', 'capturing')).toBe(true);
    expect(canTransition('manual_required', 'quota_exhausted')).toBe(true);
    expect(canTransition('awaiting_user', 'quota_exhausted')).toBe(true);
    expect(deriveRunStatus(run(['manual_required', 'complete']))).toBe('needs_attention');
  });

  it('completes only when every provider is terminal', () => {
    expect(deriveRunStatus(run(['complete', 'failed', 'abandoned', 'interrupted']))).toBe('complete');
    expect(canTransition('complete', 'researching')).toBe(false);
  });

  it('shares one definition of setup-phase statuses', () => {
    expect(['pending', 'opening', 'awaiting_ready', 'setting_mode'].every((status) => isSetupProviderStatus(status as ProviderRun['status']))).toBe(true);
    expect(['submitting', 'researching', 'awaiting_user', 'manual_required', 'complete'].some((status) => isSetupProviderStatus(status as ProviderRun['status']))).toBe(false);
  });
});

describe('run naming', () => {
  it('creates a safe bounded slug and local folder', () => {
    expect(slugify('  Génétique / reimbursement: 2026!  ')).toBe('genetique-reimbursement-2026');
    expect(slugify('x'.repeat(80))).toHaveLength(48);
    expect(createReportFolder('topic', 'abcd-1234')).toBe('topic-abcd1234');
    expect(createDownloadFolder('deep-research', 'topic', 'abcd-1234')).toBe('deep-research/topic-abcd1234');
  });

  it('gives same-minute runs distinct folders', () => {
    const first = createDownloadFolder('deep-research', 'topic', '11111111-aaaa');
    const second = createDownloadFolder('deep-research', 'topic', '22222222-bbbb');
    expect(first).not.toBe(second);
  });
});
