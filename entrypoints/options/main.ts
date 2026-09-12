import './style.css';
import { ADAPTERS } from '@/src/adapters';
import { importSettings, loadSettings, saveSettings, type Settings } from '@/src/settings';
import { PROVIDERS, type ProviderId } from '@/src/types';

const app = document.querySelector<HTMLElement>('#app')!;
let settings: Settings;

function field<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function render(): void {
  app.replaceChildren();
  const title = field('h1'); title.textContent = 'Deep Research Fan-Out';
  const intro = field('p', { class: 'intro' }); intro.textContent = 'Configure what each provider receives. Settings sync within this browser profile; export/import bridges browsers.';
  const form = field('form');

  const providersHeading = field('h2'); providersHeading.textContent = 'Providers';
  form.append(providersHeading);
  for (const provider of PROVIDERS) form.append(providerSection(provider));

  const behaviorHeading = field('h2'); behaviorHeading.textContent = 'Behavior';
  form.append(behaviorHeading);
  form.append(checkRow('gemini-auto', 'Automatically approve Gemini research plans', settings.geminiAutoApprove, (checked) => { settings.geminiAutoApprove = checked; }));
  form.append(checkRow('clipboard-restore', 'Restore the clipboard after capture when it is safe', settings.restoreClipboard, (checked) => { settings.restoreClipboard = checked; }));
  const folderLabel = field('label', { for: 'download-root' }); folderLabel.textContent = 'Download subfolder';
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
  const debounce = field('input', { id: `debounce-${provider}`, type: 'number', min: '3000', max: '60000', step: '500', value: String(settings.providers[provider].completionDebounceMs) });
  debounce.addEventListener('input', () => { settings.providers[provider].completionDebounceMs = Number(debounce.value); });
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

void loadSettings().then((value) => { settings = value; render(); });
