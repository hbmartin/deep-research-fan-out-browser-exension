import { defineConfig } from 'wxt';

const providerOrigins = [
  'https://chatgpt.com/*',
  'https://claude.ai/*',
  'https://gemini.google.com/*',
  'https://grok.com/*',
];

export default defineConfig({
  manifest: ({ browser }) => ({
    name: 'Deep Research Fan-Out',
    description:
      'Run and capture deep research across ChatGPT, Claude, Gemini, and Grok.',
    minimum_chrome_version: browser === 'chrome' ? '116' : undefined,
    permissions: [
      'tabs',
      'tabGroups',
      'storage',
      'alarms',
      'notifications',
      'downloads',
      'clipboardRead',
      'clipboardWrite',
      'unlimitedStorage',
      ...(browser === 'chrome' ? ['offscreen', 'sidePanel', 'scripting'] : []),
    ],
    host_permissions: [
      ...providerOrigins,
      'https://vertexaisearch.cloud.google.com/*',
    ],
    omnibox: { keyword: 'dr' },
    action: {
      default_title: 'Open Deep Research Fan-Out',
      default_icon: {
        '16': 'icon/16.png',
        '32': 'icon/32.png',
        '48': 'icon/48.png',
        '128': 'icon/128.png',
      },
    },
    icons: {
      '16': 'icon/16.png',
      '32': 'icon/32.png',
      '48': 'icon/48.png',
      '128': 'icon/128.png',
    },
    browser_specific_settings:
      browser === 'firefox'
        ? {
            gecko: {
              id: 'deep-research-fan-out@harold.internal',
              strict_min_version: '142.0',
              data_collection_permissions: { required: ['none'] },
            },
          }
        : undefined,
  }),
});
