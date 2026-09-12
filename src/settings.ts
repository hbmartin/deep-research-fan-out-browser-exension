import { z } from 'zod';
import { PROVIDERS, type ProviderId } from './types';

const providerSettingSchema = z.object({
  enabled: z.boolean(),
  appendString: z.string().max(4000),
  completionDebounceMs: z.number().int().min(3000).max(60000),
});

export const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  providers: z.object({
    chatgpt: providerSettingSchema,
    claude: providerSettingSchema,
    gemini: providerSettingSchema,
    grok: providerSettingSchema,
  }),
  geminiAutoApprove: z.boolean(),
  downloadRoot: z
    .string()
    .min(1)
    .max(80)
    .refine((value) => !value.includes('..') && !/[\\/]/.test(value), 'Use one folder name'),
  restoreClipboard: z.boolean(),
});

export type Settings = z.infer<typeof settingsSchema>;

const debounceDefaults: Record<ProviderId, number> = {
  chatgpt: 10_000,
  claude: 8_000,
  gemini: 10_000,
  grok: 8_000,
};

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  providers: Object.fromEntries(
    PROVIDERS.map((provider) => [
      provider,
      { enabled: true, appendString: '', completionDebounceMs: debounceDefaults[provider] },
    ]),
  ) as Settings['providers'],
  geminiAutoApprove: true,
  downloadRoot: 'deep-research',
  restoreClipboard: true,
};

const GENERAL_KEY = 'settings.general.v1';
const providerKey = (provider: ProviderId) => `settings.provider.${provider}.v1`;

export async function loadSettings(): Promise<Settings> {
  const keys = [GENERAL_KEY, ...PROVIDERS.map(providerKey)];
  const stored = await browser.storage.sync.get(keys);
  const candidate = {
    ...DEFAULT_SETTINGS,
    ...(stored[GENERAL_KEY] ?? {}),
    providers: Object.fromEntries(
      PROVIDERS.map((provider) => [
        provider,
        { ...DEFAULT_SETTINGS.providers[provider], ...(stored[providerKey(provider)] ?? {}) },
      ]),
    ),
  };
  const parsed = settingsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
}

export async function saveSettings(settings: Settings): Promise<void> {
  const parsed = settingsSchema.parse(settings);
  await browser.storage.sync.set({
    [GENERAL_KEY]: {
      schemaVersion: 1,
      geminiAutoApprove: parsed.geminiAutoApprove,
      downloadRoot: parsed.downloadRoot,
      restoreClipboard: parsed.restoreClipboard,
    },
    ...Object.fromEntries(PROVIDERS.map((provider) => [providerKey(provider), parsed.providers[provider]])),
  });
}

export function importSettings(json: string): Settings {
  return settingsSchema.parse(JSON.parse(json));
}
