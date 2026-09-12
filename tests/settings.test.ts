import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, importSettings, settingsSchema } from '../src/settings';

describe('settings schema', () => {
  it('accepts the defaults and round-trips exports', () => {
    expect(settingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(importSettings(JSON.stringify(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS);
  });

  it('rejects unsafe folders and oversized suffixes', () => {
    expect(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, downloadRoot: '../escape' })).toThrow();
    const providers = structuredClone(DEFAULT_SETTINGS.providers);
    providers.chatgpt.appendString = 'x'.repeat(4001);
    expect(() => settingsSchema.parse({ ...DEFAULT_SETTINGS, providers })).toThrow();
  });
});
