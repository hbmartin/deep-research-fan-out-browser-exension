import { ADAPTERS } from './adapters';
import type { Capture, Citation, ProviderRun, Run } from './types';

export interface ArtifactOptions {
  includeSourceSnippets?: boolean;
}

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

function frontMatter(run: Run, providerRun: ProviderRun, capture?: Capture, options: ArtifactOptions = {}): string {
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
    metadata_degraded: capture?.metadataDegraded ?? false,
    degraded: providerRun.degraded,
    adapter_version: providerRun.adapterVersion,
    ...(capture?.researchTrail ? {
      search_count: capture.researchTrail.searches.length,
      expected_source_results: capture.researchTrail.expectedResultCount,
      captured_source_results: capture.researchTrail.capturedResultCount,
      unique_source_count: capture.researchTrail.sources.length,
      source_capture_complete: capture.researchTrail.complete,
      source_capture_warnings: capture.researchTrail.warnings,
      source_snippets_included: options.includeSourceSnippets ?? true,
    } : {}),
  };
  return `---\n${Object.entries(values).map(([key, value]) => `${key}: ${yaml(value)}`).join('\n')}\n---`;
}

function markdownText(value: string): string {
  return value.replace(/([\\[\]*_<>`])/g, '\\$1').replace(/\s+/g, ' ').trim();
}

function inlineCode(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  const longestRun = Math.max(0, ...(clean.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence} ${clean} ${fence}`;
}

function researchTrailMarkdown(capture: Capture, options: ArtifactOptions): string {
  const trail = capture.researchTrail;
  if (!trail) return '';
  const warnings = trail.warnings.length
    ? `\n> **Source capture warning:** ${trail.warnings.map(markdownText).join(' ')}\n`
    : '';
  const searches = trail.searches.length
    ? trail.searches.map((search) => {
      const label = search.kind === 'web' ? 'Web' : 'X';
      const count = search.capturedResultCount === search.expectedResultCount
        ? `${search.capturedResultCount} results`
        : `${search.capturedResultCount} of ${search.expectedResultCount} results captured`;
      return `${search.index}. **${label}** — ${inlineCode(search.query)} — ${count}\n   - Sources: ${search.sourceIds.join(', ') || '_None captured_'}`;
    }).join('\n\n')
    : '_No search groups captured._';
  const includeSnippets = options.includeSourceSnippets ?? true;
  const sources = trail.sources.length
    ? trail.sources.map((source, index) => {
      const metadata: string[] = [];
      if (source.searchIndexes.length) metadata.push(`Found in searches: ${source.searchIndexes.join(', ')}`);
      if (source.opened) metadata.push('Opened page: yes');
      if (source.cited) metadata.push('Cited in answer: yes');
      const details = metadata.map((value) => `   - ${value}`).join('\n');
      const snippet = includeSnippets && source.snippet ? `\n   > ${markdownText(source.snippet)}` : '';
      const outbound = includeSnippets && source.outboundUrls.length
        ? `\n   - Outbound links: ${source.outboundUrls.map((url) => `<${url}>`).join(', ')}`
        : '';
      return `${index + 1}. **${source.id}** — [${markdownText(source.title)}](${source.url})${details ? `\n${details}` : ''}${snippet}${outbound}`;
    }).join('\n\n')
    : '_No sources captured._';
  return `\n\n## Searches\n${warnings}\n${searches}\n\n## Sources\n\n${sources}`;
}

export function formatReferences(citations: readonly Citation[]): string {
  return citations.map((citation) => `[${citation.index}] ${citation.title ? `${citation.title} — ` : ''}${citation.url}${citation.placement === 'unplaced' ? ' <!-- unplaced -->' : ''}`).join('\n');
}

export function buildCurrentResponseCopy(markdown: string, citations: readonly Citation[]): string {
  const body = markdown.trim();
  const references = formatReferences(citations);
  return `${body}${references ? `\n\n## References\n\n${references}` : ''}\n`;
}

export function buildArtifact(run: Run, providerRun: ProviderRun, capture?: Capture, options: ArtifactOptions = {}): string {
  const header = frontMatter(run, providerRun, capture, options);
  if (!capture) {
    return `${header}\n\n# ${ADAPTERS[providerRun.provider].label} report unavailable\n\n${providerRun.statusDetail || `Provider ended with status: ${providerRun.status}.`}\n`;
  }
  const title = capture.title?.trim() || run.query;
  const references = capture.citations.length
    ? formatReferences(capture.citations)
    : '_No citations captured._';
  const researchTrail = researchTrailMarkdown(capture, options);
  return `${header}\n\n# ${title}\n\n${capture.normalizedMarkdown.trim()}\n\n## References\n\n${references}${researchTrail}\n`;
}
