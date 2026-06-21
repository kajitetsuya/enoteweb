// eNoteWeb service worker — version-pinned, user-initiated updates (SPEC Section 14).
//
// The installed app stays pinned to the exact build the user is running and never
// changes its running version on its own — not on launch, not on a schedule, not
// when connectivity returns, and not after relaunch. The browser may stage a newer
// build in the background, but serving is governed by the *pinned* version (a small
// Cache Storage record), not by which service-worker instance happens to be active.
// A staged build therefore waits, unused, until the user explicitly taps Update.

// Replaced at build time by the enoteweb-precache-service-worker plugin.
const BUILD_VERSION = '__ENOTEWEB_BUILD_VERSION__'
const PRECACHE_URLS = [
  /* __ENOTEWEB_PRECACHE_URLS__ */
]

// The deploy base, derived at runtime from the registration scope (SPEC §14).
// The SW is copied verbatim from public/ and is NOT processed by Vite, so it
// cannot read import.meta.env.BASE_URL — self.registration.scope is the source of
// truth. The scope is an absolute URL; its pathname is the base (e.g. '/' or
// '/enoteweb/') and always ends in '/'. The precache entries (Step 2) already
// carry this base, so cache lookups by Request keep matching; only the hardcoded
// shell/version.json paths below need the prefix.
const BASE = new URL(self.registration.scope).pathname
const INDEX_URL = BASE + 'index.html'
const VERSION_URL = BASE + 'version.json'

const ASSET_CACHE_PREFIX = 'enoteweb-assets-'
const ASSET_CACHE = ASSET_CACHE_PREFIX + BUILD_VERSION
const META_CACHE = 'enoteweb-meta'
const PIN_REQUEST = '/__enoteweb_pinned_version__'
// Per-build record of what install precached, written into the build's own
// cache so any later worker can verify that cache's integrity.
const PRECACHE_MANIFEST_REQUEST = '/__enoteweb_precache_manifest__'

// Cache lookups must ignore Vary: precache entries are stored from cors-mode
// worker fetches (which carry an Origin header) while pages issue no-cors
// subresource requests (which do not), so against a host that sends
// `Vary: Origin` (vite preview) a Vary-respecting match misses spuriously and
// offline serving can miss the cached response.
const MATCH_OPTS = { ignoreVary: true }

// The pinned (active) version is stored as a tiny text body in a dedicated cache,
// so every service-worker instance — including a newer staged one — reads the same
// authority for which build to serve.
const readPin = async () => {
  const cache = await caches.open(META_CACHE)
  const response = await cache.match(PIN_REQUEST)
  return response ? response.text() : null
}

const writePin = async (version) => {
  const cache = await caches.open(META_CACHE)
  await cache.put(
    PIN_REQUEST,
    new Response(version, { headers: { 'content-type': 'text/plain' } }),
  )
}

const ensurePrecache = async () => {
  const cache = await caches.open(ASSET_CACHE)

  // Fetch only the entries not already cached: install populated this exact
  // cache, so re-running on Update is instant and offline-tolerant instead of
  // re-downloading everything and failing the apply on one flaky fetch.
  const missing = []
  for (const url of PRECACHE_URLS) {
    const cached = await cache.match(url, MATCH_OPTS)
    if (!cached) {
      missing.push(url)
    }
  }

  if (missing.length > 0) {
    // cache: 'no-cache' revalidates against the origin instead of accepting
    // the browser's HTTP cache, so a version-keyed cache can never be filled
    // with a previous build's unhashed files (e.g. an index.html still fresh
    // under the host's max-age) — that would silently break version pinning.
    await cache.addAll(missing.map((url) => new Request(url, { cache: 'no-cache' })))
  }

  // Written last, so a manifest's presence implies the entries above were all
  // stored (addAll is atomic).
  await cache.put(
    PRECACHE_MANIFEST_REQUEST,
    new Response(JSON.stringify(PRECACHE_URLS), {
      headers: { 'content-type': 'application/json' },
    }),
  )
}

// Whether `cache` can serve its build: every manifest entry present, or — for
// caches written by workers that predate the manifest record — at least the
// app shell.
const cacheIsServable = async (cache) => {
  const manifestResponse = await cache.match(PRECACHE_MANIFEST_REQUEST, MATCH_OPTS)

  if (!manifestResponse) {
    return Boolean(await cache.match(INDEX_URL, MATCH_OPTS))
  }

  try {
    const urls = await manifestResponse.json()

    for (const url of urls) {
      if (!(await cache.match(url, MATCH_OPTS))) {
        return false
      }
    }

    return true
  } catch {
    return false
  }
}

// Keep the meta cache, the pinned build's cache (currently served), and this
// instance's own build cache (the freshly staged build). Older superseded caches
// may be removed — but never the cache that is currently being served.
const pruneCaches = async () => {
  const pinned = await readPin()
  const keep = new Set([META_CACHE, ASSET_CACHE])
  if (pinned) {
    keep.add(ASSET_CACHE_PREFIX + pinned)
  }

  const keys = await caches.keys()
  await Promise.all(
    keys
      .filter((key) => key.startsWith(ASSET_CACHE_PREFIX) || key === META_CACHE)
      .filter((key) => !keep.has(key))
      .map((key) => caches.delete(key)),
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await ensurePrecache()

      // Bootstrap only: the very first install on this device pins this build so
      // it is served. If a pin already exists, this is a background-staged build —
      // it must NOT change the pinned version (that would auto-update the user).
      const pinned = await readPin()
      if (pinned === null) {
        await writePin(BUILD_VERSION)
      }

      // No skipWaiting(): a staged build waits for an explicit Update.
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Self-heal: when the pinned build's cache is missing or can no
      // longer serve its shell (eviction, partial loss, stale pin from an old
      // dev session), repoint the pin to this instance's just-verified cache.
      // This is a deliberate, narrow exception to never-auto-update — the
      // alternative is a permanently unbootable app, and the Update UI lives
      // inside the app that can no longer boot.
      const pinnedBefore = await readPin()

      if (pinnedBefore !== BUILD_VERSION) {
        const pinnedCache = pinnedBefore
          ? await caches.open(ASSET_CACHE_PREFIX + pinnedBefore)
          : null
        const servable = pinnedCache ? await cacheIsServable(pinnedCache) : false

        if (!servable) {
          await writePin(BUILD_VERSION)
        }
      }

      await pruneCaches()

      // Claim only when this instance is the build being served (first-install
      // bootstrap, an explicit Update, or the self-heal above). A
      // background-staged instance must NOT claim, so it cannot swap the running
      // build out from under an open page.
      const pinned = await readPin()
      if (pinned === BUILD_VERSION) {
        await self.clients.claim()
      }
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)

  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return
  }

  // The update manifest is always fetched from the network so the service-worker
  // cache can never mask a newer published version. It is intentionally not
  // precached. Offline, this rejects and the caller surfaces "could not check".
  if (url.pathname === VERSION_URL) {
    event.respondWith(fetch(request))
    return
  }

  event.respondWith(
    (async () => {
      // A throwing Cache Storage lookup must degrade to the network,
      // never fail every request including navigations.
      try {
        const pinned = (await readPin()) ?? BUILD_VERSION
        const cache = await caches.open(ASSET_CACHE_PREFIX + pinned)

        const cached = await cache.match(request, MATCH_OPTS)
        if (cached) {
          return cached
        }

        // Self-heal fallthrough: a request the pinned cache cannot
        // serve is tried against this build's own cache before the network,
        // so a stale or partially evicted pin cannot brick the app.
        const ownCacheDiffers = pinned !== BUILD_VERSION

        if (ownCacheDiffers) {
          const ownCache = await caches.open(ASSET_CACHE)
          const ownCached = await ownCache.match(request, MATCH_OPTS)

          if (ownCached) {
            return ownCached
          }
        }

        if (request.mode === 'navigate') {
          const fallback = await cache.match(INDEX_URL, MATCH_OPTS)
          if (fallback) {
            return fallback
          }

          if (ownCacheDiffers) {
            const ownCache = await caches.open(ASSET_CACHE)
            const ownIndex = await ownCache.match(INDEX_URL, MATCH_OPTS)

            if (ownIndex) {
              // The pinned cache cannot even produce the shell: repoint so
              // later launches are version-consistent with what was served.
              event.waitUntil(writePin(BUILD_VERSION).catch(() => undefined))
              return ownIndex
            }
          }

          // Never dead-end a navigation while the network can still serve it.
          return fetch(request).catch(() => Response.error())
        }

        return fetch(request).catch(() => Response.error())
      } catch {
        return fetch(request).catch(() => Response.error())
      }
    })(),
  )
})

self.addEventListener('message', (event) => {
  const data = event.data
  const port = event.ports && event.ports[0]

  if (!data || typeof data.type !== 'string') {
    return
  }

  if (data.type === 'GET_VERSION') {
    port?.postMessage({ type: 'VERSION', version: BUILD_VERSION })
    return
  }

  if (data.type === 'ACTIVATE_UPDATE') {
    event.waitUntil(
      (async () => {
        try {
          // Only the worker the user was actually offered may repoint the pin.
          // This guards against activating a stale or mismatched worker if the
          // sw.js byte stream and version.json ever skew.
          if (typeof data.expectedVersion === 'string' && data.expectedVersion !== BUILD_VERSION) {
            port?.postMessage({ type: 'ACTIVATE_FAILED', reason: 'version-mismatch' })
            return
          }

          // Ensure this build's assets are fully cached before repointing the pin,
          // so a failed/partial download never leaves the app without a complete
          // working cache.
          await ensurePrecache()
          await writePin(BUILD_VERSION)
          // Tell every open window the pin now points at this build, BEFORE the
          // prune below removes the superseded cache. A window still running the
          // old build reloads (page-side guard guarantees it is locked) onto the
          // new pin instead of later 404ing on a lazy asset the prune deleted
          // Broadcast over clients.postMessage (not BroadcastChannel).
          const clients = await self.clients.matchAll({ includeUncontrolled: true })
          for (const client of clients) {
            client.postMessage({ type: 'VERSION_PINNED', version: BUILD_VERSION })
          }
          // Prune here too: a staged build that has already *activated* (and is
          // serving the old pin) will not re-run activate(), so this is the only
          // place its superseded cache gets pruned. Safe now that the pin points
          // at this build's complete cache.
          await pruneCaches()
          port?.postMessage({ type: 'ACTIVATED' })
          // No-op if this worker is already active; promotes it if still waiting.
          await self.skipWaiting()
        } catch (error) {
          port?.postMessage({ type: 'ACTIVATE_FAILED', reason: String(error) })
        }
      })(),
    )
  }
})
