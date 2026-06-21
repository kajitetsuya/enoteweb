import type { StorageProvider, StorageProviderKind } from './storageProvider'
import { selectDefaultProviderKind } from './storageProvider'
import { localFileProvider } from './localFileProvider'
import { draftProvider } from './vaultStore'
import { dropboxProvider } from './dropboxProvider'

export const getStorageProvider = (
  requestedKind: StorageProviderKind = selectDefaultProviderKind(),
): StorageProvider => {
  if (requestedKind === 'local-file') {
    return localFileProvider
  }

  if (requestedKind === 'draft') {
    return draftProvider
  }

  return dropboxProvider
}
