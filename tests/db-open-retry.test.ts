// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const idb = vi.hoisted(() => ({ openDB: vi.fn() }));

vi.mock('idb', () => ({ openDB: idb.openDB }));

describe('research database open recovery', () => {
  beforeEach(() => {
    vi.resetModules();
    idb.openDB.mockReset();
  });

  it('clears a rejected cached open so a later database call can retry', async () => {
    idb.openDB.mockRejectedValueOnce(new Error('temporary open failure'));
    const database = await import('../src/db');

    await expect(database.getRun('retry-run')).rejects.toThrow('temporary open failure');

    idb.openDB.mockResolvedValueOnce({
      get: vi.fn(async () => undefined),
    });
    await expect(database.getRun('retry-run')).resolves.toBeUndefined();
    expect(idb.openDB).toHaveBeenCalledTimes(2);
  });
});
