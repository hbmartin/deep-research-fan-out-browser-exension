import { ADAPTERS } from './adapters';
import type { Capture, ProviderRun, Run } from './types';

function yaml(value: unknown): string {
  return JSON.stringify(value ?? '');
}

function localIso(timestamp?: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function frontMatter(run: Run, providerRun: ProviderRun, capture?: Capture): string {
  const duration = providerRun.completedAt && providerRun.startedAt
    ? Math.max(0, Math.round((providerRun.completedAt - providerRun.startedAt) / 1000))
    : 0;
  const values: Record<string, unknown> = {
    query: run.query,
    provider: providerRun.provider,
    status: providerRun.status,
    status_detail: providerRun.statusDetail ?? '',
    append_string: providerRun.appendString,
    submitted_query: providerRun.submittedQuery,
    run_id: run.id,
    started_at: localIso(providerRun.startedAt),
    completed_at: localIso(providerRun.completedAt),
    duration_seconds: duration,
    capture_method: capture?.captureMethod ?? '',
    citation_count: capture?.citations.length ?? 0,
    unplaced_citations: capture?.unplacedCitationCount ?? 0,
    urls_resolved: capture?.urlsResolved ?? 0,
    urls_unresolved: capture?.urlsUnresolved ?? 0,
    degraded: providerRun.degraded,
    adapter_version: providerRun.adapterVersion,
  };
  return `---\n${Object.entries(values).map(([key, value]) => `${key}: ${yaml(value)}`).join('\n')}\n---`;
}

export function buildArtifact(run: Run, providerRun: ProviderRun, capture?: Capture): string {
  const header = frontMatter(run, providerRun, capture);
  if (!capture) {
    return `${header}\n\n# ${ADAPTERS[providerRun.provider].label} report unavailable\n\n${providerRun.statusDetail || `Provider ended with status: ${providerRun.status}.`}\n`;
  }
  const title = capture.title?.trim() || run.query;
  const references = capture.citations.length
    ? capture.citations.map((citation) => `[${citation.index}] ${citation.title ? `${citation.title} — ` : ''}${citation.url}${citation.placement === 'unplaced' ? ' <!-- unplaced -->' : ''}`).join('\n')
    : '_No citations captured._';
  return `${header}\n\n# ${title}\n\n${capture.normalizedMarkdown.trim()}\n\n## References\n\n${references}\n`;
}
