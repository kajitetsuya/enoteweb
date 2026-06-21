// Shared defaults for every flow that names an encrypted text file through a
// native save picker or a browser download (SPEC §10 platform export flow).
// Neutral module: imported by App and the local-file/Dropbox providers.

export const DEFAULT_EXPORT_FILE_NAME = 'enote.txt'
export const LOCAL_CONFLICT_EXPORT_FILE_NAME = 'enote-local-conflict.txt'
export const REMOTE_CONFLICT_EXPORT_FILE_NAME = 'enote-remote.txt'

// SPEC §7: `.txt` and `.text` are the supported encrypted file extensions.
export const ENCRYPTED_TEXT_FILE_TYPES: FilePickerAcceptType[] = [
  {
    description: 'Encrypted text files',
    accept: {
      'text/plain': ['.txt', '.text'],
    },
  },
]

export const isEncryptedTextFileName = (name: string) => {
  const lowered = name.toLowerCase()
  return lowered.endsWith('.txt') || lowered.endsWith('.text')
}

// Post-picker guard message, kept beside the extension policy it describes so
// the two cannot drift apart.
export const ENCRYPTED_FILE_NAME_MESSAGE = 'Encrypted file name must end in .txt or .text.'

// Reduces a stored file name to a safe save-picker/download `suggestedName`:
// basename only (a stored Dropbox path must never reach the save dialog),
// filesystem-unsafe characters removed, an existing `.txt`/`.text` extension
// kept (`.txt` appended otherwise), falling back to the default export name
// whenever the stored name is missing or unusable.
export const toSuggestedTxtName = (name: string | null | undefined) => {
  if (!name) {
    return DEFAULT_EXPORT_FILE_NAME
  }

  const basename = name.split(/[/\\]/).pop() ?? ''
  const cleaned = basename.replace(/[<>:"|?*]/g, '').trim()
  const lowered = cleaned.toLowerCase()

  if (!cleaned || lowered === '.txt' || lowered === '.text') {
    return DEFAULT_EXPORT_FILE_NAME
  }

  return isEncryptedTextFileName(cleaned) ? cleaned : `${cleaned}.txt`
}
