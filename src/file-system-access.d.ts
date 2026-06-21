export {}

declare global {
  type FilePickerAcceptType = {
    accept: Record<string, string[]>
    description?: string
  }

  type FileSystemPermissionMode = 'read' | 'readwrite'

  type FileSystemHandlePermissionDescriptor = {
    mode?: FileSystemPermissionMode
  }

  type OpenFilePickerOptions = {
    excludeAcceptAllOption?: boolean
    multiple?: boolean
    types?: FilePickerAcceptType[]
  }

  type SaveFilePickerOptions = {
    excludeAcceptAllOption?: boolean
    id?: string
    suggestedName?: string
    startIn?: FileSystemHandle | string
    types?: FilePickerAcceptType[]
  }

  type DirectoryPickerOptions = {
    id?: string
    mode?: FileSystemPermissionMode
    startIn?: FileSystemHandle | string
  }

  interface FileSystemHandle {
    kind: 'file' | 'directory'
    name: string
    queryPermission?: (
      descriptor?: FileSystemHandlePermissionDescriptor,
    ) => Promise<PermissionState>
    requestPermission?: (
      descriptor?: FileSystemHandlePermissionDescriptor,
    ) => Promise<PermissionState>
  }

  interface FileSystemDirectoryHandle extends FileSystemHandle {
    kind: 'directory'
    resolve?: (possibleDescendant: FileSystemHandle) => Promise<string[] | null>
  }

  interface FileSystemFileHandle extends FileSystemHandle {
    kind: 'file'
    createWritable: () => Promise<FileSystemWritableFileStream>
    getFile: () => Promise<File>
  }

  var showOpenFilePicker:
    | ((options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>)
    | undefined
  var showSaveFilePicker:
    | ((options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>)
    | undefined
  var showDirectoryPicker:
    | ((options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>)
    | undefined}
