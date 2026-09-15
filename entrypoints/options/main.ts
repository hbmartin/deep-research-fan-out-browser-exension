import './style.css';
import { ADAPTERS } from '@/src/adapters';
import {
  chooseReportDirectory,
  disconnectReportDirectory,
  getReportDirectoryConfig,
  isDirectoryPickerSupported,
  queryDirectoryPermission,
  reconnectReportDirectory,
} from '@/src/report-storage';
import { importSettings, loadSettings, saveSettings, type Settings } from '@/src/settings';
import { PROVIDERS, type ProviderId, type ReportDirectoryConfig } from '@/src/types';

const app = document.querySelector<HTMLElement>('#app')!;
let settings: Settings;
let directoryConfig: ReportDirectoryConfig | undefined;
let directoryPermission: PermissionState | undefined;
let destinationMessage = '';
let destinationActionRunning = false;

function field<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function render(): void {
  app.replaceChildren();
  const title = field('h1'); title.textContent = 'Deep Research Fan-Out';
  const intro = field('p', { class: 'intro' }); intro.textContent = 'Configure what each provider receives. Settings sync within this browser profile; the selected report folder stays local and is never exported.';
  const form = field('form');

  form.append(destinationSection());

  const providersHeading = field('h2'); providersHeading.textContent = 'Providers';
  form.append(providersHeading);
  for (const provider of PROVIDERS) form.append(providerSection(provider));

  const behaviorHeading = field('h2'); behaviorHeading.textContent = 'Behavior';
  form.append(behaviorHeading);
  form.append(checkRow('gemini-auto', 'Automatically approve Gemini research plans', settings.geminiAutoApprove, (checked) => { settings.geminiAutoApprove = checked; }));
  form.append(checkRow('clipboard-restore', 'Restore the clipboard after capture when it is safe', settings.restoreClipboard, (checked) => { settings.restoreClipboard = checked; }));
  form.append(checkRow('source-snippets', 'Include source snippets in Markdown', settings.includeSourceSnippets, (checked) => { settings.includeSourceSnippets = checked; }));
  const folderLabel = field('label', { for: 'download-root' }); folderLabel.textContent = 'Downloads fallback subfolder';
  const folder = field('input', { id: 'download-root', type: 'text', maxlength: '80', value: settings.downloadRoot });
  folder.addEventListener('input', () => { settings.downloadRoot = folder.value; });
  form.append(folderLabel, folder);

  const save = field('button', { type: 'submit' }); save.textContent = 'Save settings';
  const status = field('span', { id: 'save-status', role: 'status', 'aria-live': 'polite' });
  form.append(field('div', { class: 'save-row' }));
  form.lastElementChild!.append(save, status);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await saveSettings(settings); status.textContent = 'Saved.'; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  });

  const transfer = field('section', { class: 'transfer' });
  const transferHeading = field('h2'); transferHeading.textContent = 'Export or import';
  const transferHelp = field('p'); transferHelp.textContent = 'Export settings as JSON, or paste a complete export and import it.';
  const json = field('textarea', { id: 'settings-json', rows: '10', 'aria-label': 'Settings JSON' });
  const exportButton = field('button', { type: 'button' }); exportButton.textContent = 'Export';
  exportButton.addEventListener('click', async () => {
    json.value = JSON.stringify(settings, null, 2);
    json.select();
    await navigator.clipboard.writeText(json.value).catch(() => undefined);
  });
  const importButton = field('button', { type: 'button', class: 'secondary' }); importButton.textContent = 'Import';
  importButton.addEventListener('click', async () => {
    try {
      settings = importSettings(json.value);
      await saveSettings(settings);
      render();
    } catch (error) { json.setCustomValidity(error instanceof Error ? error.message : String(error)); json.reportValidity(); }
  });
  const transferActions = field('div', { class: 'actions' }); transferActions.append(exportButton, importButton);
  transfer.append(transferHeading, transferHelp, json, transferActions);
  app.append(title, intro, form, transfer);
}

function destinationSection(): HTMLElement {
  const section = field('section', { class: 'destination' });
  const heading = field('h2'); heading.textContent = 'Report destination';
  const help = field('p', { class: 'destination-help' });
  help.textContent = 'A connected folder is used when permission remains granted. Otherwise reports save automatically through Downloads.';
  section.append(heading, help);

  if (!isDirectoryPickerSupported(window)) {
    section.append(destinationState('Downloads', 'Folder selection is unavailable in this browser.'));
    return section;
  }

  if (!directoryConfig) {
    section.append(destinationState('Downloads', 'No local folder is connected.'));
    section.append(destinationButton('Connect', async () => {
      try {
        await chooseReportDirectory(window);
        destinationMessage = 'Folder connected.';
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') destinationMessage = 'Folder selection canceled.';
        else throw error;
      }
      await refreshDestinationState();
    }));
  } else {
    const granted = directoryPermission === 'granted';
    const detail = granted && !directoryConfig.needsReconnect
      ? `Connected ${new Date(directoryConfig.configuredAt).toLocaleString()}`
      : `Permission is ${directoryPermission ?? 'unavailable'}; Downloads fallback is active.`;
    section.append(destinationState(directoryConfig.displayName, detail, granted && !directoryConfig.needsReconnect ? 'connected' : 'warning'));
    const actions = field('div', { class: 'actions destination-actions' });
    if (!granted || directoryConfig.needsReconnect) {
      actions.append(destinationButton('Reconnect', async () => {
        const permission = await reconnectReportDirectory(directoryConfig!);
        destinationMessage = permission === 'granted' ? 'Folder reconnected.' : 'Folder permission was not granted.';
        await refreshDestinationState();
      }, 'secondary'));
    }
    actions.append(destinationButton('Change', async () => {
      try {
        await chooseReportDirectory(window);
        destinationMessage = 'Report folder changed.';
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') destinationMessage = 'Folder selection canceled.';
        else throw error;
      }
      await refreshDestinationState();
    }, 'secondary'));
    actions.append(destinationButton('Disconnect', async () => {
      await disconnectReportDirectory();
      destinationMessage = 'Folder disconnected. Downloads is now active.';
      await refreshDestinationState();
    }, 'danger'));
    section.append(actions);
  }
  if (destinationMessage) section.append(destinationStateMessage(destinationMessage));
  return section;
}

function destinationState(name: string, detail: string, className = ''): HTMLElement {
  const state = field('div', { class: `destination-state ${className}`.trim() });
  const nameNode = field('strong'); nameNode.textContent = name;
  const detailNode = field('span'); detailNode.textContent = detail;
  state.append(nameNode, detailNode);
  return state;
}

function destinationStateMessage(message: string): HTMLElement {
  const status = field('p', { class: 'destination-message', role: 'status', 'aria-live': 'polite' });
  status.textContent = message;
  return status;
}

function destinationButton(label: string, action: () => Promise<void>, className = ''): HTMLButtonElement {
  const button = field('button', { type: 'button', ...(className ? { class: className } : {}) });
  button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true;
    destinationActionRunning = true;
    try { await action(); }
    catch (error) {
      destinationMessage = error instanceof Error ? error.message : String(error);
      await refreshDestinationState();
    } finally {
      destinationActionRunning = false;
      button.disabled = false;
    }
  });
  return button;
}

async function refreshDestinationState(): Promise<void> {
  directoryConfig = await getReportDirectoryConfig().catch(() => undefined);
  directoryPermission = directoryConfig ? await queryDirectoryPermission(directoryConfig.handle) : undefined;
  render();
}

function providerSection(provider: ProviderId): HTMLElement {
  const section = field('section', { class: 'provider' });
  const heading = field('div', { class: 'provider-heading' });
  const label = field('label', { class: 'check' });
  const enabled = field('input', { type: 'checkbox' }); enabled.checked = settings.providers[provider].enabled;
  enabled.addEventListener('change', () => { settings.providers[provider].enabled = enabled.checked; });
  const name = field('strong'); name.textContent = ADAPTERS[provider].label;
  label.append(enabled, name); heading.append(label); section.append(heading);
  const suffixLabel = field('label', { for: `append-${provider}` }); suffixLabel.textContent = 'Append string';
  const suffix = field('textarea', { id: `append-${provider}`, rows: '3', maxlength: '4000', placeholder: 'Optional instructions appended on a new line' });
  suffix.value = settings.providers[provider].appendString;
  suffix.addEventListener('input', () => { settings.providers[provider].appendString = suffix.value; });
  const advanced = field('details');
  const summary = field('summary'); summary.textContent = 'Advanced';
  const debounceLabel = field('label', { for: `debounce-${provider}` }); debounceLabel.textContent = 'Completion debounce (milliseconds)';
  const debounce = field('input', { id: `debounce-${provider}`, type: 'number', min: '3000', max: '60000', step: '500', required: '', value: String(settings.providers[provider].completionDebounceMs) });
  debounce.addEventListener('input', () => {
    const value = debounce.valueAsNumber;
    if (!debounce.validity.valid || !Number.isInteger(value)) return;
    settings.providers[provider].completionDebounceMs = value;
  });
  advanced.append(summary, debounceLabel, debounce);
  section.append(suffixLabel, suffix, advanced);
  return section;
}

function checkRow(id: string, text: string, checked: boolean, update: (checked: boolean) => void): HTMLElement {
  const label = field('label', { for: id, class: 'check behavior-check' });
  const input = field('input', { id, type: 'checkbox' }); input.checked = checked;
  input.addEventListener('change', () => update(input.checked));
  const span = field('span'); span.textContent = text;
  label.append(input, span);
  return label;
}

void Promise.all([loadSettings(), getReportDirectoryConfig().catch(() => undefined)]).then(async ([value, config]) => {
  settings = value;
  directoryConfig = config;
  directoryPermission = config ? await queryDirectoryPermission(config.handle) : undefined;
  render();
});

window.addEventListener('focus', () => {
  if (settings && !destinationActionRunning && isDirectoryPickerSupported(window)) void refreshDestinationState();
});
