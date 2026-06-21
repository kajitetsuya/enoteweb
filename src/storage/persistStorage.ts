// Ask the browser to exempt this origin's storage from automatic eviction
// (SPEC §5 lists storage eviction as an accepted risk; this lowers its
// probability). Feature-detected and idempotent: the browser remembers the
// grant, so repeat calls are cheap. Returns the granted state, or null when the
// API is unavailable (e.g. older Safari, jsdom).
export const requestPersistentStorage = async (): Promise<boolean | null> => {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
    return null
  }

  try {
    if (await navigator.storage.persisted?.()) {
      return true
    }
    return await navigator.storage.persist()
  } catch {
    return null
  }
}
