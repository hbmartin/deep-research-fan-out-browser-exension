import type { RuntimeErrorCode, RuntimeRequest, RuntimeResponse } from './messages';

export class ContentMessageError extends Error {
  constructor(message: string, readonly code?: RuntimeErrorCode) {
    super(message);
    this.name = 'ContentMessageError';
  }
}

export async function sendContentMessage(message: RuntimeRequest): Promise<void> {
  const requiresAcknowledgement = message.type === 'content:capture' || message.type === 'content:state';
  try {
    const response = await browser.runtime.sendMessage(message) as RuntimeResponse | undefined;
    if (requiresAcknowledgement && response?.ok !== true) {
      const kind = message.type === 'content:capture' ? 'Capture delivery' : 'Provider state update';
      throw new ContentMessageError(response?.error || `${kind} was not acknowledged.`, response?.code);
    }
  } catch (error) {
    if (requiresAcknowledgement) throw error;
  }
}
