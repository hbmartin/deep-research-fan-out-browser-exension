export const PROVIDERS = ['chatgpt', 'claude', 'gemini', 'grok'] as const;
export type ProviderId = (typeof PROVIDERS)[number];
export type RunId = string;

export type ProviderRunStatus =
  | 'pending'
  | 'opening'
  | 'awaiting_ready'
  | 'setting_mode'
  | 'submitting'
  | 'researching'
  | 'awaiting_user'
  | 'capturing'
  | 'complete'
  | 'manual_required'
  | 'unauthenticated'
  | 'quota_exhausted'
  | 'interrupted'
  | 'abandoned'
  | 'failed';

export type RunStatus = 'active' | 'needs_attention' | 'finalizing' | 'complete';
export type CaptureMethod = 'copy+dom' | 'copy_only' | 'dom_only';

export interface Citation {
  index: number;
  url: string;
  originalUrl?: string;
  title?: string;
  placement: 'inline' | 'unplaced';
  confidence?: number;
}

export interface DomCitation {
  url: string;
  originalUrl?: string;
  title?: string;
  markerText?: string;
  domOrder: number;
  contextBefore: string;
  contextAfter: string;
}

export interface Capture {
  rawMarkdown: string;
  normalizedMarkdown: string;
  citations: Citation[];
  captureMethod: CaptureMethod;
  unplacedCitationCount: number;
  capturedAt: number;
  urlsResolved: number;
  urlsUnresolved: number;
  title?: string;
}

export interface ProviderRun {
  provider: ProviderId;
  tabId: number;
  status: ProviderRunStatus;
  statusDetail?: string;
  submittedQuery: string;
  appendString: string;
  startedAt?: number;
  submittedAt?: number;
  completedAt?: number;
  captureId?: string;
  attempts: number;
  degraded: boolean;
  adapterVersion: string;
  downloadId?: number;
  downloadedAt?: number;
  copiedAt?: number;
  reconcileFailureCount?: number;
}

export interface Run {
  id: RunId;
  query: string;
  createdAt: number;
  completedAt?: number;
  tabGroupId?: number;
  windowId: number;
  providerRuns: Partial<Record<ProviderId, ProviderRun>>;
  status: RunStatus;
  slug: string;
  downloadFolder: string;
}

export interface CaptureJob {
  id: string;
  runId: RunId;
  provider: ProviderId;
  tabId: number;
  state: 'queued' | 'leased';
  createdAt: number;
  leasedAt?: number;
  attempts: number;
  domMarkdown: string;
  domCitations: DomCitation[];
  title?: string;
}

export const TERMINAL_PROVIDER_STATUSES: ReadonlySet<ProviderRunStatus> = new Set([
  'complete',
  'unauthenticated',
  'quota_exhausted',
  'interrupted',
  'abandoned',
  'failed',
]);

export const ATTENTION_PROVIDER_STATUSES: ReadonlySet<ProviderRunStatus> = new Set([
  'awaiting_user',
  'manual_required',
]);

export function isTerminalProviderStatus(status: ProviderRunStatus): boolean {
  return TERMINAL_PROVIDER_STATUSES.has(status);
}
