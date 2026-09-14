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
let queryTextarea: HTMLTextAreaElement;
let previewsNode: HTMLElement | undefined;
let noticeNode: HTMLElement | undefined;
let historyNode: HTMLElement | undefined;

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
  renderNotice();
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
  if (providerRun.status === 'complete') {
    actions.append(button('Copy', async () => {
      await command({ type: 'provider:copy', runId: run.id, provider });
      setNotice(`${ADAPTERS[provider].label} report copied.`);
    }));
  } else {
    actions.append(button('Copy current', async () => {
      await command({ type: 'provider:copy-current', runId: run.id, provider });
      setNotice(`${ADAPTERS[provider].label} current response copied.`);
    }));
  }
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

function renderPreviews(): void {
  if (!previewsNode) return;
  previewsNode.replaceChildren();
  for (const provider of PROVIDERS.filter((id) => settings.providers[id].enabled)) {
    const value = settings.providers[provider].appendString;
    const line = element('div', 'preview');
    line.append(element('strong', '', ADAPTERS[provider].label), element('span', '', value ? `+ ${value}` : 'No suffix'));
    previewsNode.append(line);
  }
}

function renderNotice(): void {
  if (noticeNode) noticeNode.textContent = notice;
}

function renderHistory(): void {
  const history = historyNode;
  if (!history) return;
  history.replaceChildren(element('h2', '', runs.length ? 'Runs' : 'No runs yet'));
  if (!runs.length) history.append(element('p', 'empty', 'Start a query above or use “dr” in the address bar.'));
  runs.forEach((run, index) => history.append(runCard(run, index)));
  refreshTimers();
}

function renderShell(): void {
  app.replaceChildren();
  const header = element('header');
  const heading = element('div');
  heading.append(element('p', 'eyebrow', 'Research workspace'), element('h1', '', 'Deep Research Fan-Out'));
  const options = button('Options', async () => { await browser.runtime.openOptionsPage(); }, 'ghost');
  header.append(heading, options);

  const launch = element('section', 'launch');
  const label = element('label', '', 'Research query');
  label.htmlFor = 'query';
  queryTextarea = element('textarea') as HTMLTextAreaElement;
  queryTextarea.id = 'query';
  queryTextarea.rows = 6;
  queryTextarea.placeholder = 'What should all configured providers research?';
  previewsNode = element('div', 'previews');
  renderPreviews();
  const runButton = button('Run deep research', async () => {
    const response = await sendRequest({ type: 'run:start', query: queryTextarea.value });
    if (!response.ok) throw new Error(response.error);
    queryTextarea.value = '';
    await reload();
  });
  runButton.classList.add('primary', 'run-button');
  launch.append(label, queryTextarea, element('p', 'hint', 'The provider suffixes below are appended after your query.'), previewsNode, runButton);

  noticeNode = element('p', 'notice', notice);
  noticeNode.id = 'notice';
  noticeNode.setAttribute('role', 'status');
  noticeNode.setAttribute('aria-live', 'polite');
  historyNode = element('section', 'history');
  app.append(header, launch, noticeNode, historyNode);
  renderHistory();
}

async function reload(): Promise<void> {
  const response = await sendRequest({ type: 'runs:list' });
  if (!response.ok) return setNotice(response.error);
  runs = response.runs ?? [];
  renderHistory();
}

browser.runtime.onMessage.addListener((event: BackgroundEvent) => {
  if (event.type !== 'runs:changed') return;
  runs = event.runs;
  if (!settings) return;
  renderHistory();
});

browser.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName !== 'sync') return;
  void loadSettings().then((value) => { settings = value; renderPreviews(); });
});

async function initialize(): Promise<void> {
  settings = await loadSettings();
  renderShell();
  const action = (browser.action ?? (browser as unknown as { browserAction: typeof browser.action }).browserAction);
  await action.setBadgeText({ text: '' });
  await reload();
  window.setInterval(refreshTimers, 1000);
}

void initialize().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
