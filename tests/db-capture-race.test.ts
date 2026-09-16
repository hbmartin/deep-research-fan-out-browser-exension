// @vitest-environment node
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { expect, it } from 'vitest';
import { getCapture, putCapture } from '../src/db';

it('does not let a legacy revision read overwrite a concurrently replaced capture', async () => {
  await getCapture('opening');
  const raw = await openDB('deep-research-fan-out', 3);
  const legacy = {
    rawMarkdown: 'Old report', normalizedMarkdown: 'Old report', citations: [],
    captureMethod: 'dom_only' as const, unplacedCitationCount: 0, capturedAt: 1, urlsResolved: 0, urlsUnresolved: 0,
  };
  await raw.put('captures', legacy, 'capture-race');
  const revised = { ...legacy, rawMarkdown: 'Newer report', normalizedMarkdown: 'Newer report', capturedAt: 2 };

  await Promise.all([getCapture('capture-race'), putCapture('capture-race', revised)]);

  const latest = await raw.get('captures', 'capture-race');
  expect(latest).toMatchObject({ rawMarkdown: 'Newer report', revision: expect.any(String) });
  expect(latest?.revision).not.toMatch(/^legacy-1-/);
  raw.close();
});
