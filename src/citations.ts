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

interface PlainProjection {
  text: string;
  rawOffsets: number[];
}

function plainProjection(value: string): PlainProjection {
  const linked: Array<{ character: string; rawOffset: number }> = [];
  const linkPattern = /!?(\[([^\]]+)\])\([^)]*\)/g;
  let consumed = 0;
  for (const match of value.matchAll(linkPattern)) {
    const start = match.index;
    for (let index = consumed; index < start; index += 1) linked.push({ character: value[index]!, rawOffset: index });
    const label = match[2]!;
    const labelStart = start + match[0].indexOf(`[${label}]`) + 1;
    for (let index = 0; index < label.length; index += 1) linked.push({ character: label[index]!, rawOffset: labelStart + index });
    consumed = start + match[0].length;
  }
  for (let index = consumed; index < value.length; index += 1) linked.push({ character: value[index]!, rawOffset: index });

  const normalized: Array<{ character: string; rawOffset: number }> = [];
  let inWhitespace = false;
  for (const item of linked) {
    const character = /[`*_>#~|]/.test(item.character) ? ' ' : item.character;
    if (/\s/u.test(character)) {
      if (!inWhitespace) normalized.push({ character: ' ', rawOffset: item.rawOffset });
      inWhitespace = true;
      continue;
    }
    inWhitespace = false;
    for (const lower of character.toLowerCase()) normalized.push({ character: lower, rawOffset: item.rawOffset });
  }
  while (normalized[0]?.character === ' ') normalized.shift();
  while (normalized.at(-1)?.character === ' ') normalized.pop();
  return {
    text: normalized.map((item) => item.character).join(''),
    rawOffsets: normalized.map((item) => item.rawOffset),
  };
}

function plain(value: string): string {
  return plainProjection(value).text;
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

export function tokenContainment(candidate: string, reference: string): number {
  const candidateTokens = tokens(candidate);
  const referenceTokens = tokens(reference);
  if (!candidateTokens.size || !referenceTokens.size) return 0;
  let common = 0;
  for (const token of referenceTokens) if (candidateTokens.has(token)) common += 1;
  return common / referenceTokens.size;
}

function sentenceInsertionOffset(markdown: string, approximate: number): number {
  const after = markdown.slice(approximate, approximate + 120);
  const punctuation = after.search(/[.!?](?:["')\]]*)\s/);
  return punctuation >= 0 ? approximate + punctuation + 1 : approximate;
}

function outsideMarkdownLink(markdown: string, offset: number): number {
  const linkPattern = /!?\[[^\]]+\]\([^)]*\)/g;
  for (const match of markdown.matchAll(linkPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (offset > start && offset < end) return end;
  }
  return offset;
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
    for (const item of inventory) {
      if (!item.markerText || !output.includes(item.markerText)) continue;
      const citation = ordered.find((entry) => entry.url === normalizeUrl(item.url));
      if (!citation) continue;
      output = output.replace(item.markerText, `[${citation.index}](${citation.url})`);
      citation.placement = 'inline';
      citation.confidence = 1;
    }
  }

  const placementBase = output;
  const projection = plainProjection(placementBase);
  const pendingInsertions: Array<{ insertion: number; marker: string; order: number }> = [];
  let minimumPlainOffset = 0;
  let minimumRawOffset = 0;
  for (const [order, item] of inventory.entries()) {
    const citation = canonical.get(normalizeUrl(item.url));
    if (!citation || citation.placement === 'inline') continue;
    const context = plain(item.contextBefore).slice(-120);
    if (!context) continue;
    const searchText = projection.text;
    const needle = context.slice(-Math.min(context.length, 70));
    let index = searchText.indexOf(needle, minimumPlainOffset);
    let confidence = index >= 0 ? 1 : 0;
    if (index < 0) {
      const words = needle.split(' ');
      for (let cursor = minimumPlainOffset; cursor < searchText.length; cursor += 40) {
        const candidate = searchText.slice(cursor, cursor + Math.max(needle.length, 80));
        const score = tokenSimilarity(needle, candidate);
        const tokenIndex = candidate.indexOf(words[0]!);
        if (score > confidence && tokenIndex >= 0) {
          confidence = score;
          index = cursor + tokenIndex;
        }
      }
    }
    if (index < 0 || confidence < threshold) continue;
    const rawNeedle = item.contextBefore.trim().slice(-60);
    const rawIndex = placementBase.toLowerCase().indexOf(rawNeedle.toLowerCase(), minimumRawOffset);
    const projectedEnd = Math.min(projection.rawOffsets.length - 1, index + needle.length - 1);
    const mappedOffset = projectedEnd >= 0 ? projection.rawOffsets[projectedEnd]! + 1 : placementBase.length;
    const approximate = rawIndex >= 0 ? rawIndex + rawNeedle.length : mappedOffset;
    const insertion = outsideMarkdownLink(placementBase, sentenceInsertionOffset(placementBase, approximate));
    const marker = `[${citation.index}](${citation.url})`;
    pendingInsertions.push({ insertion, marker, order });
    citation.placement = 'inline';
    citation.confidence = confidence;
    minimumPlainOffset = index + needle.length;
    minimumRawOffset = insertion;
  }
  for (const item of pendingInsertions.sort((a, b) => b.insertion - a.insertion || b.order - a.order)) {
    output = `${output.slice(0, item.insertion)}${item.marker}${output.slice(item.insertion)}`;
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
