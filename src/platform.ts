import type { BackgroundEvent, RuntimeRequest } from './messages';

type ExtensionBrowser = typeof browser & {
  sidePanel?: { open(options: { windowId?: number; tabId?: number }): Promise<void>; setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void> };
  sidebarAction?: { open(): Promise<void> };
  offscreen?: {
    createDocument(options: { url: string; reasons: string[]; justification: string }): Promise<void>;
    closeDocument(): Promise<void>;
  };
  runtime: typeof browser.runtime & {
    getContexts?(filter: { contextTypes: string[]; documentUrls: string[] }): Promise<unknown[]>;
  };
};

const api = browser as ExtensionBrowser;

export interface BrowserPlatform {
  openPanel(windowId?: number): Promise<void>;
  configurePanelAction(): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  downloadText(filename: string, text: string): Promise<number>;
  notify(id: string, title: string, message: string): Promise<void>;
  setBadge(text: string, color: string): Promise<void>;
}

let offscreenReady: Promise<void> | undefined;
const offscreenWaiters = new Map<string, { resolve(value: string): void; reject(reason: Error): void }>();

export function handleOffscreenResponse(message: RuntimeRequest): boolean {
  if (message.type !== 'capture:offscreen-result') return false;
  const waiter = offscreenWaiters.get(message.requestId);
  if (!waiter) return true;
  offscreenWaiters.delete(message.requestId);
  if (message.ok) waiter.resolve(message.text ?? '');
  else waiter.reject(new Error(message.error || 'Offscreen clipboard operation failed'));
  return true;
}

async function ensureOffscreen(): Promise<void> {
  if (!api.offscreen) return;
  if (offscreenReady) {
    await offscreenReady;
    if (!api.runtime.getContexts) return;
    const contexts = await api.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [browser.runtime.getURL('/offscreen.html')],
    });
    if (contexts.length) return;
    offscreenReady = undefined;
  }
  const creation = api.offscreen.createDocument({
    url: '/offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Read and restore research reports copied by the provider pages.',
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!/single offscreen|already exists/i.test(message)) throw error;
  });
  offscreenReady = creation;
  try {
    await creation;
  } catch (error) {
    if (offscreenReady === creation) offscreenReady = undefined;
    throw error;
  }
}

type OffscreenRequest =
  | { type: 'capture:clipboard-read' }
  | { type: 'capture:clipboard-write'; text: string }
  | { type: 'download:blob-create'; text: string }
  | { type: 'download:blob-revoke'; url: string };

async function offscreenRequest(message: OffscreenRequest): Promise<string> {
  await ensureOffscreen();
  const requestId = crypto.randomUUID();
  const result = new Promise<string>((resolve, reject) => {
    offscreenWaiters.set(requestId, { resolve, reject });
    setTimeout(() => {
      if (!offscreenWaiters.delete(requestId)) return;
      reject(new Error('Clipboard operation timed out'));
    }, 3000);
  });
  try {
    await browser.runtime.sendMessage({ ...message, requestId });
  } catch (error) {
    const waiter = offscreenWaiters.get(requestId);
    if (waiter) {
      offscreenWaiters.delete(requestId);
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return result;
}

function execReadClipboard(): string {
  const textarea = document.createElement('textarea');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.append(textarea);
  textarea.focus();
  const ok = document.execCommand('paste');
  const value = textarea.value;
  textarea.remove();
  if (!ok && !value) throw new Error('Clipboard paste was denied');
  return value;
}

function execWriteClipboard(text: string): void {
  const textarea = document.createElement('textarea');
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  textarea.value = text;
  document.body.append(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('Clipboard copy was denied');
}

export function createPlatform(): BrowserPlatform {
  const action = (api.action ?? (api as unknown as { browserAction: typeof api.action }).browserAction);
  return {
    async openPanel(windowId) {
      if (api.sidePanel) await api.sidePanel.open({ windowId });
      else if (api.sidebarAction) await api.sidebarAction.open();
    },
    async configurePanelAction() {
      if (api.sidePanel) await api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    },
    async readClipboard() {
      if (api.offscreen) return offscreenRequest({ type: 'capture:clipboard-read' });
      return execReadClipboard();
    },
    async writeClipboard(text) {
      if (api.offscreen) {
        await offscreenRequest({ type: 'capture:clipboard-write', text });
        return;
      }
      execWriteClipboard(text);
    },
    async downloadText(filename, text) {
      const url = api.offscreen
        ? await offscreenRequest({ type: 'download:blob-create', text })
        : URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      try {
        const downloadId = await browser.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
        const cleanup = () => {
          if (api.offscreen) void offscreenRequest({ type: 'download:blob-revoke', url }).catch(() => undefined);
          else URL.revokeObjectURL(url);
        };
        const listener = (delta: Browser.downloads.DownloadDelta) => {
          if (delta.id !== downloadId || !delta.state?.current) return;
          browser.downloads.onChanged.removeListener(listener);
          cleanup();
        };
        browser.downloads.onChanged.addListener(listener);
        setTimeout(() => {
          browser.downloads.onChanged.removeListener(listener);
          cleanup();
        }, 60_000);
        return downloadId;
      } catch (error) {
        if (api.offscreen) await offscreenRequest({ type: 'download:blob-revoke', url }).catch(() => undefined);
        else URL.revokeObjectURL(url);
        throw error;
      }
    },
    async notify(id, title, message) {
      await browser.notifications.create(id, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title,
        message,
      });
    },
    async setBadge(text, color) {
      await action.setBadgeText({ text });
      if (text) await action.setBadgeBackgroundColor({ color });
    },
  };
}

export async function sendTabEvent(tabId: number, event: BackgroundEvent): Promise<unknown> {
  return browser.tabs.sendMessage(tabId, event);
}

export const platformTestHooks = {
  ensureOffscreen,
  offscreenRequest,
  getOffscreenWaiterCount: () => offscreenWaiters.size,
  resetOffscreenState: () => {
    offscreenReady = undefined;
    offscreenWaiters.clear();
  },
};
