import type { RuntimeErrorCode, RuntimeRequest, RuntimeResponse } from './messages';

export class ContentMessageError extends Error {
  constructor(message: string, readonly code?: RuntimeErrorCode) {
    super(message);
    this.name = 'ContentMessageError';
  }
}

export async function sendContentMessage(message: RuntimeRequest): Promise<void> {
  try {
    const response = await browser.runtime.sendMessage(message) as RuntimeResponse | undefined;
    if (message.type === 'content:capture' && response?.ok !== true) {
      throw new ContentMessageError(response?.error || 'Capture delivery was not acknowledged.', response?.code);
    }
  } catch (error) {
    if (message.type === 'content:capture') throw error;
  }
}
