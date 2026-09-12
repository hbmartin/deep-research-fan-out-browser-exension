import type { Citation, DomCitation } from './types';

const TRACKING_PARAMS = new Set(['fbclid', 'gclid']);

export function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return value;
  }
}

function plain(value: string): string {
  return value
    .replace(/!?(\[([^\]]+)\])\([^)]*\)/g, '$2')
    .replace(/[`*_>#~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(plain(value).split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1));
}

export function tokenSimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return (2 * common) / (left.size + right.size);
}

function sentenceInsertionOffset(markdown: string, approximate: number): number {
  const after = markdown.slice(approximate, approximate + 120);
  const punctuation = after.search(/[.!?](?:["')\]]*)\s/);
  return punctuation >= 0 ? approximate + punctuation + 1 : approximate;
}

export interface ReconcileResult {
  markdown: string;
  citations: Citation[];
  unplacedCitationCount: number;
}

export function reconcileCitations(
  markdown: string,
  inventory: DomCitation[],
  style: 'numeric_bracket' | 'superscript' | 'markdown_link' | 'none',
  threshold = 0.82,
): ReconcileResult {
  const canonical = new Map<string, Citation>();
  const ordered: Citation[] = [];
  for (const item of [...inventory].sort((a, b) => a.domOrder - b.domOrder)) {
    const url = normalizeUrl(item.url);
    if (canonical.has(url)) continue;
    const citation: Citation = { index: ordered.length + 1, url, originalUrl: item.originalUrl, title: item.title, placement: 'unplaced' };
    canonical.set(url, citation);
    ordered.push(citation);
  }

  let output = markdown;
  if (style === 'markdown_link') {
    output = output.replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, (whole, label: string, rawUrl: string) => {
      const citation = canonical.get(normalizeUrl(rawUrl));
      if (!citation) return whole;
      citation.placement = 'inline';
      return `[${citation.index}](${citation.url})`;
    });
  }

  if (style === 'numeric_bracket') {
    const matches = [...output.matchAll(/\[(\d+)](?!\()/g)];
    if (matches.length === ordered.length) {
      let occurrence = 0;
      output = output.replace(/\[(\d+)](?!\()/g, () => {
        const citation = ordered[occurrence++]!;
        citation.placement = 'inline';
        return `[${citation.index}](${citation.url})`;
      });
    }
  }

  if (style === 'superscript') {
    for (const [position, item] of inventory.entries()) {
      if (!item.markerText || !output.includes(item.markerText)) continue;
      const citation = ordered.find((entry) => entry.url === normalizeUrl(item.url));
      if (!citation) continue;
      output = output.replace(item.markerText, `[${citation.index}](${citation.url})`);
      citation.placement = 'inline';
      citation.confidence = 1;
      if (position >= ordered.length) break;
    }
  }

  let minimumOffset = 0;
  for (const item of inventory) {
    const citation = canonical.get(normalizeUrl(item.url));
    if (!citation || citation.placement === 'inline') continue;
    const context = plain(item.contextBefore).slice(-120);
    if (!context) continue;
    const searchText = plain(output);
    const needle = context.slice(-Math.min(context.length, 70));
    let index = searchText.indexOf(needle, minimumOffset);
    let confidence = index >= 0 ? 1 : 0;
    if (index < 0) {
      const words = needle.split(' ');
      for (let cursor = minimumOffset; cursor < searchText.length; cursor += 40) {
        const candidate = searchText.slice(cursor, cursor + Math.max(needle.length, 80));
        const score = tokenSimilarity(needle, candidate);
        if (score > confidence) {
          confidence = score;
          index = cursor + candidate.indexOf(words[0]!);
        }
      }
    }
    if (index < 0 || confidence < threshold) continue;
    const rawNeedle = item.contextBefore.trim().slice(-60);
    const rawIndex = output.toLowerCase().indexOf(rawNeedle.toLowerCase(), minimumOffset);
    const approximate = rawIndex >= 0 ? rawIndex + rawNeedle.length : Math.min(output.length, index + context.length);
    const insertion = sentenceInsertionOffset(output, approximate);
    const marker = `[${citation.index}](${citation.url})`;
    output = `${output.slice(0, insertion)}${marker}${output.slice(insertion)}`;
    citation.placement = 'inline';
    citation.confidence = confidence;
    minimumOffset = insertion + marker.length;
  }

  const placed = ordered.filter((citation) => citation.placement === 'inline');
  const unplaced = ordered.filter((citation) => citation.placement === 'unplaced');
  const renumbered = [...placed, ...unplaced].map((citation, index) => ({ ...citation, index: index + 1 }));
  for (const citation of ordered) {
    const next = renumbered.find((item) => item.url === citation.url);
    if (next && next.index !== citation.index) {
      output = output.replaceAll(`[${citation.index}](${citation.url})`, `@@DRFO_CITATION_${citation.index}@@`);
    }
  }
  for (const citation of ordered) {
    const next = renumbered.find((item) => item.url === citation.url);
    if (next) output = output.replaceAll(`@@DRFO_CITATION_${citation.index}@@`, `[${next.index}](${next.url})`);
  }
  return { markdown: output.trim(), citations: renumbered, unplacedCitationCount: unplaced.length };
}
