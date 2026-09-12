import type { RuntimeRequest, RuntimeResponse } from './messages';

export async function sendContentMessage(message: RuntimeRequest): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage(message) as RuntimeResponse | undefined;
    if (message.type === 'content:capture' && response?.ok === false) throw new Error(response.error);
  } catch (error) {
    if (message.type === 'content:capture') throw error;
  }
}
