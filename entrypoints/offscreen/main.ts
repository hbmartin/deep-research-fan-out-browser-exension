import type { RuntimeRequest } from '@/src/messages';

function textarea(): HTMLTextAreaElement {
  return document.querySelector<HTMLTextAreaElement>('#clipboard')!;
}

function read(): string {
  const element = textarea();
  element.value = '';
  element.focus();
  const ok = document.execCommand('paste');
  if (!ok && !element.value) throw new Error('Clipboard paste was denied.');
  return element.value;
}

function write(text: string): void {
  const element = textarea();
  element.value = text;
  element.focus();
  element.select();
  if (!document.execCommand('copy')) throw new Error('Clipboard copy was denied.');
}

browser.runtime.onMessage.addListener((message: RuntimeRequest) => {
  if (message.type !== 'capture:clipboard-read' && message.type !== 'capture:clipboard-write' && message.type !== 'download:blob-create' && message.type !== 'download:blob-revoke') return;
  try {
    if (message.type === 'capture:clipboard-write') write(message.text);
    if (message.type === 'download:blob-revoke') URL.revokeObjectURL(message.url);
    const text = message.type === 'capture:clipboard-read'
      ? read()
      : message.type === 'download:blob-create'
        ? URL.createObjectURL(new Blob([message.text], { type: 'text/markdown;charset=utf-8' }))
        : '';
    void browser.runtime.sendMessage({ type: 'capture:offscreen-result', requestId: message.requestId, ok: true, text });
  } catch (error) {
    void browser.runtime.sendMessage({ type: 'capture:offscreen-result', requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
