import { readFile } from 'node:fs/promises';

const chrome = JSON.parse(await readFile('.output/chrome-mv3/manifest.json', 'utf8'));
const firefox = JSON.parse(await readFile('.output/firefox-mv2/manifest.json', 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const origins = [
  'https://chatgpt.com/*',
  'https://claude.ai/*',
  'https://gemini.google.com/*',
  'https://grok.com/*',
  'https://vertexaisearch.cloud.google.com/*',
];

assert(chrome.manifest_version === 3, 'Chrome must use Manifest V3.');
assert(chrome.minimum_chrome_version === '145', 'Chrome minimum version must be 145.');
assert(chrome.background?.service_worker === 'background.js', 'Chrome background must be a service worker.');
assert(chrome.side_panel?.default_path === 'sidepanel.html', 'Chrome side panel is missing.');
for (const permission of ['offscreen', 'sidePanel', 'scripting', 'tabGroups', 'unlimitedStorage']) {
  assert(chrome.permissions.includes(permission), `Chrome permission missing: ${permission}`);
}
for (const origin of origins) assert(chrome.host_permissions.includes(origin), `Chrome origin missing: ${origin}`);

assert(firefox.manifest_version === 2, 'Firefox must use Manifest V2.');
assert(firefox.background?.scripts?.includes('background.js'), 'Firefox background page is missing.');
assert(firefox.sidebar_action?.default_panel === 'sidepanel.html', 'Firefox sidebar is missing.');
assert(firefox.browser_specific_settings?.gecko?.strict_min_version === '142.0', 'Firefox minimum version must be 142.');
assert(firefox.browser_specific_settings?.gecko?.data_collection_permissions?.required?.includes('none'), 'Firefox no-data-collection declaration is missing.');
assert(!firefox.permissions.includes('offscreen') && !firefox.permissions.includes('sidePanel'), 'Firefox contains Chrome-only permissions.');
assert(firefox.permissions.includes('tabGroups'), 'Firefox tabGroups permission is missing.');
for (const origin of origins) assert(firefox.permissions.includes(origin), `Firefox origin missing: ${origin}`);

for (const manifest of [chrome, firefox]) {
  assert(manifest.omnibox?.keyword === 'dr', 'Omnibox keyword must be dr.');
  assert(!JSON.stringify(manifest).includes('<all_urls>'), 'Broad host access is forbidden.');
  assert(manifest.content_scripts?.[0]?.matches?.length === 4, 'Exactly four provider origins must receive content scripts.');
}

console.log('Chrome and Firefox manifests satisfy release invariants.');
