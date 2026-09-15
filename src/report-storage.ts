import {
  deleteReportDirectoryConfig,
  getReportDirectoryConfig,
  putReportDirectoryConfig,
} from './db';
import type { ArtifactSaveFallbackReason, ReportDirectoryConfig } from './types';

const WRITE_PERMISSION = { mode: 'readwrite' } as const;

export function isDirectoryPickerSupported(target: typeof globalThis = globalThis): boolean {
  return typeof (target as typeof globalThis & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export async function queryDirectoryPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  if (!handle || typeof handle.queryPermission !== 'function') return 'denied';
  try { return await handle.queryPermission(WRITE_PERMISSION); }
  catch { return 'denied'; }
}

export async function chooseReportDirectory(target: Window = window): Promise<ReportDirectoryConfig> {
  const handle = await target.showDirectoryPicker({ id: 'deep-research-reports', mode: 'readwrite', startIn: 'documents' });
  const config: ReportDirectoryConfig = {
    handle,
    displayName: handle.name,
    configuredAt: Date.now(),
    needsReconnect: await queryDirectoryPermission(handle) !== 'granted',
  };
  await putReportDirectoryConfig(config);
  return config;
}

export async function reconnectReportDirectory(config: ReportDirectoryConfig): Promise<PermissionState> {
  const permission = typeof config.handle.requestPermission === 'function'
    ? await config.handle.requestPermission(WRITE_PERMISSION)
    : await queryDirectoryPermission(config.handle);
  await putReportDirectoryConfig({ ...config, needsReconnect: permission !== 'granted' });
  return permission;
}

export async function disconnectReportDirectory(): Promise<void> {
  await deleteReportDirectoryConfig();
}

export async function markReportDirectoryNeedsReconnect(config: ReportDirectoryConfig, needsReconnect: boolean): Promise<void> {
  const current = await getReportDirectoryConfig();
  if (!current || current.configuredAt !== config.configuredAt || current.displayName !== config.displayName) return;
  if (current.needsReconnect === needsReconnect) return;
  await putReportDirectoryConfig({ ...current, needsReconnect });
}

export function classifyDirectoryError(error: unknown): ArtifactSaveFallbackReason {
  const name = errorName(error);
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission_required';
  if (name === 'InvalidStateError' || name === 'NotFoundError' || name === 'AbortError') return 'directory_unavailable';
  return 'write_failed';
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error && 'name' in error ? String(error.name) : '';
}

function pathParts(relativeFolder: string): string[] {
  const parts = relativeFolder.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes('\\'))) {
    throw new Error('Invalid report folder path.');
  }
  return parts;
}

export async function createNestedDirectory(
  root: FileSystemDirectoryHandle,
  relativeFolder: string,
): Promise<FileSystemDirectoryHandle> {
  let current = root;
  for (const part of pathParts(relativeFolder)) current = await current.getDirectoryHandle(part, { create: true });
  return current;
}

async function fileExists(directory: FileSystemDirectoryHandle, filename: string): Promise<boolean> {
  try {
    await directory.getFileHandle(filename);
    return true;
  } catch (error) {
    if (errorName(error) === 'NotFoundError') return false;
    throw error;
  }
}

export async function uniqueFilename(directory: FileSystemDirectoryHandle, requestedFilename: string): Promise<string> {
  if (!await fileExists(directory, requestedFilename)) return requestedFilename;
  const match = /^(.*?)(\.[^.]+)?$/.exec(requestedFilename);
  const stem = match?.[1] || requestedFilename;
  const extension = match?.[2] || '';
  for (let index = 1; ; index += 1) {
    const candidate = `${stem} (${index})${extension}`;
    if (!await fileExists(directory, candidate)) return candidate;
  }
}

export async function writeUniqueMarkdown(
  root: FileSystemDirectoryHandle,
  relativeFolder: string,
  requestedFilename: string,
  markdown: string,
): Promise<{ requestedRelativePath: string; actualRelativePath: string }> {
  const directory = await createNestedDirectory(root, relativeFolder);
  const filename = await uniqueFilename(directory, requestedFilename);
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(markdown);
    await writable.close();
  } catch (error) {
    if (typeof writable.abort === 'function') await writable.abort().catch(() => undefined);
    throw error;
  }
  return {
    requestedRelativePath: `${relativeFolder}/${requestedFilename}`,
    actualRelativePath: `${relativeFolder}/${filename}`,
  };
}

export { getReportDirectoryConfig };
