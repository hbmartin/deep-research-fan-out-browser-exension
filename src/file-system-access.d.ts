interface DeepResearchFileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission(descriptor?: DeepResearchFileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: DeepResearchFileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface DeepResearchDirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
}

interface Window {
  showDirectoryPicker(options?: DeepResearchDirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
