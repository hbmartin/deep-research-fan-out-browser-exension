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
export type ArtifactSaveDestination = 'directory' | 'downloads';
export type ArtifactSaveFallbackReason = 'permission_required' | 'directory_unavailable' | 'write_failed';

export interface ArtifactSaveReceipt {
  destination: ArtifactSaveDestination;
  requestedRelativePath: string;
  actualRelativePath?: string;
  savedAt: number;
  downloadId?: number;
  fallbackReason?: ArtifactSaveFallbackReason;
}

export interface ReportDirectoryConfig {
  handle: FileSystemDirectoryHandle;
  displayName: string;
  configuredAt: number;
  needsReconnect: boolean;
}

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

export type ResearchSearchKind = 'web' | 'x';

export interface CapturedSource {
  url: string;
  title: string;
  snippet?: string;
  outboundUrls?: string[];
}

export interface CapturedSearch {
  kind: ResearchSearchKind;
  query: string;
  expectedResultCount: number;
  results: CapturedSource[];
}

export interface CapturedResearchTrail {
  reportedResultCount?: number;
  searches: CapturedSearch[];
  openedPages: CapturedSource[];
  warnings: string[];
}

export interface ResearchSearch {
  index: number;
  kind: ResearchSearchKind;
  query: string;
  expectedResultCount: number;
  capturedResultCount: number;
  sourceIds: string[];
}

export interface ResearchSource {
  id: string;
  url: string;
  title: string;
  snippet?: string;
  outboundUrls: string[];
  searchIndexes: number[];
  opened: boolean;
  cited: boolean;
}

export interface ResearchTrail {
  searches: ResearchSearch[];
  sources: ResearchSource[];
  expectedResultCount: number;
  capturedResultCount: number;
  complete: boolean;
  warnings: string[];
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
  researchTrail?: ResearchTrail;
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
  researchTimedOutAt?: number;
  conversationKey?: string;
  completedAt?: number;
  captureId?: string;
  attempts: number;
  degraded: boolean;
  adapterVersion: string;
  saveReceipt?: ArtifactSaveReceipt;
  /** @deprecated Migrated to saveReceipt when a v1 run is read. */
  downloadId?: number;
  /** @deprecated Migrated to saveReceipt when a v1 run is read. */
  downloadedAt?: number;
  copiedAt?: number;
  reconcileFailureCount?: number;
}

export interface Run {
  id: RunId;
  browserSessionId?: string;
  query: string;
  createdAt: number;
  completedAt?: number;
  tabGroupId?: number;
  windowId: number;
  providerRuns: Partial<Record<ProviderId, ProviderRun>>;
  status: RunStatus;
  slug: string;
  reportFolder: string;
  downloadFolder: string;
}

export interface CaptureJob {
  id: string;
  runId: RunId;
  provider: ProviderId;
  conversationKey?: string;
  tabId: number;
  state: 'queued' | 'leased';
  createdAt: number;
  leasedAt?: number;
  attempts: number;
  tabUnavailable?: boolean;
  domMarkdown: string;
  domCitations: DomCitation[];
  copyControlObserved?: boolean;
  researchTrail?: CapturedResearchTrail;
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
