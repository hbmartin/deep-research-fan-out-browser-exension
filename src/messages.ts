import type { CaptureJob, CapturedResearchTrail, DomCitation, ProviderId, ProviderRunStatus, Run, RunId } from './types';

export interface CurrentResponseSnapshot {
  provider: ProviderId;
  pageUrl: string;
  activeRunId?: RunId;
  conversationKey?: string;
  domMarkdown: string;
  domCitations: DomCitation[];
}

export type RuntimeErrorCode = 'provider_terminal' | 'invalid_transition' | 'run_not_found' | 'conversation_mismatch';
export type ContentStateReason = 'research_timeout' | 'provider_navigation';

export interface ProviderSnapshot {
  status: ProviderRunStatus;
  submittedAt?: number;
  researchTimedOutAt?: number;
  conversationKey?: string;
}

export type RuntimeRequest =
  | { type: 'runs:list' }
  | { type: 'run:start'; query: string; windowId?: number }
  | { type: 'run:rerun'; runId: RunId }
  | { type: 'run:end'; runId: RunId }
  | { type: 'provider:end'; runId: RunId; provider: ProviderId }
  | { type: 'provider:focus'; runId: RunId; provider: ProviderId }
  | { type: 'provider:copy'; runId: RunId; provider: ProviderId }
  | { type: 'provider:copy-current'; runId: RunId; provider: ProviderId }
  | { type: 'provider:save'; runId: RunId; provider: ProviderId }
  | { type: 'provider:retry-capture'; runId: RunId; provider: ProviderId }
  | { type: 'content:hello'; provider: ProviderId; url: string }
  | { type: 'content:state'; runId: RunId; provider: ProviderId; status: ProviderRunStatus; detail?: string; submittedAt?: number; reason?: ContentStateReason; conversationKey?: string }
  | { type: 'content:capture'; runId: RunId; provider: ProviderId; conversationKey?: string; domMarkdown: string; domCitations: DomCitation[]; researchTrail?: CapturedResearchTrail; title?: string; copyControlObserved?: boolean }
  | { type: 'capture:clipboard-read'; requestId: string }
  | { type: 'capture:clipboard-write'; requestId: string; text: string }
  | { type: 'download:blob-create'; requestId: string; text: string }
  | { type: 'download:blob-revoke'; requestId: string; url: string }
  | { type: 'capture:offscreen-result'; requestId: string; ok: boolean; text?: string; error?: string };

export type RuntimeResponse =
  | { ok: true; runs?: Run[]; run?: Run; job?: CaptureJob; text?: string; providerState?: ProviderSnapshot }
  | { ok: false; error: string; code?: RuntimeErrorCode; providerState?: ProviderSnapshot };

export type BackgroundEvent = { type: 'runs:changed'; runs: Run[] } | {
  type: 'content:start';
  runId: RunId;
  provider: ProviderId;
  query: string;
  appendString: string;
  geminiAutoApprove: boolean;
  completionDebounceMs: number;
  resumeOnly: boolean;
  status: ProviderRunStatus;
  submittedAt?: number;
  researchTimedOutAt?: number;
  conversationKey?: string;
  captureAccepted?: boolean;
} | { type: 'content:ping'; provider: ProviderId }
  | { type: 'capture:dom-current'; provider: ProviderId; runId?: RunId; conversationKey?: string }
  | { type: 'capture:copy-now'; jobId: string; conversationKey?: string }
  | { type: 'content:stop'; runId: RunId };

export async function sendRequest(request: RuntimeRequest): Promise<RuntimeResponse> {
  return browser.runtime.sendMessage(request) as Promise<RuntimeResponse>;
}
