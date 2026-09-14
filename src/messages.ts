import type { CaptureJob, CapturedResearchTrail, DomCitation, ProviderId, ProviderRunStatus, Run, RunId } from './types';

export interface CurrentResponseSnapshot {
  domMarkdown: string;
  domCitations: DomCitation[];
}

export type RuntimeErrorCode = 'provider_terminal' | 'invalid_transition' | 'run_not_found';

export interface ProviderSnapshot {
  status: ProviderRunStatus;
  submittedAt?: number;
  researchTimedOutAt?: number;
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
  | { type: 'provider:download'; runId: RunId; provider: ProviderId }
  | { type: 'content:hello'; provider: ProviderId; url: string }
  | { type: 'content:state'; runId: RunId; provider: ProviderId; status: ProviderRunStatus; detail?: string; submittedAt?: number; reason?: 'research_timeout' }
  | { type: 'content:capture'; runId: RunId; provider: ProviderId; domMarkdown: string; domCitations: DomCitation[]; researchTrail?: CapturedResearchTrail; title?: string; copyControlObserved?: boolean }
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
  captureAccepted?: boolean;
} | { type: 'content:ping'; provider: ProviderId }
  | { type: 'capture:dom-current'; provider: ProviderId }
  | { type: 'capture:copy-now'; jobId: string }
  | { type: 'content:stop'; runId: RunId };

export async function sendRequest(request: RuntimeRequest): Promise<RuntimeResponse> {
  return browser.runtime.sendMessage(request) as Promise<RuntimeResponse>;
}
