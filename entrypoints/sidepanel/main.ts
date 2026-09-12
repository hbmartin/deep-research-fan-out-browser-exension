import './style.css';
import { ADAPTERS } from '@/src/adapters';
import type { BackgroundEvent } from '@/src/messages';
import { sendRequest } from '@/src/messages';
import { loadSettings, type Settings } from '@/src/settings';
import { isTerminalProviderStatus, PROVIDERS, type ProviderId, type Run } from '@/src/types';

const app = document.querySelector<HTMLElement>('#app')!;
let runs: Run[] = [];
let settings: Settings;
let notice = '';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, action: () => Promise<void>, kind = ''): HTMLButtonElement {
  const node = element('button', kind, label);
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try { await action(); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { node.disabled = false; }
  });
  return node;
}

function setNotice(message: string): void {
  notice = message;
  const live = document.querySelector<HTMLElement>('#notice');
  if (live) live.textContent = notice;
}

function elapsed(start?: number, end?: number): string {
  if (!start) return '—';
  const seconds = Math.max(0, Math.round(((end || Date.now()) - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function refreshTimers(): void {
  document.querySelectorAll<HTMLElement>('[data-start]').forEach((node) => {
    const start = Number(node.dataset.start);
    const end = node.dataset.end ? Number(node.dataset.end) : undefined;
    node.textContent = elapsed(start, end);
  });
}

async function command(request: Parameters<typeof sendRequest>[0]): Promise<void> {
  const response = await sendRequest(request);
  if (!response.ok) throw new Error(response.error);
  if (response.runs) runs = response.runs;
  await reload();
}

function providerRow(run: Run, provider: ProviderId): HTMLElement {
  const providerRun = run.providerRuns[provider]!;
  const row = element('li', 'provider-row');
  const summary = element('div', 'provider-summary');
  const name = element('strong', '', ADAPTERS[provider].label);
  const status = element('span', `status status-${providerRun.status}`, providerRun.status.replaceAll('_', ' '));
  const timer = element('span', 'elapsed');
  timer.dataset.start = String(providerRun.startedAt || run.createdAt);
  if (providerRun.completedAt) timer.dataset.end = String(providerRun.completedAt);
  summary.append(name, status, timer);
  row.append(summary);
  if (providerRun.statusDetail) row.append(element('p', 'detail', providerRun.statusDetail));
  if (providerRun.degraded) row.append(element('p', 'warning', 'Captured or launched through a degraded fallback.'));
  const actions = element('div', 'actions');
  actions.append(button('Open', () => command({ type: 'provider:focus', runId: run.id, provider }), 'secondary'));
  if (providerRun.status === 'complete') actions.append(button('Copy', () => command({ type: 'provider:copy', runId: run.id, provider })));
  if (isTerminalProviderStatus(providerRun.status)) actions.append(button('Download again', () => command({ type: 'provider:download', runId: run.id, provider }), 'secondary'));
  else actions.append(button('End provider', () => command({ type: 'provider:end', runId: run.id, provider }), 'danger'));
  row.append(actions);
  return row;
}

function runCard(run: Run, index: number): HTMLElement {
  const details = element('details', 'run-card');
  details.open = index < 2 || run.status !== 'complete';
  const summary = element('summary');
  const text = element('div');
  text.append(element('strong', '', run.query), element('span', 'run-meta', `${run.status.replaceAll('_', ' ')} · ${new Date(run.createdAt).toLocaleString()}`));
  summary.append(text);
  details.append(summary);
  const list = element('ul', 'providers');
  for (const provider of PROVIDERS) if (run.providerRuns[provider]) list.append(providerRow(run, provider));
  details.append(list);
  const actions = element('div', 'run-actions');
  if (run.status === 'complete') actions.append(button('Re-run query', () => command({ type: 'run:rerun', runId: run.id })));
  else actions.append(button('End run', () => command({ type: 'run:end', runId: run.id }), 'danger'));
  details.append(actions);
  return details;
}

function render(): void {
  app.replaceChildren();
  const header = element('header');
  const heading = element('div');
  heading.append(element('p', 'eyebrow', 'Research workspace'), element('h1', '', 'Deep Research Fan-Out'));
  const options = button('Options', async () => { await browser.runtime.openOptionsPage(); }, 'ghost');
  header.append(heading, options);

  const launch = element('section', 'launch');
  const label = element('label', '', 'Research query');
  label.htmlFor = 'query';
  const textarea = element('textarea') as HTMLTextAreaElement;
  textarea.id = 'query';
  textarea.rows = 6;
  textarea.placeholder = 'What should all configured providers research?';
  const previews = element('div', 'previews');
  const renderPreviews = () => {
    previews.replaceChildren();
    for (const provider of PROVIDERS.filter((id) => settings.providers[id].enabled)) {
      const value = settings.providers[provider].appendString;
      const line = element('div', 'preview');
      line.append(element('strong', '', ADAPTERS[provider].label), element('span', '', value ? `+ ${value}` : 'No suffix'));
      previews.append(line);
    }
  };
  renderPreviews();
  const runButton = button('Run deep research', async () => {
    const response = await sendRequest({ type: 'run:start', query: textarea.value });
    if (!response.ok) throw new Error(response.error);
    textarea.value = '';
    await reload();
  });
  runButton.classList.add('primary', 'run-button');
  launch.append(label, textarea, element('p', 'hint', 'The provider suffixes below are appended after your query.'), previews, runButton);

  const noticeNode = element('p', 'notice', notice);
  noticeNode.id = 'notice';
  noticeNode.setAttribute('role', 'status');
  noticeNode.setAttribute('aria-live', 'polite');
  const history = element('section', 'history');
  history.append(element('h2', '', runs.length ? 'Runs' : 'No runs yet'));
  if (!runs.length) history.append(element('p', 'empty', 'Start a query above or use “dr” in the address bar.'));
  runs.forEach((run, index) => history.append(runCard(run, index)));
  app.append(header, launch, noticeNode, history);
  refreshTimers();
}

async function reload(): Promise<void> {
  const response = await sendRequest({ type: 'runs:list' });
  if (!response.ok) return setNotice(response.error);
  runs = response.runs ?? [];
  render();
}

browser.runtime.onMessage.addListener((event: BackgroundEvent) => {
  if (event.type !== 'runs:changed') return;
  runs = event.runs;
  if (!settings) return;
  render();
});

browser.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== 'sync') return;
  void loadSettings().then((value) => { settings = value; render(); });
});

async function initialize(): Promise<void> {
  settings = await loadSettings();
  const action = (browser.action ?? (browser as unknown as { browserAction: typeof browser.action }).browserAction);
  await action.setBadgeText({ text: '' });
  await reload();
  window.setInterval(refreshTimers, 1000);
}

void initialize().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
