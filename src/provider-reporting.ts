import { ContentMessageError, sendContentMessage } from './content-messaging';
import type { RuntimeRequest, RuntimeResponse } from './messages';

type StateRequest = Extract<RuntimeRequest, { type: 'content:state' }>;
interface Pending {
  request: StateRequest;
  key: string;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

/** One serialized, cancellable reporting queue per content run. */
export class ProviderReporter {
  private queue: Pending[] = [];
  private running = false;
  private stopped = false;
  private wakeRetry?: () => void;
  private idleWaiters: Array<() => void> = [];
  private rejected = new Map<string, unknown>();

  constructor(
    private readonly acknowledged: (request: StateRequest, response: RuntimeResponse | undefined) => void,
    private readonly rejectedReport: (error: ContentMessageError) => void,
  ) {}

  get pending(): boolean { return this.queue.length > 0; }

  report(request: StateRequest): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Provider reporting stopped.'));
    const key = JSON.stringify([request.status, request.detail, request.reason]);
    if (this.rejected.has(key)) return Promise.reject(this.rejected.get(key));
    const existing = this.queue.find((item) => item.key === key);
    if (existing) return existing.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.queue.push({ request, key, promise, resolve, reject });
    void this.drain();
    return promise;
  }

  idle(): Promise<void> {
    return this.pending ? new Promise((resolve) => this.idleWaiters.push(resolve)) : Promise.resolve();
  }

  cancel(): void {
    this.stopped = true;
    this.wakeRetry?.();
    for (const item of this.queue.splice(0)) item.reject(new Error('Provider reporting stopped.'));
    this.finishIdle();
  }

  private finishIdle(): void {
    if (!this.pending) for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.stopped && this.queue.length) {
        const item = this.queue[0]!;
        let failures = 0;
        while (!this.stopped) {
          try {
            const response = await sendContentMessage(item.request);
            if (this.stopped) break;
            this.rejected.clear();
            item.resolve();
            this.acknowledged(item.request, response);
            break;
          } catch (error) {
            if (this.stopped) break;
            if (error instanceof ContentMessageError && error.code) {
              this.rejected.set(item.key, error);
              item.reject(error);
              this.rejectedReport(error);
              break;
            }
            const backoff = Math.min(60_000, 1000 * 2 ** Math.min(failures++, 6));
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => { this.wakeRetry = undefined; resolve(); }, backoff);
              this.wakeRetry = () => { clearTimeout(timer); this.wakeRetry = undefined; resolve(); };
            });
          }
        }
        if (this.queue[0] === item) this.queue.shift();
      }
    } finally {
      this.running = false;
      this.finishIdle();
    }
  }
}
