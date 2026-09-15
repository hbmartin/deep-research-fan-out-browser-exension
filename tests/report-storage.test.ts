// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  classifyDirectoryError,
  createNestedDirectory,
  isDirectoryPickerSupported,
  queryDirectoryPermission,
  uniqueFilename,
  writeUniqueMarkdown,
} from '../src/report-storage';

function notFound(): Error {
  return Object.assign(new Error('Not found'), { name: 'NotFoundError' });
}

class MemoryDirectory {
  readonly directories = new Map<string, MemoryDirectory>();
  readonly files = new Map<string, string>();
  closeCount = 0;

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle> {
    let directory = this.directories.get(name);
    if (!directory && options?.create) {
      directory = new MemoryDirectory();
      this.directories.set(name, directory);
    }
    if (!directory) throw notFound();
    return directory as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle> {
    if (!this.files.has(name) && !options?.create) throw notFound();
    if (options?.create && !this.files.has(name)) this.files.set(name, '');
    const directory = this;
    let pending = this.files.get(name) ?? '';
    return {
      name,
      kind: 'file',
      async createWritable() {
        return {
          async write(value: FileSystemWriteChunkType) { pending = String(value); },
          async close() { directory.files.set(name, pending); directory.closeCount += 1; },
          async abort() { return undefined; },
        } as FileSystemWritableFileStream;
      },
    } as FileSystemFileHandle;
  }
}

describe('chosen-folder report storage', () => {
  it('feature-detects the picker without assuming Firefox support', () => {
    expect(isDirectoryPickerSupported({} as typeof globalThis)).toBe(false);
    expect(isDirectoryPickerSupported({ showDirectoryPicker: () => undefined } as unknown as typeof globalThis)).toBe(true);
  });

  it('queries write permission without requesting it', async () => {
    const queryPermission = vi.fn(async () => 'granted' as PermissionState);
    const requestPermission = vi.fn(async () => 'granted' as PermissionState);
    const handle = { queryPermission, requestPermission } as unknown as FileSystemDirectoryHandle;
    await expect(queryDirectoryPermission(handle)).resolves.toBe('granted');
    expect(queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('creates nested directories, numbers collisions, writes, and closes the stream', async () => {
    const root = new MemoryDirectory();
    const runDirectory = await createNestedDirectory(root as unknown as FileSystemDirectoryHandle, 'year/run-folder') as unknown as MemoryDirectory;
    runDirectory.files.set('chatgpt.md', 'first');
    runDirectory.files.set('chatgpt (1).md', 'second');

    expect(await uniqueFilename(runDirectory as unknown as FileSystemDirectoryHandle, 'chatgpt.md')).toBe('chatgpt (2).md');
    await expect(writeUniqueMarkdown(root as unknown as FileSystemDirectoryHandle, 'year/run-folder', 'chatgpt.md', '# report')).resolves.toEqual({
      requestedRelativePath: 'year/run-folder/chatgpt.md',
      actualRelativePath: 'year/run-folder/chatgpt (2).md',
    });
    expect(runDirectory.files.get('chatgpt (2).md')).toBe('# report');
    expect(runDirectory.closeCount).toBe(1);
  });

  it('classifies permission, missing-handle, and general write failures', () => {
    expect(classifyDirectoryError(Object.assign(new Error(), { name: 'NotAllowedError' }))).toBe('permission_required');
    expect(classifyDirectoryError(Object.assign(new Error(), { name: 'InvalidStateError' }))).toBe('directory_unavailable');
    expect(classifyDirectoryError(new Error('disk full'))).toBe('write_failed');
  });
});
