import type { ProviderId } from './types';

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
  entryUrl: string;
  composerKind: 'contenteditable' | 'textarea';
  submitStrategy: 'button' | 'enter';
  citationMarkerStyle: 'numeric_bracket' | 'superscript' | 'markdown_link' | 'none';
  urlResolution: 'none' | 'follow_redirect';
  clarifyingPromptPattern?: RegExp;
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

export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  chatgpt: {
    id: 'chatgpt', label: 'ChatGPT', version: 'chatgpt@0.1.0', origin: 'https://chatgpt.com', entryUrl: 'https://chatgpt.com/',
    composerKind: 'contenteditable', submitStrategy: 'button', citationMarkerStyle: 'markdown_link', urlResolution: 'none',
    clarifyingPromptPattern: /before i begin|clarif(y|ication)|could you specify/i,
    selectors: {
      composer: [{ kind: 'testid', value: 'prompt-textarea' }, { kind: 'css', value: '#prompt-textarea' }, { kind: 'aria', role: 'textbox' }],
      submitButton: [{ kind: 'testid', value: 'send-button' }, { kind: 'aria', role: 'button', name: /send/i }],
      modeEntry: [{ kind: 'aria', role: 'button', name: /tools|choose tools|deep research/i }, { kind: 'text', value: /tools/i }],
      modeOption: [{ kind: 'aria', role: 'menuitem', name: /deep research/i }, { kind: 'text', value: /^deep research$/i }],
      modeConfirmed: [{ kind: 'css', value: '[data-testid="deep-research-pill"]' }, { kind: 'css', value: 'button[aria-pressed="true"][aria-label*="deep research" i]' }, { kind: 'css', value: '[data-state="on"][aria-label*="deep research" i]' }],
      streamingIndicator: [{ kind: 'testid', value: 'stop-button' }, { kind: 'aria', role: 'button', name: /stop generating|stop streaming/i }],
      finalMessageRoot: [{ kind: 'css', value: '[data-message-author-role="assistant"]', pick: 'last' }],
      copyButton: [{ kind: 'aria', role: 'button', name: /copy/i, pick: 'last' }],
      citationAnchors: [{ kind: 'css', value: 'a[href^="http"]' }],
      sourcesPanelToggle: [{ kind: 'aria', role: 'button', name: /sources|citations/i }],
      loginWall: commonLogin,
      quotaNotice: [{ kind: 'text', value: /deep research.*(limit|unavailable)|limit.*deep research/i }],
    },
  },
  claude: {
    id: 'claude', label: 'Claude', version: 'claude@0.1.0', origin: 'https://claude.ai', entryUrl: 'https://claude.ai/new',
    composerKind: 'contenteditable', submitStrategy: 'button', citationMarkerStyle: 'markdown_link', urlResolution: 'none',
    selectors: {
      composer: [{ kind: 'css', value: '[contenteditable="true"][role="textbox"]' }, { kind: 'aria', role: 'textbox' }],
      submitButton: [{ kind: 'aria', role: 'button', name: /send message|send/i }],
      modeEntry: [{ kind: 'aria', role: 'button', name: /research|mode|tools/i }, { kind: 'text', value: /research/i }],
      modeOption: [{ kind: 'aria', role: 'menuitem', name: /research/i }, { kind: 'text', value: /research/i }],
      modeConfirmed: [{ kind: 'css', value: 'button[aria-pressed="true"][aria-label*="research" i]' }, { kind: 'css', value: '[data-state="on"][aria-label*="research" i]' }, { kind: 'css', value: '[data-testid*="research"][aria-pressed="true"]' }],
      streamingIndicator: [{ kind: 'aria', role: 'button', name: /stop response|stop/i }],
      finalMessageRoot: [{ kind: 'css', value: '[data-is-streaming="false"]', pick: 'last' }, { kind: 'css', value: 'div[data-testid="assistant-message"]', pick: 'last' }],
      copyButton: [{ kind: 'aria', role: 'button', name: /copy/i, pick: 'last' }],
      citationAnchors: [{ kind: 'css', value: 'a[href^="http"]' }],
      loginWall: commonLogin,
      quotaNotice: [{ kind: 'text', value: /research.*(limit|unavailable)|usage limit|limit reached/i }],
    },
  },
  gemini: {
    id: 'gemini', label: 'Gemini', version: 'gemini@0.1.0', origin: 'https://gemini.google.com', entryUrl: 'https://gemini.google.com/app',
    composerKind: 'contenteditable', submitStrategy: 'button', citationMarkerStyle: 'superscript', urlResolution: 'follow_redirect',
    selectors: {
      composer: [{ kind: 'css', value: 'rich-textarea [contenteditable="true"]' }, { kind: 'aria', role: 'textbox' }],
      submitButton: [{ kind: 'aria', role: 'button', name: /send message|send/i }],
      modeEntry: [{ kind: 'aria', role: 'button', name: /tools|deep research/i }, { kind: 'text', value: /deep research/i }],
      modeOption: [{ kind: 'aria', role: 'menuitem', name: /deep research/i }, { kind: 'text', value: /^deep research$/i }],
      modeConfirmed: [{ kind: 'css', value: 'button[aria-pressed="true"][aria-label*="deep research" i]' }, { kind: 'css', value: '[data-test-id="deep-research-chip"]' }, { kind: 'css', value: '[data-state="selected"][aria-label*="deep research" i]' }],
      streamingIndicator: [{ kind: 'aria', role: 'button', name: /stop response|stop/i }, { kind: 'text', value: /researching|working on it/i }],
      finalMessageRoot: [{ kind: 'css', value: 'model-response', pick: 'last' }, { kind: 'css', value: '[data-test-id="model-response"]', pick: 'last' }],
      copyButton: [{ kind: 'aria', role: 'button', name: /copy/i, pick: 'last' }],
      citationAnchors: [{ kind: 'css', value: 'a[href^="http"]' }],
      sourcesPanelToggle: [{ kind: 'aria', role: 'button', name: /sources/i }],
      loginWall: commonLogin,
      quotaNotice: [{ kind: 'text', value: /deep research.*(limit|unavailable)|upgrade.*deep research/i }],
      planApproval: [{ kind: 'aria', role: 'button', name: /start research|begin research|approve/i }],
    },
  },
  grok: {
    id: 'grok', label: 'Grok', version: 'grok@0.2.0', origin: 'https://grok.com', entryUrl: 'https://grok.com/',
    composerKind: 'contenteditable', submitStrategy: 'button', citationMarkerStyle: 'markdown_link', urlResolution: 'none',
    selectors: {
      composer: [{ kind: 'css', value: '[contenteditable="true"][role="textbox"]' }, { kind: 'aria', role: 'textbox' }],
      submitButton: [{ kind: 'aria', role: 'button', name: /submit|send/i }],
      modeEntry: [{ kind: 'aria', role: 'button', name: /deepsearch|deep research|mode/i }, { kind: 'text', value: /deepsearch|deep research/i }],
      modeOption: [{ kind: 'aria', role: 'menuitem', name: /deepsearch|deep research/i }, { kind: 'text', value: /deepsearch|deep research/i }],
      modeConfirmed: [{ kind: 'css', value: 'button[aria-pressed="true"][aria-label*="deep" i]' }, { kind: 'css', value: '[data-state="on"][aria-label*="deep" i]' }, { kind: 'css', value: '[data-testid*="deep"][aria-pressed="true"]' }],
      streamingIndicator: [{ kind: 'aria', role: 'button', name: /stop/i }, { kind: 'text', value: /searching|thinking/i }],
      finalMessageRoot: [{ kind: 'css', value: '[data-testid="assistant-message"]', pick: 'last' }, { kind: 'css', value: 'article', pick: 'last' }],
      copyButton: [{ kind: 'aria', role: 'button', name: /^copy response$/i, pick: 'last' }],
      citationAnchors: [{ kind: 'css', value: 'a[href^="http"]' }],
      sourcesPanelToggle: [{ kind: 'aria', role: 'button', name: /^\d+\s+sources$/i, pick: 'last' }],
      loginWall: commonLogin,
      quotaNotice: [{ kind: 'text', value: /(deepsearch|research).*(limit|unavailable)|usage limit/i }],
    },
  },
};

export function providerFromLocation(location: Location): ProviderId | undefined {
  return Object.values(ADAPTERS).find((adapter) => location.origin === adapter.origin)?.id;
}
