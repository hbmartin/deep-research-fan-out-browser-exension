import type { ProviderId } from './types';
import { DURATION_PATTERN } from './durations';

export type Selector =
  | { kind: 'aria'; role: string; name?: string | RegExp; pick?: 'first' | 'last' }
  | { kind: 'testid'; value: string; pick?: 'first' | 'last' }
  | { kind: 'css'; value: string; pick?: 'first' | 'last' }
  | { kind: 'text'; value: string | RegExp; within?: string; pick?: 'first' | 'last' };
export type SelectorChain = Selector[];

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  version: string;
  origin: string;
  authenticationOrigins?: readonly string[];
  entryUrl: string;
  entryPathPatterns: readonly RegExp[];
  conversationPathPatterns: readonly RegExp[];
  composerKind: 'contenteditable' | 'textarea';
  submitStrategy: 'button' | 'enter';
  citationMarkerStyle: 'numeric_bracket' | 'superscript' | 'markdown_link' | 'none';
  urlResolution: 'none' | 'follow_redirect';
  clarifyingPromptPattern?: RegExp;
  progressResponsePattern: RegExp;
  quotaResponsePattern: RegExp;
  /** Verified post-click success marker. */
  copySuccessSelector?: string;
  selectors: {
    composer: SelectorChain;
    submitButton: SelectorChain;
    modeEntry: SelectorChain;
    modeOption: SelectorChain;
    modeConfirmed: SelectorChain;
    streamingIndicator: SelectorChain;
    finalMessageRoot: SelectorChain;
    copyButton: SelectorChain;
    citationAnchors: SelectorChain;
    sourcesPanelToggle?: SelectorChain;
    loginWall: SelectorChain;
    quotaNotice: SelectorChain;
    planApproval?: SelectorChain;
  };
}

const commonLogin: SelectorChain = [
  { kind: 'aria', role: 'button', name: /log in|sign in/i },
  { kind: 'text', value: /log in to continue|sign in to continue/i },
];

const progressOpening = String.raw`(?:i(?:['’]ll| will| am going to| am|['’]m)\s+(?:(?:start(?:ing)?|begin(?:ning)?)\s+(?:(?:the|your)\s+)?(?:deep\s+)?(?:research(?:ing)?|search(?:ing)?|work(?:ing)?)\b|(?:research(?:ing)?|search(?:ing)?|work(?:ing)?)\b)|(?:starting|beginning|conducting|continuing)\s+(?:(?:the|your)\s+)?(?:deep\s+)?research\b|(?:researching|searching)\b)`;
const progressFollowup = String.raw`(?:(?:(?:this|that|it|the (?:research|search|process))\s+(?:may|might|can|could|will|should)\s+take\b|i(?:['’]ll| will)\s+(?:let you know|update you|return|be back)\b|please\s+(?:wait|hold on)\b)[^.!?…]{0,160}[.!?…]*)`;
const commonProgressResponse = new RegExp(`^${progressOpening}(?:\\s+[^.!?…]{0,200})?\\s*[.!?…]*(?:\\s+${progressFollowup})?$`, 'i');
const commonQuotaResponse = /^(?:(?:sorry|unfortunately)[,.!]?\s*)?(?:(?:you(?:'ve| have)?|your account has)\s+)?(?:reached|hit|exceeded)\s+(?:your\s+)?(?:(?:deepsearch|deep research|research|usage)\s+)?limit\b|^(?:your\s+)?(?:deepsearch|deep research|research|usage)\s+limit\s+(?:has been\s+)?(?:reached|exceeded)\b|^(?:deepsearch|deep research|research)\s+(?:is\s+)?unavailable\b|^upgrade\b.{0,80}\b(?:deepsearch|deep research|research)\b/i;
const commonCopyButton: SelectorChain = [{ kind: 'aria', role: 'button', name: /^(?:copy|copy response)$/i, pick: 'last' }];
const streamingDuration = DURATION_PATTERN;
const streamingActivity = String.raw`(?:(?:reading|searching|reviewing|analy[sz]ing|browsing|checking|visiting|summari[sz]ing|collecting|consulting)\s+(?:the\s+)?(?:web|sites?|sources?|pages?|results?|documents?))`;
const streamingSuffix = String.raw`(?:\s*(?:…|\.{1,3})|\s+(?:[·•—-]\s*)?(?:\d+\s+sources?|${streamingDuration}|${streamingActivity}))?`;

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  chatgpt: {
    // Success markers verified in tests/fixtures/chatgpt-copy-feedback.json.
    copySuccessSelector: '[data-copy-state="copied"], svg use[href="#lightweight-conversation-check"]',
    id: 'chatgpt', label: 'ChatGPT', version: 'chatgpt@0.2.1', origin: 'https://chatgpt.com', entryUrl: 'https://chatgpt.com/',
    entryPathPatterns: [/^\/$/],
    conversationPathPatterns: [/^\/c\/[^/]+$/, /^\/g\/[^/]+\/c\/[^/]+$/],
    composerKind: 'contenteditable', submitStrategy: 'button', citationMarkerStyle: 'markdown_link', urlResolution: 'none',
    clarifyingPromptPattern: /^(?:(?:great|thanks|thank you|sure|certainly|absolutely|of course|i can help with that)[^.!?]{0,120}[.!?—,:-]\s*)?(?:before i begin\b|could you (?:please )?(?:clarify|specify)\b)/i,
    progressResponsePattern: commonProgressResponse,
    quotaResponsePattern: commonQuotaResponse,
    selectors: {
      composer: [{ kind: 'testid', value: 'prompt-textarea' }, { kind: 'css', value: '#prompt-textarea' }, { kind: 'aria', role: 'textbox' }],
      submitButton: [{ kind: 'testid', value: 'send-button' }, { kind: 'aria', role: 'button', name: /send/i }],
      modeEntry: [{ kind: 'aria', role: 'button', name: /tools|choose tools|deep research/i }, { kind: 'text', value: /tools/i }],
      modeOption: [{ kind: 'aria', role: 'menuitem', name: /deep research/i }, { kind: 'text', value: /^deep research$/i }],
      modeConfirmed: [{ kind: 'css', value: '[data-testid="deep-research-pill"]' }, { kind: 'css', value: 'button[aria-pressed="true"][aria-label*="deep research" i]' }, { kind: 'css', value: '[data-state="on"][aria-label*="deep research" i]' }],
      streamingIndicator: [{ kind: 'testid', value: 'stop-button' }, { kind: 'aria', role: 'button', name: /stop generating|stop streaming/i }],
      finalMessageRoot: [{ kind: 'css', value: '[data-message-author-role="assistant"]', pick: 'last' }],
      copyButton: commonCopyButton,
      citationAnchors: [{ kind: 'css', value: 'a[href^="http"]' }],
      sourcesPanelToggle: [{ kind: 'aria', role: 'button', name: /sources|citations/i, pick: 'last' }],
      loginWall: commonLogin,
      quotaNotice: [{ kind: 'text', value: commonQuotaResponse }],
    },
  },
  claude: {
    id: 'claude', label: 'Claude', version: 'claude@0.1.1', origin: 'https://claude.ai', entryUrl: 'https://claude.ai/new',
    entryPathPatterns: [/^\/new$/],
    conversationPathPatterns: [/^\/chat\/[^/]+$/],
    composerKind: 'contenteditable', submitStrategy: 'button', citationMarkerStyle: 'markdown_link', urlResolution: 'none',
    progressResponsePattern: commonProgressResponse,
    quotaResponsePattern: commonQuotaResponse,
    selectors: {
      composer: [{ kind: 'css', value: '[contenteditable="true"][role="textbox"]' }, { kind: 'aria', role: 'textbox' }],
      submitButton: [{ kind: 'aria', role: 'button', name: /send message|send/i }],
      modeEntry: [{ kind: 'aria', role: 'button', name: /research|mode|tools/i }, { kind: 'text', value: /research/i }],
      modeOption: [{ kind: 'aria', role: 'menuitem', name: /research/i }, { kind: 'text', value: /research/i }],
      modeConfirmed: [{ kind: 'css', value: 'button[aria-pressed="true"][aria-label*="research" i]' }, { kind: 'css', value: '[data-state="on"][aria-label*="research" i]' }, { kind: 'css', value: '[data-testid*="research"][aria-pressed="true"]' }],
      streamingIndicator: [{ kind: 'aria', role: 'button', name: /stop response|stop/i }],
      finalMessageRoot: [{ kind: 'css', value: '[data-is-streaming="false"]', pick: 'last' }, { kind: 'css', value: 'div[data-testid="assistant-message"]', pick: 'last' }],
      copyButton: commonCopyButton,
      citationAnchors: [{ kind: 'css', value: 'a[href^="http"]' }],
      loginWall: commonLogin,
      quotaNotice: [{ kind: 'text', value: commonQuotaResponse }],
    },
  },
  gemini: {
    id: 'gemini', label: 'Gemini', version: 'gemini@0.1.2', origin: 'https://gemini.google.com', entryUrl: 'https://gemini.google.com/app',
    entryPathPatterns: [/^\/(?:u\/\d+\/)?app$/],
    conversationPathPatterns: [/^\/(?:u\/\d+\/)?app\/(?!download$)[^/]+$/],
    authenticationOrigins: ['https://accounts.google.com'],
    composerKind: 'contenteditable', submitStrategy: 'button', citationMarkerStyle: 'superscript', urlResolution: 'follow_redirect',
    progressResponsePattern: commonProgressResponse,
    quotaResponsePattern: commonQuotaResponse,
    selectors: {
      composer: [{ kind: 'css', value: 'rich-textarea [contenteditable="true"]' }, { kind: 'aria', role: 'textbox' }],
      submitButton: [{ kind: 'aria', role: 'button', name: /send message|send/i }],
      modeEntry: [{ kind: 'aria', role: 'button', name: /tools|deep research/i }, { kind: 'text', value: /deep research/i }],
      modeOption: [{ kind: 'aria', role: 'menuitem', name: /deep research/i }, { kind: 'text', value: /^deep research$/i }],
      modeConfirmed: [{ kind: 'css', value: 'button[aria-pressed="true"][aria-label*="deep research" i]' }, { kind: 'css', value: '[data-test-id="deep-research-chip"]' }, { kind: 'css', value: '[data-state="selected"][aria-label*="deep research" i]' }],
      streamingIndicator: [{ kind: 'aria', role: 'button', name: /stop response|stop/i }, { kind: 'text', value: new RegExp(`^(?:researching|thinking|working on it)${streamingSuffix}$`, 'i') }],
      finalMessageRoot: [{ kind: 'css', value: 'model-response', pick: 'last' }, { kind: 'css', value: '[data-test-id="model-response"]', pick: 'last' }],
      copyButton: commonCopyButton,
      citationAnchors: [{ kind: 'css', value: 'a[href^="http"]' }],
      sourcesPanelToggle: [{ kind: 'aria', role: 'button', name: /sources/i, pick: 'last' }],
      loginWall: commonLogin,
      quotaNotice: [{ kind: 'text', value: commonQuotaResponse }],
      planApproval: [{ kind: 'aria', role: 'button', name: /start research|begin research|approve/i }],
    },
  },
  grok: {
    id: 'grok', label: 'Grok', version: 'grok@0.2.2', origin: 'https://grok.com', entryUrl: 'https://grok.com/',
    entryPathPatterns: [/^\/$/],
    conversationPathPatterns: [/^\/c\/[^/]+$/],
    composerKind: 'contenteditable', submitStrategy: 'button', citationMarkerStyle: 'markdown_link', urlResolution: 'none',
    progressResponsePattern: commonProgressResponse,
    quotaResponsePattern: commonQuotaResponse,
    selectors: {
      composer: [{ kind: 'css', value: '[contenteditable="true"][role="textbox"]' }, { kind: 'aria', role: 'textbox' }],
      submitButton: [{ kind: 'aria', role: 'button', name: /submit|send/i }],
      modeEntry: [{ kind: 'aria', role: 'button', name: /deepsearch|deep research|mode/i }, { kind: 'text', value: /deepsearch|deep research/i }],
      modeOption: [{ kind: 'aria', role: 'menuitem', name: /deepsearch|deep research/i }, { kind: 'text', value: /deepsearch|deep research/i }],
      modeConfirmed: [{ kind: 'css', value: 'button[aria-pressed="true"][aria-label*="deep" i]' }, { kind: 'css', value: '[data-state="on"][aria-label*="deep" i]' }, { kind: 'css', value: '[data-testid*="deep"][aria-pressed="true"]' }],
      streamingIndicator: [{ kind: 'aria', role: 'button', name: /stop/i }, { kind: 'text', value: new RegExp(`^(?:searching|thinking|researching)${streamingSuffix}$`, 'i') }],
      finalMessageRoot: [{ kind: 'css', value: '[data-testid="assistant-message"]', pick: 'last' }, { kind: 'css', value: 'article', pick: 'last' }],
      copyButton: [{ kind: 'aria', role: 'button', name: /^copy response$/i, pick: 'last' }],
      citationAnchors: [{ kind: 'css', value: 'a[href^="http"]' }],
      sourcesPanelToggle: [{ kind: 'aria', role: 'button', name: /^\d+\s+sources$/i, pick: 'last' }],
      loginWall: commonLogin,
      quotaNotice: [{ kind: 'text', value: commonQuotaResponse }],
    },
  },
};

export function providerFromUrl(value: string | URL): ProviderId | undefined {
  try {
    const origin = value instanceof URL ? value.origin : new URL(value).origin;
    return Object.values(ADAPTERS).find((adapter) => origin === adapter.origin)?.id;
  } catch {
    return undefined;
  }
}

export function providerFromLocation(location: Location): ProviderId | undefined {
  return providerFromUrl(location.href);
}

export function isProviderUrl(value: string | URL | undefined, provider: ProviderId): boolean {
  return value !== undefined && providerFromUrl(value) === provider;
}

export type ProviderPageIdentity =
  | { kind: 'entry' }
  | { kind: 'conversation'; key: string }
  | { kind: 'unsupported' };

function canonicalPath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

export function classifyProviderPage(value: string | URL, provider: ProviderId): ProviderPageIdentity {
  try {
    const url = value instanceof URL ? new URL(value.href) : new URL(value);
    const adapter = ADAPTERS[provider];
    if (url.origin !== adapter.origin) return { kind: 'unsupported' };
    const pathname = canonicalPath(url.pathname);
    if (adapter.entryPathPatterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(pathname);
    })) return { kind: 'entry' };
    return adapter.conversationPathPatterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(pathname);
    })
      ? { kind: 'conversation', key: `${adapter.origin}${pathname}` }
      : { kind: 'unsupported' };
  } catch {
    return { kind: 'unsupported' };
  }
}

export function conversationKeyFromUrl(value: string | URL, provider: ProviderId): string | undefined {
  const identity = classifyProviderPage(value, provider);
  return identity.kind === 'conversation' ? identity.key : undefined;
}

/** Normalize persisted pre-classifier URL keys without requiring a database migration. */
export function normalizeConversationKey(value: string | undefined, provider: ProviderId): string | undefined {
  return value === undefined ? undefined : conversationKeyFromUrl(value, provider);
}

export function conversationKeysMatch(left: string | undefined, right: string | undefined, provider: ProviderId): boolean {
  const normalizedLeft = normalizeConversationKey(left, provider);
  return normalizedLeft !== undefined && normalizedLeft === normalizeConversationKey(right, provider);
}
