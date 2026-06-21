import { configure } from '@testing-library/react'

// Full-suite parallelism runs real Argon2id derivations that starve the event
// loop — the same reason vite.config.ts sets testTimeout to 20s. RTL's default
// async timeout is 1000ms, far below that budget, so a findBy/waitFor whose
// target merely LAGS under load (a microtask + React re-render not yet scheduled)
// times out spuriously and flakes — especially once test order is shuffled
// and load is redistributed. Raise the default so order-independent
// waits have headroom; tests that need even longer still pass an explicit
// per-call timeout (e.g. the 15s unlock waits in App.update.test.tsx).
// Passing assertions resolve immediately and are unaffected; only a wait that
// would otherwise time out gets more room.
configure({ asyncUtilTimeout: 10_000 })
