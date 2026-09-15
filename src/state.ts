import {
  ATTENTION_PROVIDER_STATUSES,
  isTerminalProviderStatus,
  type ProviderRunStatus,
  type Run,
  type RunStatus,
} from './types';

const transitions: Record<ProviderRunStatus, ReadonlySet<ProviderRunStatus>> = {
  pending: new Set(['opening', 'abandoned', 'interrupted', 'failed']),
  opening: new Set(['awaiting_ready', 'manual_required', 'unauthenticated', 'quota_exhausted', 'interrupted', 'abandoned', 'failed']),
  awaiting_ready: new Set(['setting_mode', 'manual_required', 'unauthenticated', 'quota_exhausted', 'interrupted', 'abandoned', 'failed']),
  setting_mode: new Set(['submitting', 'manual_required', 'awaiting_user', 'unauthenticated', 'quota_exhausted', 'interrupted', 'abandoned', 'failed']),
  submitting: new Set(['researching', 'manual_required', 'unauthenticated', 'quota_exhausted', 'interrupted', 'abandoned', 'failed']),
  researching: new Set(['awaiting_user', 'capturing', 'manual_required', 'quota_exhausted', 'interrupted', 'abandoned', 'failed']),
  awaiting_user: new Set(['researching', 'capturing', 'manual_required', 'quota_exhausted', 'interrupted', 'abandoned', 'failed']),
  manual_required: new Set(['researching', 'awaiting_user', 'capturing', 'quota_exhausted', 'interrupted', 'abandoned', 'failed']),
  capturing: new Set(['complete', 'researching', 'manual_required', 'interrupted', 'abandoned', 'failed']),
  complete: new Set(),
  unauthenticated: new Set(),
  quota_exhausted: new Set(),
  interrupted: new Set(),
  abandoned: new Set(),
  failed: new Set(),
};

const SETUP_PROVIDER_STATUSES: ReadonlySet<ProviderRunStatus> = new Set([
  'pending',
  'opening',
  'awaiting_ready',
  'setting_mode',
]);

export function isSetupProviderStatus(status: ProviderRunStatus): boolean {
  return SETUP_PROVIDER_STATUSES.has(status);
}

export function canTransition(from: ProviderRunStatus, to: ProviderRunStatus): boolean {
  return from === to || transitions[from].has(to);
}

export function assertTransition(from: ProviderRunStatus, to: ProviderRunStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid provider transition: ${from} -> ${to}`);
}

export function deriveRunStatus(run: Run): RunStatus {
  const providerRuns = Object.values(run.providerRuns);
  if (providerRuns.length > 0 && providerRuns.every((item) => isTerminalProviderStatus(item.status))) {
    return run.status === 'finalizing' ? 'finalizing' : 'complete';
  }
  if (providerRuns.some((item) => ATTENTION_PROVIDER_STATUSES.has(item.status))) return 'needs_attention';
  return 'active';
}

export function slugify(query: string): string {
  return query
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/-$/g, '') || 'research';
}

export function createReportFolder(slug: string, runId: string): string {
  const suffix = runId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8).padEnd(8, '0');
  return `${slug.slice(0, 48) || 'research'}-${suffix}`;
}

export function createDownloadFolder(root: string, slug: string, runId: string): string {
  return `${root}/${createReportFolder(slug, runId)}`;
}
