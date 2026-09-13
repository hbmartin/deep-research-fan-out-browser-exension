import type { ProviderSnapshot, RuntimeErrorCode, RuntimeRequest, RuntimeResponse } from './messages';

export class ContentMessageError extends Error {
  constructor(message: string, readonly code?: RuntimeErrorCode, readonly providerState?: ProviderSnapshot) {
    super(message);
    this.name = 'ContentMessageError';
  }
}

export async function sendContentMessage(message: RuntimeRequest): Promise<RuntimeResponse | undefined> {
  const requiresAcknowledgement = message.type === 'content:capture' || message.type === 'content:state';
  try {
    const response = await browser.runtime.sendMessage(message) as RuntimeResponse | undefined;
    if (requiresAcknowledgement && response?.ok !== true) {
      const kind = message.type === 'content:capture' ? 'Capture delivery' : 'Provider state update';
      throw new ContentMessageError(response?.error || `${kind} was not acknowledged.`, response?.code, response?.providerState);
    }
    if (requiresAcknowledgement) return response;
  } catch (error) {
    if (requiresAcknowledgement) throw error;
  }
}
