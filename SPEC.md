# eNoteWeb Ultimate Specification

## 1. Product Definition

eNoteWeb is a cross-platform encrypted text editor implemented as a static web app/PWA. It runs on iPhone as a Home Screen web app, on Windows as an Edge app-style PWA/window, and on Android as an installed Chrome PWA. It edits plain text with optional Markdown source highlighting, encrypts all document content before storage or sync, and works offline.

The app is a privacy-focused writing tool, not a marketing site. The main interface is the editor. All app code, crypto libraries, editor libraries, icons, styles, and service worker assets are bundled locally into the production build. The app must not load runtime code, fonts, analytics, images, styles, or scripts from third-party CDNs.

The app uses one shared codebase with platform-specific storage providers. On Windows, the primary durable storage is a user-selected encrypted local file, and Dropbox sync is external if that file happens to live inside a Dropbox-synced folder. On iOS and Android, the primary durable storage is user-selected encrypted Dropbox `.txt` files (each with its own browser-local cache) because mobile web apps do not have smooth persistent save-back access to arbitrary local files. Browser-owned storage is always encrypted local cache and fallback storage. Plaintext exists only while the document is unlocked and being edited.

### How To Read This Specification

This document is the normative behavioral specification for eNoteWeb. It describes product requirements, data formats, user-visible behavior, and security invariants. Development history, release status, implementation plans, and test execution logs belong outside this document. When this document names a web API, browser capability, or library-backed mechanism, the requirement is the behavior and interoperability it provides unless the text explicitly marks a detail as reference implementation.

Core terms:

- **Storage mode** - the locked/home Settings choice that selects the provider home. The user-facing modes are `local-file` and `dropbox`.
- **Document kind** - the kind of document an unlocked editor session is bound to: a local file, a Dropbox file, or the draft.
- **Draft** - the single browser-local encrypted document that is not yet bound to a local file or Dropbox file. It can be edited locally and later promoted.
- **Local file** - a user-selected encrypted `.txt`/`.text` file saved back through a persistent file-save capability when available.
- **Dropbox file** - a user-selected encrypted `.txt`/`.text` file stored in Dropbox and represented locally by one recent-file cache record.
- **Fresh encryption** - decrypting or using in-memory plaintext and writing a new envelope with a fresh salt/nonce, the applicable KDF parameters (session-captured for ordinary saves, the password dialog's selected policy for New draft and Change Password), and the session's captured Secret-key policy.
- **Verbatim envelope copy** - copying the stored encrypted envelope without decrypting or re-encrypting it; this preserves metadata such as KDF parameters, read-only state, and Secret-key mode exactly.
- **Working copy modified time** - the timestamp of the local encrypted working copy. **Synced modified time** - the Dropbox `client_modified` timestamp of the remote version the local cache is synced to.

## 2. Platform Model

### iPhone And iPad

- Installed by opening the app URL in Safari and choosing Add to Home Screen.
- Recommended browser/runtime: Safari Home Screen web app.
- Runs as a standalone PWA with a Home Screen icon.
- Works offline after the first successful online load and service worker installation.
- Uses browser-owned storage such as IndexedDB for encrypted local cache.
- Does not rely on persistent write access through the iOS Files app.
- Uses Dropbox API sync for user-selected encrypted Dropbox `.txt` files as the primary durable storage path.
- The draft — the single browser-local encrypted document inside Dropbox Mode (Section 4) — is also available when Dropbox is not linked or unavailable. "Primary" names the default durable path, not the only one.

### Windows

- Recommended browser/runtime: Microsoft Edge installed PWA or Edge app-window shortcut.
- Launches from a desktop/start/taskbar shortcut through Edge regardless of the system default browser.
- Opens in an app-like standalone window without normal browser tabs or address bar.
- Supports offline launch after service worker installation.
- Uses Chromium File System Access API for direct encrypted local file open/save/autosave.
- Treats the selected encrypted local file as the primary durable storage.
- Does not use Dropbox API by default on Windows.
- If the selected local file is inside a Dropbox-synced folder, Dropbox desktop sync happens outside the app and the app treats it as an ordinary local file.
- Uses IndexedDB only for encrypted cache, file-handle metadata where permitted, recovery state, and — when Dropbox Mode is selected — the Dropbox cache layer and draft.
- Chrome and Brave are acceptable secondary Chromium runtimes; Firefox is fallback-only because it does not provide the same direct file save-back behavior.

### Android

- Recommended browser/runtime: Chrome installed PWA.
- Uses browser-owned encrypted cache plus Dropbox API sync as the primary durable storage path.
- Does not depend on arbitrary local file save-back.
- The draft — the single browser-local encrypted document inside Dropbox Mode (Section 4) — is also available when Dropbox is not linked or unavailable. "Primary" names the default durable path, not the only one.

## 3. Technology Stack

- Language: TypeScript.
- Framework: React.
- Build tool: Vite.
- Editor: CodeMirror 6.
- Crypto: `libsodium-wrappers-sumo`, bundled from npm into the production app.
- Local database: IndexedDB through a typed wrapper.
- Storage backends: Local File provider, Dropbox provider with its IndexedDB cache layer (per-file caches plus the single draft).
- Sync backend: Dropbox API for iOS/Android and optional manual use.
- Tests: Vitest for unit tests and Playwright for browser, offline, and network tests.
- PWA: web manifest and service worker.

No runtime package may be loaded from a CDN. All dependencies must be pinned in package lock files.

## 4. Storage Architecture

The editor, crypto, search, and UI layers must not hard-code Dropbox or IndexedDB as the document model. They must talk to a storage-provider interface. The **storage mode** — the home Settings choice (Section 15), of which there are exactly two — and the **document kind** — what an editor session is bound to — are distinct types, so the draft can never leak into mode selection:

```ts
type StorageMode = "local-file" | "dropbox"; // the only user-facing modes

type DocumentKind = "local-file" | "dropbox-file" | "draft"; // what a session edits

type StorageStatus =
  | { state: "ready"; detail: string }
  | { state: "needs-user-action"; detail: string }
  | { state: "pending-sync"; detail: string }
  | { state: "conflict"; detail: string }
  | { state: "offline"; detail: string }
  | { state: "error"; detail: string };

interface StorageProvider {
  kind: DocumentKind;
  load(): Promise<string>; // encrypted envelope
  save(envelope: string): Promise<void>;
  status(): Promise<StorageStatus>;
}
```

Provider selection is capability-based, not user-agent-string-only:

- If running in desktop Chromium with File System Access API, default to Local File Mode.
- If running on iOS or Android without suitable persistent file save-back, default to Dropbox Mode.
- Otherwise (a desktop browser without the File System Access API — for example Firefox), default to Dropbox Mode as well; there is no third option.
- Dropbox Mode works without a Dropbox link: the draft and Files import/export carry the no-link case, so no third fallback mode exists.
- Always allow manual choice in Settings. The choice is persisted in the `settings` store under `storageProvider` as an explicit storage mode (`local-file`/`dropbox`); there is no user-facing "Automatic" entry. On first launch (no stored value) the app resolves the capability-based selection above once and persists it. If a persisted choice is no longer supported by the current runtime capabilities, the app re-resolves the capability-based default. The persisted choice is applied at launch before the locked screen loads, and changing it is only offered while locked (from the home-screen Settings dialog, Section 15).

### Local File Provider

Used by default on Windows Edge.

- Opens or creates a user-selected `.txt` encrypted file.
- Reads the encrypted envelope from that file.
- Saves encrypted envelopes directly back to the same file after permission is granted.
- Uses a fresh encryption nonce for every save.
- May persist file handles only through browser-supported secure mechanisms.
- If a persisted handle becomes invalid, asks the user to reopen the file.
- Shows a **Local files** block on the locked Local File Mode screen, parallel to the Dropbox block. It uses the local storage icon, a recent-file table with `Name`, `Path`, and `Last modified` columns, and persists the selected active row.
- Local File Mode locked-screen provider-block actions are `Set path root`, `Open`, and `Browse`. `Set path root` opens the browser's folder chooser and is used only to display recent local-file paths relative to that folder when possible. `Open` opens the unlock password dialog for the selected recent row. `Browse` opens a file picker first and then the unlock password dialog for the chosen encrypted file — file first, password second, consistent with the destination-then-password order everywhere (Section 10).
- `Browse` appends newly selected files to the bottom of the recent-file table. If the browser can confirm that the newly selected handle refers to the same physical file as an existing recent record, **every** older record for that file is automatically removed so the table converges to one row per file — this covers Save As onto a listed file and any duplicate records from prior browsing or imported state.
- Right-clicking a recent-file row offers `Delete from list`. This removes only the recent-file record and must not delete the file from the user's PC.
- Does not call Dropbox APIs.
- Dropbox desktop sync, OneDrive, network drives, or other folder sync tools are outside the app and treated as ordinary filesystem behavior.

### Dropbox Provider

Used by default on iOS and Android.

- Uses Dropbox API as the durable encrypted remote store for user-selected Dropbox `.txt` files.
- Keeps one encrypted local cache per recently opened Dropbox file in IndexedDB (the cache layer below), including pending-offline-edit storage, so each file in the home recent-files list opens from cache and syncs independently.
- Supports revision-aware sync and conflict handling per file.

### The Draft And The Dropbox Cache Layer

In Dropbox Mode, IndexedDB is the single browser-local storage layer. It holds two kinds of encrypted document state:

- **Per-file caches** — one encrypted envelope (plus sync snapshots) per Dropbox file in the home recent-files list (Section 9). A cache is a waypoint, not a destination: it exists so its Dropbox file opens instantly and survives offline editing. Its lifecycle is tied to the file's recent-list record, and it is never editable when the link to Dropbox is gone (Section 9, authorization loss) — browser storage is too evictable to serve as a second vault.
- **The draft** — exactly one browser-local encrypted document that belongs to no Dropbox file. It supports encrypted import/export through Files, has no automatic cross-device sync, and must be available even when Dropbox is not linked. It is the only browser-local document edited as a destination in its own right, and even it is designed to be promoted: uploading the draft to Dropbox converts it into an ordinary cached Dropbox file and empties the draft slot, and in Local File Mode a Save As writes it to a local file and empties the draft slot likewise (Section 10).

There is no standalone browser-local storage mode. The draft is the only browser-local document destination, and it is available in both storage modes (with mode-specific home actions, Section 4) rather than being a mode of its own.

### Editor Sessions And Storage Actions In Dropbox Mode

An unlocked editor session in Dropbox Mode is bound to exactly one document: either a **Dropbox file session** (working from that file's local cache) or a **draft session**. There is no Dropbox connection layered over a shared working copy — each Dropbox file has its own cache, and switching documents means going Home and opening another one. (Local File Mode's editor actions are in Section 10; it likewise has **no manual Save button** — autosave writes the bound file — and keeps **Save As**.)

Toolbar storage actions by session. There is **no Save / sync-now button** in any mode: autosave persists the document continuously — in Dropbox Mode it writes the file's cache **and** uploads to the remote revision-conditionally on every debounced save (not a cache-only write) — so the only manual storage actions are a mode-specific **destination button** and **Export**. Conflict resolution and offline backlog flushing are covered by automatic sync (on reconnect and on going Home) and by the contextual **Resolve** banner (Section 9).

- **Dropbox file session** — **Dropbox** (save a copy of the current document to a chosen Dropbox `.txt` destination and move to editing it there) and **Export to Files** (below). The icon is the Dropbox logo, but the accessible label / tooltip is descriptive — *"Save to Dropbox"* — so it never reads as "sync this file".
- **Draft session** — **Dropbox** (the *promotion*: push the draft to a Dropbox `.txt` destination chosen through the Dropbox file browser, Section 9, then convert the draft into that cached, syncing Dropbox file; the draft slot empties) and **Export to Files**.
- Both **Dropbox** destination buttons flush the current plaintext into a freshly encrypted envelope (fresh nonce, the **current** password, the session's captured KDF parameters, and the session's captured Secret-key write policy) and upload that — never a stale stored autosave — updating the file's cache to the same envelope so cache and remote match. No new password is asked (rotation is the separate Change Password action, Section 10). A new path is created (add); an existing path is overwritten only after explicit confirmation, never before it, and the confirmed replacement uploads revision-conditionally against the revision observed at the existence check (Section 9). When the destination is itself a cached recent file, the confirmation also names the local consequence: the file's cache is replaced too, destroying any unsynced changes it holds. **Force-out-of-conflict exception:** choosing the **current session's own Dropbox file** — matched by **file id**, not merely the same path — as a deliberate "my version wins" exit first runs a **fresh metadata probe** and surfaces it in the confirmation (*"This replaces the Dropbox copy, including changes made on other devices (remote last changed &lt;when&gt;). Continue?"*); only then does it replace revision-conditionally against the **freshly-probed `rev`**, overriding the *stale session base* (what made the session diverged), **not** the revision guard itself — so a change landing between probe and upload still 409s and re-confirms, never an unconditional path overwrite. A same-*path* target whose **id differs** is an ordinary overwrite (revision-conditional, never force). When Dropbox is not linked, the **Dropbox** control is grayed and muted (non-functional in the editor): the editor never initiates Dropbox linking — that OAuth redirect would navigate away and drop the unlocked draft — so tapping it only directs the user to link from the Home screen.
- **Export to Files** — export the current document as a one-shot encrypted `.txt` copy (the Files import/export model below). It uses the current document password (no new-password prompt) and a freshly encrypted envelope so the export always matches the editor, never a stale autosave. Local File Mode has no Export action: there **Save As** already writes an encrypted file to local disk with no network dependency, so it *is* the offline savior and a separate Export would near-duplicate it; in Dropbox Mode the destination button needs the network, so Export is kept as the offline/provider-independent fallback.

**Files import/export.** "Files" is explicit one-shot import and export on every platform, never a silently-syncing connection (iOS Safari and Android Chrome have no writable file handle, so a Files connection that auto-overwrites is not possible there; the model is kept uniform). *Import draft* (a home action, Section 10) reads an encrypted `.txt` into the **draft** once — it never touches Dropbox files, their caches, or the link state; when a draft already exists, a `Replace the draft?` confirmation runs after the file is picked, never before. *Export draft* (a home action, Section 10) writes the draft's stored envelope out once, with no password step (the record is already ciphertext). *Export to Files* is the editor-session counterpart for the open document. All exports go through the platform export flow in Section 10: a native save dialog pre-filled with a suggested default filename where the File System Access API exists, otherwise an immediate browser download named with the suggested default (renamed afterward in the Files app / download manager if desired; where a share sheet exists the user can "Save to Files"). There is no Files-side conflict (export is overwrite-only), so no three-way conflict exists.

**Linking is initiated only from the Home screen.** Dropbox OAuth is a full-page redirect that reloads the app and would drop an unlocked draft's in-memory plaintext and password, so the editor never starts it: the draft session's **Dropbox** control is muted while unlinked and only points the user to the Home screen. Linking from Home runs against the locked home (no in-memory plaintext to lose); afterward the user re-unlocks the draft and taps **Dropbox** (Save to Dropbox), which — now linked — promotes normally. The plaintext and password are never persisted across the redirect.

**Provider homes.** The locked/home screen has a provider block on top and the **mode-specific** draft/Files actions below it (Section 10). In Local File Mode the row is `New draft`/`Edit draft` · `Delete draft` · **`Save As`**; in Dropbox Mode it is `New draft`/`Edit draft` · `Delete draft` · **`Dropbox`** (a home-level promote button, muted while unlinked) · **`Export draft`** · **`Import draft`**. In Dropbox Mode the provider block is the **Dropbox** block (link state, recent-files table, and Browse/Open actions — Section 9). In Local File Mode the provider block is **Local files** (local storage icon, recent-files table, `Set path root`, `Browse`, and `Open`) without adding a Dropbox-style cache layer. There is no home-level password field and no home-level provider-specific Create file action; a new Dropbox file comes into existence only by promoting a draft — from the editor's **Dropbox** button or the home **`Dropbox`** promote button. Both home promotions (`Save As` in Local Mode, `Dropbox` in Dropbox Mode) write the draft's **stored envelope verbatim** — no password, no re-encryption — register it as a recent file, and clear the draft only **after** the write/upload succeeds (a failed promotion preserves the draft).

## 5. Security And Privacy Requirements

### Data Stored Persistently

The app may persist:

- encrypted document envelopes
- encrypted base snapshots used for sync
- encrypted pending local snapshots
- encrypted local-file recovery snapshots
- browser file handles where supported
- local file display names and non-sensitive handle metadata
- Dropbox revision identifiers
- recent Dropbox file metadata: file id, name, display/lowercase paths, and sync/last-opened timestamps
- OAuth/session data needed for Dropbox sync
- the linked Dropbox account identifier (the account-switch guard, Section 9)
- editor settings and the optional local Secret key setting (Section 6/8)
- non-sensitive timestamps and status flags

The app must never persist:

- plaintext document content
- password
- Secret key outside the dedicated local `secretKey` setting
- derived encryption key
- search query
- replacement text
- plaintext diffs
- plaintext merge base
- plaintext conflict copies
- decrypted Markdown preview HTML

Plaintext document content is allowed only in memory while the document is unlocked. On explicit lock or logout, the app must attempt encrypted save, destroy editor state, clear plaintext React state, clear password input state, and clear references to derived keys. App backgrounding, `visibilitychange` to hidden, and `pagehide` are autosave triggers only: the app must attempt an immediate encrypted save but must not lock, destroy editor state, clear plaintext state, or clear password/key references solely because the page is backgrounded.

JavaScript cannot guarantee memory zeroization. The implementation must still remove references promptly and avoid unnecessary plaintext copies.

### Network Policy

The app's normal network traffic is limited to:

- fetching the app's own static assets from its origin
- the browser's own automatic background re-check of the service-worker script, which targets the app's own origin only; it may surface a passive "update available" indicator but never changes the running build (see Section 14, App Update Strategy)
- a user-initiated update check that fetches a small version manifest from the app's own origin, and—only when the user chooses to update—the new build's static assets from that same origin (see Section 14, App Update Strategy)
- Dropbox OAuth/API requests when Dropbox Provider is active

The update check targets the app's own origin only, so it requires no addition to `connect-src` beyond `'self'`.

The app includes no analytics, telemetry, crash reporting, error beaconing, performance monitoring, or usage tracking of any kind. No third-party measurement, tag manager, advertising, or logging endpoint is bundled or contacted, and no such dependency may be added. The destinations listed above are the only ones the app ever initiates; everything else (including diagnostics from Section 16) stays on-device.

No plaintext document content may be sent over the network. Dropbox receives only encrypted envelope files and required protocol metadata. In Local File Mode the app must make no Dropbox requests; in Dropbox Mode it makes them only while linked. The production CSP must restrict connections to the app origin and exact Dropbox API/OAuth endpoints.

Markdown preview must not load remote images, scripts, iframes, styles, fonts, or links with active content. Remote resource loading from document content is disabled by default.

### Dependency Integrity

All runtime and build dependencies are pinned to exact versions in `package.json`, and `.npmrc` sets `save-exact=true` so future installs do not reintroduce version ranges. The committed `package-lock.json` fixes the full transitive tree, and CI installs with `npm ci` so a build resolves to exactly the reviewed dependency set. This limits supply-chain drift — a transitive update cannot silently enter a published build — consistent with the no-remote-assets and no-added-tracking-dependency requirements above.

### Production Content Security Policy

Production builds must include a CSP meta tag in the generated `dist/index.html`. The CSP is injected at build time rather than written directly in source `index.html`, so `npm run dev` remains CSP-free unless a separate development-only CSP is intentionally added.

The production meta CSP must include:

- `default-src 'self'`
- `base-uri 'none'`
- `connect-src 'self' https://api.dropboxapi.com https://content.dropboxapi.com`
- `font-src 'self'`
- `form-action 'none'`
- `frame-src 'none'`
- `img-src 'self' data:`
- `manifest-src 'self'`
- `media-src 'none'`
- `object-src 'none'`
- `script-src 'self' 'wasm-unsafe-eval'`
- `style-src 'self' 'unsafe-inline'`
- `worker-src 'self'`

The production build must also include a static-host header configuration file when the target hosting format supports it. That HTTP-header CSP must mirror the meta CSP and additionally include `frame-ancestors 'none'`. `frame-ancestors` is specified in the header policy, not the meta policy, because it is only reliable from an HTTP CSP header.

The meta CSP and the static-host header CSP are two copies of the same policy. To prevent silent drift, both must derive from a single canonical directive list (the meta policy is that list verbatim; the header policy is that list plus the header-only directives, currently just `frame-ancestors 'none'`). Editing the policy in only one place is a defect: the two must always carry the identical set of shared directives, and a test asserts this (see Section 17). A build that emits a meta CSP and a header CSP whose shared directives disagree must fail.

GitHub Pages, the intended deployment target, does not support custom HTTP response headers. When deployed there, the static-host header configuration file is ignored and only the meta CSP is enforced; header-only directives such as `frame-ancestors 'none'` therefore do not apply. The header configuration file is still emitted into every build (generated from the canonical directive list rather than committed as a hand-maintained copy) so that fronting the app with a CDN, reverse proxy, or custom-domain host that supports response headers enforces the full header CSP without further changes.

The `wasm-unsafe-eval` allowance exists only to support bundled libsodium WASM. `libsodium-wrappers-sumo` embeds its WASM as Base64 inside the JavaScript bundle and instantiates it through `WebAssembly.instantiate(<ArrayBuffer>)` (compile-from-buffer, not `WebAssembly.instantiateStreaming` and not a network fetch of a `.wasm` file). Compiling a WASM module from an in-memory buffer is exactly the operation `wasm-unsafe-eval` authorizes, so this allowance is required while libsodium is the crypto provider and no separate `.wasm` asset is emitted by the build. It may be removed only after verifying encryption/decryption still works in production without it (for example, after switching to a streaming-instantiated or non-WASM crypto provider). The `unsafe-inline` style allowance exists only for local inline style attributes and CodeMirror runtime styles. It may be removed only after the app and editor render correctly without inline styles. Neither allowance permits remote runtime scripts, stylesheets, fonts, images, or analytics.

### Accepted Residual Risks

- Plaintext can be visible to screenshots, screen recording, accessibility tools, browser internals, OS text services, or device compromise while unlocked.
- A user-initiated line-number copy (Section 11) places that line's last word (plaintext) on the system clipboard, where it persists until overwritten and may be readable by other apps, clipboard managers, or OS clipboard history/sync.
- The Secret key `QR` action (Section 6) renders the key as a machine-readable code. Alongside the plaintext key display in Settings, it is a deliberate, user-initiated exposure of the key; but a QR is more easily captured at a distance — by a camera in the room, a screen share, a screen recording, or a screenshot — than reading the key string by eye. It is shown only inside its popup, on explicit action, and the rendered code (not the underlying Settings key) is discarded when the popup closes.
- If the hosted app deployment is compromised, malicious code could exfiltrate plaintext after unlock.
- Browser-owned storage can be cleared by user action, app removal, origin changes, private browsing cleanup, or storage pressure.
- Local File Mode depends on browser-granted file permission; the user may need to reopen the encrypted file if the handle expires or permission is revoked.
- Weak passwords are vulnerable to offline guessing if an attacker obtains encrypted files.
- The optional Secret key is stored locally in the browser/app's IndexedDB setting. It improves resistance when an attacker obtains only encrypted files (for example from Dropbox or an off-device backup), but it does not protect against an attacker who can read this app's browser storage or execute malicious code in the running app. In Local File Mode, the encrypted local file and the stored Secret key may live on the same device, so the Secret key adds little against device compromise.
- Applying Secret key to a file (the `Secret key` toggle in the password dialogs, Section 6/10) makes its future saves require the same Secret key on every device. The app never converts a file automatically — a file's mode changes only when the user flips that toggle — so a user who applies the key on one device before transferring it to another can lock the other device out until the same key is pasted in Settings or entered in the unlock dialog there.
- Secret-key protection can be added to or removed from a file by re-saving it through Change Password with the `Secret key` toggle on or off (Section 6/10); turning it off re-encrypts the file as password-only, which lowers its protection. `Clear` in Settings removes only the local key material and never rewrites files, so a file already saved as `required-v1` still requires the same key to open until it is re-saved with the toggle off.
- Dropbox can observe encrypted file metadata such as account identity, path, file size, timestamps, IP address, and sync frequency when Dropbox Provider is active or when Dropbox desktop sync independently syncs a Windows local file.
- On GitHub Pages, header-only protections cannot be applied (no custom HTTP response headers), so `frame-ancestors 'none'` and any other header-only CSP directives are not enforced unless the app is fronted by a host that supports response headers. The exposed surface is a clickjacking/overlay attempt against the unlock or Settings dialogs; the in-app sanitizer and the same-origin service worker are unaffected by framing.
- The user-initiated update check, and the browser's automatic background re-check of the service-worker script, are cleartext requests to the app's own origin; the host can observe that the app's origin was contacted and the requesting IP/timestamp. No document content or credentials are sent, and neither changes the running build on its own — only an explicit user-confirmed update does.

## 6. Encryption Specification

Use libsodium through `libsodium-wrappers-sumo`.

Password key derivation:

- Function: `crypto_pwhash`.
- Algorithm: `crypto_pwhash_ALG_ARGON2ID13`.
- Output length: 32 bytes.
- Salt length: 16 bytes.
- Default opslimit: `3`.
- Default memlimit: `67108864` bytes.
- Maximum accepted opslimit: `10`.
- Maximum accepted memlimit: `268435456` bytes.
- Store KDF parameters in each encrypted envelope.
- Reject envelopes whose KDF parameters exceed the maximum accepted values before attempting key derivation.
- KDF caps are resource-safety limits to avoid excessive CPU or memory use from malformed or hostile encrypted files. Raising these caps requires an explicit spec change and tests.

Password string policy:

- Passwords are accepted as JavaScript Unicode strings and passed unchanged to libsodium's password KDF. The app does not restrict passwords to ASCII and does not silently normalize, trim, case-fold, or otherwise transform password strings before key derivation.
- This preserves existing encrypted files whose passwords contain non-Latin characters or visually unusual code points. The tradeoff is that canonically similar Unicode strings, invisible characters, tabs, and leading/trailing spaces are distinct passwords; the UI should help users verify what they typed (for example with a native or app-provided show/hide control), but must not rewrite it.
- Password inputs should not unnecessarily force ASCII-only or non-IME keyboard behavior. Use a masked text input plus the app's own show/hide control so Japanese and other non-Latin input methods remain available on both mobile and desktop while the password is hidden by default.

Secret key policy:

- The locked/home Settings dialog exposes an optional **Secret key**. It is empty by default and local to the current browser/app install; it is not synced through Dropbox, written into encrypted files, or recoverable from the file contents. The user must set the same Secret key on each device that should open Secret-key-protected files.
- The Secret key is app-generated/imported, not user-invented free text. `Generate` creates a new opaque self-checking key string from 32 bytes of CSPRNG output and displays a warning before replacing any existing key. `Paste` imports a key string in the canonical format, trimming only surrounding whitespace before validation; when a key is already configured, it confirms before replacing it (analogous to `Generate`/`Clear`), and validates the pasted value first so an invalid paste never prompts. `Clear` removes the local key after confirmation and does not rewrite any file. `QR` opens a popup that displays the configured key as a QR code for carrying it to another device by scanning.
- The canonical key string format is exactly the Base64url-no-padding encoding of 36 bytes: a 32-byte random payload followed by a 4-byte checksum. The checksum is the first four bytes of `SHA-256(UTF-8("enoteweb secret key checksum v1") || payload)`. The encoded string is 48 characters drawn from `A-Z`, `a-z`, `0-9`, `_`, and `-`. It intentionally contains no app name, version label, colon, URI-scheme-like prefix, padding, or whitespace; the string is opaque to the user. The checksum is for typo/corruption detection and version-domain separation only, not for strengthening encryption or proving the key is correct for a file. Invalid characters, padding, wrong character count, wrong decoded length, checksum mismatch, URI-scheme-like prefixes, or empty pasted values are rejected with a settings-dialog error.
- The 32-byte random payload, not the 4-byte checksum, is the Secret-key material that participates in encryption. The app stores, displays in Settings, accepts through Paste, and QR-encodes the canonical 48-character string; after validation it extracts the 32-byte payload for the Secret-key KDF.
- The `QR` action encodes the exact configured canonical key string as a QR code in a dismissible popup, so a second device imports the key by scanning it (the scanning device's camera yields the key string, which is entered through that device's `Paste`) instead of retyping. `QR` is disabled when no key is set, like `Clear`. The QR is generated entirely on-device and the key string is never sent anywhere: the encoding is a local in-process computation with no network request, and the rendered code is held only while the popup is open and is never persisted, logged, exported, or written into any record, file, or Dropbox metadata. The popup does not show the key string as text; its accessible label describes the QR code without containing the key value itself, and the code renders as dark modules on a light background with a quiet-zone margin in every theme so it stays scannable. Closing the popup discards the rendered code.
- Every envelope eNoteWeb writes records whether the Secret key was used, with the authenticated metadata field `secretKey` equal to `"none"` or `"required-v1"` (Section 7). The actual Secret key string or bytes must never be stored in the envelope, Dropbox records, local-file records, recent-file rows, logs, diagnostics, messages, filenames, URLs, or network requests.
- For absent `secretKey` or `secretKey: "none"`, decryption and encryption use the password-only KDF input. For `secretKey: "required-v1"`, decryption requires the matching Secret key, supplied through the unlock dialog's `Secret key` field (Section 10) — which is pre-filled with the local Settings key but is authoritative, so its current value is what is used. If no key is supplied (the field is left empty), the app does not attempt decryption and prompts for the key (it can be entered inline or set in Settings). If a key is supplied but the decrypt fails, the UI does not reveal whether the password, Secret key, envelope, or authentication tag was wrong.
- The KDF input for Secret-key-protected files is not string append. It is a domain-separated byte sequence: UTF-8 bytes of `enoteweb-secret-key-kdf-v1\0`, then a 32-bit big-endian password-byte length, then the password's exact UTF-8 bytes, then a 32-bit big-endian Secret-key-byte length, then the validated 32-byte Secret-key payload. The 4-byte checksum is excluded from this KDF input. This byte sequence is passed to `crypto_pwhash` directly as a `Uint8Array`, never converted to or assembled as a JavaScript string. The assembled KDF-input buffer contains password and Secret-key material and must be zeroized in a `finally` block after derivation. The user's password string still follows the password policy above.
- A file's Secret-key mode is an explicit per-file choice; the app never converts a file automatically. An unlocked editor session captures its write Secret-key policy and, when applicable, the validated Secret-key payload at create/unlock time, and ordinary saves, autosaves, Save As writes, Dropbox destination writes, and current-document exports from that session use the captured policy/key material — so another tab changing or clearing the home Secret key cannot silently change or break the encryption mode of an active document. Change Password is the explicit flow that may change this mode through its own dialog toggle. The policy is captured per flow:
  - **New draft** — the create-password dialog's `Secret key` toggle (Section 10): on writes `required-v1` using the configured key payload, off writes `none`.
  - **Unlock** — the file's own mode. A `none` file stays `none` even when a Secret key is configured (NO automatic promotion); a `required-v1` file is opened with the key supplied at unlock (the Settings key or the unlock dialog's inline field) and the session keeps that mode and key payload.
  - **Change Password** — the change-password dialog's `Secret key` toggle (Section 10): turning it on re-encrypts the document as `required-v1` (this is how a `none` file *gains* protection), turning it off re-encrypts it as `none` (this is how a `required-v1` file's protection is *removed*). The new password may equal the old one, so the toggle alone can add or remove the Secret key.
- The `Secret key` toggle is enabled whenever a key is available to apply, and shown disabled + off only when none is — where "available" means a Settings key is configured **or** the session already holds a validated key payload (it unlocked a `required-v1` file, including via the unlock dialog's inline field on a device with no Settings key). The four key-availability cases:
  - **Neither** (no Settings key and no session key — e.g. editing a `none` document on a keyless device): disabled + off. Nothing to apply, nothing to remove.
  - **Settings key only** (a `none` document on a keyed device): enabled. Create defaults on; Change Password defaults off (the document is `none`) — flip it on to add protection using the Settings key.
  - **Session key only** (a `required-v1` document unlocked via the inline field on a device with no Settings key): enabled. Change Password defaults on (the document is `required-v1`) — keep it to stay protected, or flip it off to remove, reusing the unlocked key.
  - **Both** (a `required-v1` document on a keyed device): enabled, defaulting to the document's current mode.

  Create-password has no session, so its toggle is enabled iff a Settings key is configured; the change-password toggle always defaults to the document's current mode when enabled.
- Verbatim envelope-copy flows never re-encrypt and therefore never change Secret-key mode: draft Export, per-row Export, Import-to-draft, and locked-draft home promotions copy the stored envelope exactly as they already do for password-free ciphertext handling.

KDF parameter selection policy:

- The default parameters are deliberately tuned for mobile Safari, which is the binding performance constraint across supported platforms.
- The app does not adaptively raise parameters based on device capability. A user may opt into a higher policy at the moments where a password is chosen. The supported policies are:
  - `standard` (`Standard` in the UI): `opslimit = 3`, `memlimit = 67108864`;
  - `strong` (`Strong` in the UI): `opslimit = 4`, `memlimit = 134217728`.
- The local Settings value stores only the default policy id (`"standard"` or `"strong"`). It is a default for future password-choosing dialogs, not a live write policy for an already-open document. Encrypted files do not store the policy id; each envelope stores the resolved numeric `opslimit` and `memlimit` fields directly as authenticated metadata, because decrypting a file requires the exact KDF parameters that were used to write it.
- Opening an existing file captures that file's stored KDF parameters for the editor session. Ordinary writes from that session — autosave, Save As, Dropbox destination writes, current-document Export to Files, conflict-resolution commits, and read-only toggles — preserve the captured parameters instead of adopting later Settings changes. This keeps routine saving from silently strengthening, weakening, or otherwise changing a file's password-hardening cost.
- New draft creation uses the create-password dialog's selected policy. The `Use strong password hardening` toggle initializes from the local Settings default: on when the default is `strong`, off when it is `standard`.
- Change Password uses the change-password dialog's selected policy. The `Use strong password hardening` toggle initializes from the current document's stored policy: on when the current file uses the `strong` parameters, off when it uses the `standard` parameters. The new password may equal the old one, so the hardening toggle alone can change the file's KDF strength.
- The create-password and change-password dialogs present controls in this order: `Password`, `Confirm password`, `Use strong password hardening`, then `Use secret key` when the Secret-key toggle is available or relevant. The hardening control is a slide/toggle-style control like `Use secret key`, not a raw numeric input.
- Selecting `Strong` from `Standard` in locked/home Settings must warn before persisting the default: files saved with `Strong` use more memory and may be slower or fail to open on older devices. Cancel keeps `standard`; confirm stores `strong`. Switching back to `Standard` needs no warning.
- In password dialogs, turning `Use strong password hardening` on must show the same memory/performance warning only when the dialog's initial hardening was `standard`. Cancel reverts the toggle to off; confirm leaves it on. No warning is shown when the dialog initially opens with Strong already on (because the Settings default is Strong for New draft, or because the current file is already Strong for Change Password).
- Verbatim envelope-copy flows do not run KDF and preserve the stored parameters and `secretKey` mode.
- The maximum accepted KDF caps are hostile-file safety limits and are not exposed as a "maximum" user-facing policy. Adding another policy level or changing a policy's numeric values requires an explicit spec change and tests.
- The parameters stored inside an opened envelope do not raise the local Settings default, and later Settings changes do not alter the active session's ordinary save policy. Change Password must re-encrypt at the password dialog's selected policy, not implicitly at the local Settings default.

Authenticated encryption:

- Function family: XChaCha20-Poly1305 IETF.
- Encrypt: `crypto_aead_xchacha20poly1305_ietf_encrypt`.
- Decrypt: `crypto_aead_xchacha20poly1305_ietf_decrypt`.
- Key length: 32 bytes.
- Nonce length: 24 bytes.
- Every encryption uses a fresh random nonce.
- Ciphertext field stores libsodium output: ciphertext plus 16-byte authentication tag.

Cryptographic randomness:

- Use `sodium.randombytes_buf` for encryption salts, nonces, keys, and any other cryptographic random bytes.
- Never use `Math.random` for encryption, key derivation, authentication, or any other cryptographic/security-sensitive value.

Plaintext encoding:

- Encode plaintext as UTF-8 before encryption.
- Decode decrypted bytes as UTF-8 (a leading U+FEFF is preserved, not stripped).
- Reject invalid UTF-8 with the generic unlock/import failure message.
- Line endings are normalized to LF (`\n`) once, explicitly, at unlock: an
  externally-authored envelope containing CR or CRLF line endings is opened with
  them rewritten to LF (the editor's document model is LF-based, so this makes
  the rewrite deliberate rather than an invisible editor side effect). After
  that, line endings are preserved exactly as edited through save, reload,
  export, import, and sync — app-written envelopes are always LF.

## 7. Encrypted File Envelope

Encrypted files are saved, opened, imported, exported, and synced only as `.txt` or `.text` files containing UTF-8 ASCII text. Binary values inside the envelope are encoded with standard Base64:

```text
-----BEGIN ENOTEWEB ENCRYPTED TEXT-----
{
  "v": 1,
  "app": "enoteweb",
  "kdf": "argon2id13",
  "opslimit": 3,
  "memlimit": 67108864,
  "secretKey": "none",
  "aead": "xchacha20poly1305-ietf",
  "salt": "<base64>",
  "nonce": "<base64>",
  "ciphertext": "<base64>"
}
-----END ENOTEWEB ENCRYPTED TEXT-----
```

Rules:

- Header and footer must match exactly.
- JSON body must parse to an object.
- `salt`, `nonce`, and `ciphertext` use standard Base64: the standard alphabet (`+` and `/`) with `=` padding. URL-safe Base64 (`-`/`_`) and unpadded Base64 are rejected even though they would decode to the same bytes, because accepting them would change the canonical AAD.
- The supported encrypted file extensions are `.txt` and `.text`.
- Parser rejects invalid Base64, wrong salt length, wrong nonce length, unsupported version, unsupported KDF, unsupported AEAD, missing required fields, non-integer KDF parameters, KDF parameters above the accepted caps, or invalid UTF-8 after decrypt.
- Unknown metadata fields are allowed for forward compatibility and included in AAD.
- The `app` field is required and must equal `"enoteweb"`. An envelope missing `app`, or carrying a different `app`, is rejected. (This is distinct from the canonical-AAD requirement below: AAD is computed over whatever fields are present, but a valid V1 envelope must always contain `app`.)
- The `secretKey` field is written in every V1 envelope produced by eNoteWeb and, when present, must be exactly `"none"` or `"required-v1"`. This field is authenticated metadata only: it says whether the local Secret key participates in KDF input; it never contains the Secret key itself. An absent `secretKey` is interpreted as `"none"`; on the next fresh encryption the field is written explicitly. Stripping `secretKey` from an envelope that authenticated it still breaks authentication, because AAD is computed over the metadata fields as written.
- An optional `readOnly` field (boolean) marks the document read-only in the editor (Section 11). It is written only when `true`; absent means writable. Readers treat exactly boolean `true` as read-only and any other value as writable — never as a parse error. Like every metadata field it is authenticated through the AAD, and unknown fields remain part of AAD even when a reader does not otherwise use them.

AAD is the UTF-8 encoding of canonical JSON for all envelope fields except `ciphertext`.

A reader computes AAD over every metadata field present in the envelope except `ciphertext`, including fields it does not recognize. A reader must never drop unknown fields when computing AAD. This is what makes additive forward compatibility safe: a future envelope that differs from V1 only by adding metadata fields remains decryptable by an older build, because the older build still folds those unknown fields into the AAD exactly as written.

Canonical JSON rules:

- Include all metadata fields except `ciphertext`.
- Sort object keys lexicographically, recursively, at every nesting level (not only the top level).
- Use no whitespace outside strings.
- Use `JSON.stringify` escaping semantics. No Unicode normalization (such as NFC) is applied; string values are preserved code-point-exact, and the AAD is the UTF-8 encoding of the resulting canonical JSON string. All V1 string fields are ASCII, so a V1 envelope is ASCII text; a future envelope carrying a non-ASCII unknown string field would still be valid UTF-8 but would no longer be pure ASCII.
- Serialize numbers as JSON integers (for example `3`, never `3.0`). Reject any number that is not a finite integer. This applies to the numeric algorithm parameters and to any numeric value in an unknown field.

For current canonical V1 envelopes, tampering with any authenticated metadata field must cause decrypt failure.

Decrypt must use only the canonical V1 AAD format. Stored-order metadata AAD, missing-`app` AAD, no-AAD envelopes, and other noncanonical variants are not supported. Future app versions must continue reading canonical V1 envelopes unless the envelope version is intentionally changed.

Versioning policy:

- A build can read the envelope versions and KDF/Secret-key policies listed in its supported read set. Each envelope is decrypted with the KDF parameters and `secretKey` mode stored in it. Saving then writes the file to the current write version and re-encrypts with the session-captured KDF parameters and Secret-key mode (see Section 6); Change Password is the explicit flow that can adopt a different dialog-selected KDF policy.
- The app maintains an explicit set of supported read versions and a single write version. Today both are `1`.
- On every save the app rewrites the envelope using the current write version. The app never preserves an older on-disk version on save; opening an older-version envelope and saving updates it to the current write version.
- Reading must accept every version listed in the supported read set and reject any version outside it with the generic unlock/import failure.
- Introducing a future version (for example V2) requires one deliberate sequence: add the new version to the supported read set, keep every still-supported prior version (including V1) in that set, and only then promote the write version to the new value. Bumping the write version without first shipping read support is prohibited. The same discipline applies to future `secretKey` enum values: a new value (for example a future `required-v2`) must be explicitly added to the supported read set before any writer emits it.

## 8. Local Database Specification

Use IndexedDB. Do not use localStorage or sessionStorage.

Database name: `enoteweb`.
Database version: `2`.

### `vault` Store

Contains the draft — the single browser-local encrypted document of Dropbox Mode — under key `"primary"`, plus the Local File Mode recovery copy under its own key (`"local-file-recovery"`).

```ts
type VaultRecord = {
  key: "primary" | "local-file-recovery";
  envelope: string;
  activeProvider: "local-file" | "dropbox" | "draft";
  createdAt: string;
  updatedAt: string;
  appVersion: string;
};
```

The `"primary"` record is the draft. Dropbox file caches do NOT live here — they
live in the `dropboxFile` store below. The Local File Mode recovery envelope is
written only under `"local-file-recovery"`, never under `"primary"`, so using or
switching to Local File Mode can never overwrite an un-exported draft. Exactly
one record may exist per key. No `"primary"` record means no draft exists — the
home's `New draft` state (Section 10).

### `file` Store

Contains non-sensitive Local File Mode state.

```ts
type LocalFileRecord = {
  key: string;
  active: boolean;
  createdAt: string;
  displayName: string | null;
  displayPath: string | null;
  handle: FileSystemFileHandle | null;
  lastSavedEnvelope: string | null;
  lastModifiedAt: string | null;
  updatedAt: string | null;
  permissionState: "unknown" | "granted" | "denied" | "prompt";
};
```

The `file` store may contain multiple recent local file records. Records are displayed in creation order. Exactly one record is active when records exist; if the active record is removed, the app selects another remaining record or clears the active state when the list is empty.

The file handle may be persisted only if the browser supports storing it safely in IndexedDB. If the handle cannot be persisted or permission is lost, the app asks the user to reopen the encrypted file. When adding a file, the app should use browser-supported same-entry comparison, when available, to replace older recent records that point to the same physical file. `displayPath` may be a browser-exposed path, a root-relative folder path derived from the user-selected path root, or a fallback label when the path is unavailable; `lastModifiedAt` is metadata from the browser-provided `File.lastModified` value when available.

### `sync` Store

Contains account-level Dropbox state only. Per-file sync state lives in the `dropboxFile` store below.

```ts
type SyncRecord = {
  key: "dropbox";
  linked: boolean;
  accountId: string | null; // owner of the recent files/caches; survives Unlink and auth loss (Section 9)
  accountLabel: string | null; // account email (users/get_current_account, account_info.read; falls back to display name, then accountId); survives Unlink and auth loss so Settings and Link can name the previous account (Section 9)
  authLost: boolean; // true after an INVOLUNTARY token clear; distinguishes the authorization-lost block state from voluntary Unlink (Section 9). Cleared by a successful link and by Unlink.
  pendingAccountSwitch: string | null; // the newly linked account id while the account-switch guard is unresolved (Section 9); every Dropbox operation refuses until the guard's discard/cancel resolves it
  pendingAccountSwitchLabel: string | null; // best-effort email/display label for the pending new account; shown in the guard dialog, never used to relabel retained old-account caches before Continue
  accessTokenExpiresAt: string | null;
  codeVerifier: string | null;
  oauthState: string | null;
  refreshToken: string | null;
  selectedFileKey: string | null; // the persisted recent-files selection (Section 9)
};
```

### `dropboxFile` Store

One record per file in the home recent-files list (Section 9). All document snapshots are encrypted envelope strings.

```ts
type DropboxFileRecord = {
  key: string; // the raw Dropbox file id (Dropbox ids are self-prefixed "id:..." already — never add another prefix)
  name: string;
  pathDisplay: string;
  pathLower: string;
  envelope: string | null; // encrypted local cache; null = listed but not currently cached
  baseRev: string | null;
  lastSyncedEnvelope: string | null;
  lastSyncedContentHash: string | null; // Dropbox content_hash of the last-synced envelope — lets the background check (Section 9) recognize a metadata-only revision bump without a download; null on records written before the field existed (the check falls back to download-and-compare)
  pendingLocalEnvelope: string | null; // non-null = unsynced local changes
  syncedModifiedAt: string | null; // Dropbox `client_modified` of the last-synced REMOTE version, second-precision UTC ("YYYY-MM-DDTHH:MM:SSZ"); shown as the `Last synced` column. Null until the record syncs at least once. This is a display value only — the "has the record ever synced" question (the `status()` synced-vs-linked string) is answered by `lastSyncedEnvelope`/`baseRev`, NOT by this timestamp.
  localModifiedAt: string | null; // the working copy's own modified time, second-precision UTC; shown as the `Last modified` column. Set to the local write time on ANY local change that rewrites the stored envelope (stamped only after encryption succeeds, as part of the durable cache write), and to the adopted remote `client_modified` on a clean download/adopt. Equals `syncedModifiedAt` while the record is clean/synced; newer while unsynced local changes exist.
  lastOpenedAt: string; // recent-list order, newest first
  createdAt: string;
  updatedAt: string;
};
```

Invariants and lifecycle:

- Every local cache belongs to exactly one record; a record may exist with `envelope: null` (the cache was cleared or never populated), in which case the next online `Open` downloads and re-caches the file. The recent-list entry and the cache are deleted together (`Delete from list`, Section 9); nothing else deletes a cache. The per-file `Export` actions (Section 9) require a cached envelope and are disabled for a record with `envelope: null`.
- The store holds a **target cap** of 20 records (deliberately not a hard invariant): inserting beyond the cap evicts the oldest-opened record that has no unsynced local changes (deleting its cache with it); a record with unsynced changes is never evicted silently. If every record beyond the cap holds unsynced changes, the list temporarily exceeds 20 rather than destroy data.
- `name`, `pathDisplay`, and `pathLower` are display metadata owned by Dropbox and refreshed by the background check (Section 9). Records are keyed by file id precisely so remote renames and moves update rows instead of orphaning them.
- `syncedModifiedAt` is the `client_modified` of the remote version the cache is currently synced to (NOT a device clock): it is set from the metadata of a successful upload (where it equals the `client_modified` the upload sent — see the Basic Sync Flow) and of a successful download/adopt (the first download at open, the stale-but-clean refresh). It never moves on a mere metadata probe or on merely re-opening an unchanged file, so the `Last synced` column reflects the synced VERSION's age, not when the app last checked. (A record whose timestamp is still null may have it filled from the remote `client_modified` the first time the app downloads/adopts that version; a non-null value is never moved by a no-op probe.)
- `localModifiedAt` is the working copy's own modified time. Any local change that rewrites the stored envelope sets it to the local write time — a content edit, a password change, or toggling the in-file read-only flag (Section 7) — mirroring how each of those changes a file's modified time on a desktop filesystem. (A Secret-key mode conversion is not a separate trigger: it only ever happens as part of a save that is already a modification — an autosave or Change Password.) A clean download/adopt instead sets it to the adopted remote `client_modified`, so a file edited only on another device shows that device's modified time. The timestamp is stamped only after encryption succeeds and is written as part of the durable cache write, so a deferred or retried upload reuses the STORED value (the moment of the edit), never the retry time. All stored timestamps are truncated to whole seconds in UTC, so the value the app stores, the `client_modified` it uploads, and the value Dropbox echoes back all match exactly — `Last modified` equals `Last synced` whenever the record is clean.
- A file's unsynced state is `pendingLocalEnvelope` being non-null. The conflict and not-found indicators (Section 9) are session memory derived from the background revision check — they are never persisted, in any field.

### `settings` Store

Contains editor preferences, local storage settings, the default KDF policy for future password dialogs, and the optional local Secret key.

```ts
type SettingsRecord =
  | { key: "theme"; value: "system" | "light" | "dark" }
  | { key: "lineWrap"; value: boolean }
  | { key: "editorMode"; value: "plain" | "markdown" }
  | { key: "fontFamily"; value: string }
  | { key: "fontSizePx"; value: number }
  | { key: "spellcheck"; value: boolean }
  | { key: "autocorrect"; value: boolean }
  | { key: "autocapitalize"; value: "off" | "none" | "sentences" | "words" | "characters" }
  | { key: "autoLockMinutes"; value: number }
  | { key: "randomStringLength"; value: number }
  | { key: "recentsColumnOrder"; value: { dropbox?: string[]; local?: string[] } } // per-home recent-file column order, keyed by stable column ids (`name`, `path`, `timestamp` for Local; `name`, `path`, `synced`, `modified` for Dropbox). Missing, duplicate, unknown, or wrong-length orders are ignored and that table's default order is used.
  | { key: "recentsColumnWidths"; value: { dropbox?: number[]; local?: number[] } } // per-home column-width fractions that sum to 1, one entry per column in the active order (the Local home has 3 columns, the Dropbox home 4 since the `Last modified` column). The two homes do not share one vector. Any stored value of the wrong shape, or a vector whose length does not match the active table's current column count, is ignored and that table's defaults are used.
  | { key: "showWhitespace"; value: boolean }
  | { key: "kdfPolicy"; value: "standard" | "strong" }
  | { key: "secretKey"; value: string | null }
  | { key: "storageProvider"; value: "local-file" | "dropbox" }
  | {
      key: "localFilePathRoot";
      handle: FileSystemDirectoryHandle | null;
      name: string | null;
      updatedAt: string | null;
    };
```

Settings must never include document text, password, search history, replacement history, tokens copied into document text, or plaintext sync content. The `kdfPolicy` setting is not secret; it selects the default hardening value for future password-choosing dialogs, not a live write policy for opened documents. The `secretKey` setting is the only sensitive setting value: it is local-only key material (Section 6), must be omitted from diagnostics/logs/exported state, and must be cleared only by the user's explicit `Clear` action or by deleting the app/browser's site data.

## 9. Dropbox Provider Specification

Dropbox Provider is the default durable storage mode on iOS and Android. It is optional on Windows because Windows defaults to Local File Mode. Dropbox Provider uses Full Dropbox access: the user opens any encrypted `.txt`/`.text` file anywhere in their Dropbox through the in-app Dropbox file browser (below), and every file opened this way joins the home recent-files list with its own local cache (Section 8). There is no single "active remote document" — each recent file syncs independently while it is the open editor session, and the recent-files table's persisted selection only feeds the home `Open` action.

An opened Dropbox path may be any user-approved Dropbox path supported by the app's Dropbox permissions. The app stores per-file metadata such as Dropbox file id, display path, lowercase path, filename, and current revision (Section 8). The UI must show a file's Dropbox display path where relevant. Each remote file's content is exactly one encrypted envelope. Dropbox must never receive plaintext, plaintext diffs, plaintext merge bases, or plaintext conflict files.

### OAuth And Tokens

- Use Dropbox OAuth appropriate for browser apps, with PKCE.
- Use the PKCE authorization-code flow without a client secret (a static web app cannot keep a secret).
- The OAuth redirect URI is a fixed path on the app's own origin (for example `<app-origin>/` or `<app-origin>/auth/callback`) registered in the Dropbox app console. The app must never use a redirect URI that points off-origin, and the redirect target must be a route the app can handle on launch.
- Removing the registered redirect URI from the Dropbox app console does **not** necessarily revoke refresh/access tokens that were already issued, so already-linked installs may continue to edit, sync, and open files until Dropbox invalidates those tokens for some other reason. It **does** prevent starting or completing a new Link/Relink OAuth round-trip; restoring the exact redirect URI lets linking work again, and retained recent files/caches reappear when the same account is linked. The app treats continued syncing under previously issued tokens as acceptable Dropbox behavior, not as a product guarantee; all token failures must still fall into the normal authorization-lost/relink handling.
- On standalone iOS/Android PWAs the OAuth round-trip typically leaves the standalone window, completes in the system browser, and may not return to the installed app automatically. The callback must be processed on the app's own origin, and the linking flow must tolerate the user reopening the app from the Home Screen/launcher to finish: persist the in-progress PKCE/CSRF material (`codeVerifier`, `oauthState`) so a fresh launch can complete the exchange, and show clear "return to eNoteWeb to finish linking" guidance.
- Request offline access so Dropbox returns a refresh token for future sync sessions.
- Request the minimum permissions needed to let the user choose, read, write, and inspect revisions for their chosen Dropbox `.txt` files. The app is a Full Dropbox app, so the user can open files in any folder; the requested scope set is `account_info.read files.content.read files.content.write files.metadata.read`: `account_info.read` resolves the account **email**, shown in the home Settings dialog and in the link confirmation (below). The scope set is part of the consent, so changing it later would make already-linked grants insufficiently scoped and require a one-time relink.
- Store only the token/session material needed to sync.
- Store the Dropbox refresh token in IndexedDB while Dropbox remains linked.
- Keep access tokens in memory only. IndexedDB may store `accessTokenExpiresAt` as non-secret session metadata.
- Store temporary PKCE and CSRF material in IndexedDB as `codeVerifier` and `oauthState` only while an OAuth redirect is in progress.
- Clear `codeVerifier` and `oauthState` after OAuth callback success, cancellation, or state mismatch.
- Never include tokens in URLs after OAuth callback processing.
- Remove OAuth callback query parameters from the visible URL after processing.
- Capture the Dropbox `account_id` returned by the OAuth token exchange and persist it as `accountId` (Section 8) — the owner of the recent-files list and caches. It is not token material: it survives Unlink and involuntary authorization loss, and is cleared only when the recent files and caches are wiped by the account-switch guard (below). The token endpoint returns the id with no extra scope; the account label (`accountLabel`) is the account **email**, resolved separately via `users/get_current_account` (needs `account_info.read`; falls back to the display name, then the `account_id`, best-effort). `accountLabel` is kept across Unlink and authorization loss so Settings and the next `Link` can name the previously connected account.
- Unlink removes Dropbox token/session material only; the recent-files list, the per-file caches, `accountId`, and the draft are left intact (see Authorization Loss, Unlink, And Account Switching below).

### Dropbox File Browser

Choosing a Dropbox file or destination happens through an in-app file browser dialog, not a typed-path prompt. It is built on the Dropbox folder-listing API the app is already scoped for (`files.metadata.read`) — never on Dropbox's embeddable Chooser widget, which would require loading a third-party script and an off-origin frame in violation of the CSP (Section 5/16). One dialog serves both destination-picking flows:

- **Open** (the home Browse action): pick an existing encrypted `.txt`/`.text` file. Tapping an eligible file selects it immediately and closes the dialog — no second confirmation step. The file joins (or moves to the top of) the recent-files list as the selected row, and the unlock password dialog (Section 10) then opens directly, with no detour through the home screen. Nothing is discarded by choosing a different file — every recent file keeps its own cache — so no discard warning exists in this flow. Cancelling the password dialog keeps the file listed and selected but locked.
- **Upload** (the destination picker for the editor's **Dropbox** button and the home `Dropbox` promote — Section 4): pick a folder. A filename field at the bottom of the dialog is pre-filled and remains freely editable: a Dropbox-file editor session inherits the current file's parent folder and filename so an unchanged destination is an overwrite path; draft/home promotions use the neutral suggested default filename (`enote.txt`, Section 10). The primary action is `Save` (the dialog title still names the context); it sits to the right of `Cancel`. No password is collected: the upload is a fresh envelope of the current draft/content under its existing password (Section 4). When a deep folder makes the action row overflow, the row scrolls horizontally rather than clipping the buttons, and opens scrolled to its right (primary-action) end — the mirror of the editor toolbar's left-aligned horizontal scroll.

Destination rules (Upload):

- The filename field accepts a single path segment: leading and trailing whitespace is trimmed; the result must be non-empty and must not contain `/`. The extension is no longer required — a name that does not already end in `.txt` or `.text` (matched case-insensitively; `.TXT` is accepted) has `.txt` appended automatically, so saving never fails on the extension. Only an empty or path-bearing (contains `/`) name shows the validation message and blocks the primary action.
- The destination path is the current folder's path, `/`, then the trimmed filename. The root (labeled `Dropbox` in the breadcrumb) contributes an empty prefix, so a file named at the root is `/name.txt`.
- Collision detection compares the destination against the current listing case-insensitively (Dropbox paths are case-insensitive; compare lowercase paths).

List content and ordering:

- Each folder listing shows three groups in a fixed order: subfolders first, then eligible files (names ending `.txt` or `.text`), then every other entry grayed out and inert. Grayed entries exist for orientation — confirming the user is in the folder they think they are — and cannot be selected.
- The list has `Name`, `Modified`, and `Size` columns; folders show name only (Dropbox reports no size or modification time for folders). The browser's `Modified` is Dropbox's `server_modified` (when the file was written to Dropbox's servers) — deliberately a DIFFERENT timestamp from the home recents `Last synced`/`Last modified` columns, which use `client_modified` (Section 8). The two can differ for the same file, and that is expected: the browser ranks files by server write order, while the recents columns show the version's authored modified time. Tapping a column header sorts ascending by that column; tapping the same header again toggles descending. Sorting reorders entries within each group — the group order itself never changes — and entries lacking the sorted attribute keep name order. Every time the browser opens it starts at the default sort (Name, ascending); the sort choice is per-instance and never persisted.
- In Upload mode the same listing is shown so the user can see what already exists at the destination before committing; tapping an eligible existing file copies its name into the filename field (the input), so overwriting one needs no typing — the primary action and the downstream existence/overwrite gate still apply. Ineligible entries remain non-tappable.

Navigation:

- A breadcrumb header shows the current location with the root labeled `Dropbox`; tapping any ancestor segment jumps directly there. On narrow screens, middle segments collapse into an ellipsis segment.
- The browser opens in the folder of the recent-files selection when one exists (in Open mode, with that file visibly marked when present in the listing), otherwise in the folder most recently browsed during this app session, otherwise the root. A remembered start folder that fails to list falls back to the root. The remembered folder is held in memory only.

There is no typed-path entry: the file browser is the single way to choose a file or destination (a previous `Enter path manually` fallback was removed). Choosing therefore always happens against a real folder listing, so a folder that fails to list, is offline, or has lost authorization offers no alternative path-typing escape — the listing's own Retry / offline / relink handling (below) governs.

Overwrite on Upload:

- A filename that collides with an existing file in the destination folder (case-insensitively, per Dropbox path semantics) is allowed but never silent: the app asks for explicit confirmation first — `A Dropbox file already exists at <path>. Replace it with the current document?`. No overwrite upload occurs before that confirmation (Section 4).
- The in-browser collision check is a UI courtesy based on the current listing; the provider-level existence check at upload time remains the authoritative overwrite guard.
- A confirmed replacement must upload revision-conditionally against the revision observed by that authoritative existence check — never as an unconditional overwrite. If the target changed between the check and the upload (for example, another device wrote it), the conditional upload fails as a conflict and the app re-asks the confirmation with fresh metadata instead of silently destroying the newer revision. This closes the check-then-overwrite race.
- The provider therefore exposes the existence check and the replacement as two separate operations: a metadata probe that returns the target's current revision *before* the confirmation is shown, and a revision-conditional replace that consumes exactly that revision. No user-facing flow uses Dropbox's unconditional overwrite write mode.
- When the destination is itself a cached recent file, the confirmation must additionally name the local consequence: the file's local cache is replaced too, and any unsynced local changes it holds are destroyed (Section 4).

Loading, errors, and revocation:

- Every folder navigation lists via the Dropbox API with a visible loading state. Paginated listings are fetched to exhaustion, capped at 10,000 entries with a visible truncation notice (`Showing the first 10000 entries.`). The grouped, sorted list renders only once the listing is complete (all pages, or the cap): rows must never reorder under the user's finger as later pages arrive.
- A failed listing shows the error inside the dialog with a `Retry` action. A failed listing must never render as an empty folder.
- If Dropbox authorization turns out to be expired, revoked, or insufficiently scoped mid-browse — for example, the user revoked the app's access from another device while the dialog was open, or an existing grant lacks `files.metadata.read` — the dialog stops with a message that Dropbox authorization was lost and points the user to relink; the app's overall link state updates accordingly. No automatic retry loop.
- Authorization loss clears only token material (an involuntary unlink). The recent-files list, every per-file local encrypted cache, all unsynced-local sync state, and the stored `accountId` are retained, and the home Dropbox block enters its authorization-lost state (below), so relinking resumes everything with nothing lost. The remembered browse folder is in-memory session state and simply expires with the session.
- The browse-based actions are unavailable while offline or unlinked, with the reason shown; the dialog is never opened into a state that can only fail.

Privacy:

- Folder-listing metadata (names, paths, sizes, timestamps of entries merely *seen* while browsing) is held in memory only, never written to IndexedDB or any other persistence, and is discarded when the dialog closes. The metadata of a file the user actually opens or promotes is intentionally persisted as its `dropboxFile` record (Section 8). Listing requests go only to the Dropbox API endpoints already allowed by the CSP.

Interaction:

- Rows meet the app's minimum touch-target size on mobile. On desktop the dialog is keyboard-operable (arrow keys move the row focus, Enter descends into a folder or selects a file, Escape cancels) and traps focus while open, like the app's other dialogs.

Non-goals for the initial version: no server-side filename search, no new-folder creation (folders are created in Dropbox's own UI), no offline/cached listings.

### Recent Files And The Home Dropbox Block

The Dropbox block at the top of the Dropbox-Mode home (Sections 4 and 15) has three states. (Unlinked and authorization-lost both end with `linked: false`; the persisted `authLost` flag — Section 8 — is what distinguishes involuntary authorization loss from voluntary Unlink.)

- **Unlinked**: a `Dropbox` heading and a `Link` action. If recent-file records exist, the recent-files table stays visible; `Browse` is visible but disabled, and `Open` opens the selected cached envelope under an **app-imposed read-only lock**. That lock is above the file's own read-only flag: it never changes the encrypted metadata flag, and it disables editing, autosave, sync, password changes, destination promotions, and the in-file read-only toggle, while still allowing cursor movement, text selection, copying (including line-number copy), search/navigation, Home, settings, and Export from the editor. The toolbar lock icon and Settings checkbox keep showing the file's real read-only flag, but are disabled/greyed while this app lock is active. `Open` is disabled for a row with no cached envelope. When a retained Dropbox grant still exists for the remembered account, `Link` first asks `Continue with <account>?` (below); if no grant is retained, it starts OAuth directly even when old recents remain.
- **Linked**: a small `Sync` action (icon button, styled like `Browse`) in the block's upper-right corner — it forces the background revision check / sync on demand (otherwise that pass runs only on entering the Home screen and on regaining connectivity, below) — the recent-files table, and a `Browse` plus `Open` action row. `Browse` opens the Dropbox file browser in Open mode; `Open` acts on the table's selected row and is disabled when the table is empty or no row is selected. `Unlink` is no longer in this block: it moved to the Home Settings dialog (Section 15), shown only while Dropbox is the selected, linked provider.
- **Authorization lost** (involuntary — above): the corner action reads `Relink` (the same begin-link action as `Link`; there is no separate relink mechanism anywhere in the app), the recent-files table stays visible, `Browse` is visible but disabled, and `Open` becomes `Export`, which downloads the selected row's cached envelope through the platform export flow (Section 10) with no password step (`Export` is disabled for a row with no cached envelope — Section 8). Cached files cannot be opened for editing while authorization is lost — the cache is a waypoint, not a second vault, and browser storage is too evictable to hold the only copy of new edits. The recovery path for a permanently dead link is `Export` → `Import` (into the draft) → promote. Unsynced changes made *before* the loss are retained and resume syncing after a successful relink.

Recent-files table:

- Columns: `Name` (filename only), `Path` (the file's folder path; an overflowing cell truncates from the LEFT — ellipsis at the start — so the direct parent folder name always stays visible at the right edge), `Last synced` (`syncedModifiedAt` — the Dropbox `client_modified` of the synced remote version, NOT a device clock; an em-dash when never synced), and `Last modified` (`localModifiedAt` — the working copy's own modified time; an em-dash when unknown). `Last synced` and `Last modified` read the same while the row is clean/synced; `Last modified` is the newer of the two whenever the row has unsynced local changes (the same condition as the `•` prefix). A missing row keeps the real folder path in `Path` and shows `Not found` in `Last synced`.
- Order: most recently opened first (`lastOpenedAt`). Capacity and eviction follow the Section 8 rules (a target cap of 20; never silently evict unsynced ones).
- The selected row is persisted (`selectedFileKey`, Section 8) like a settings value. Deleting the selected row clears the selection (disabling `Open`).
- Rows are added by opening a file through Browse, and by draft promotion (the new file enters at the top, selected). Opening an already-listed file moves it to the top.
- Tap-and-hold a row (touch) or right-click it (desktop) opens a row menu with `Delete from list`: after confirmation it removes the record AND deletes its local cache; it never deletes the file from Dropbox. When the cache holds unsynced local changes, the confirmation must say so explicitly (those changes are destroyed). The long-press must suppress the platform text-selection/callout behavior on iOS.
- Per-row session indicators (derived by the background check below; never persisted): a **diverged** row renders in the attention (red) treatment with a `•` prefix attached directly (no separating space) to a **bold** name (`•notes.txt`), and while it is the selected row the `Open` action reads `Resolve`; a **replacement-candidate** row (the stored id is gone, but an eligible different file exists at the exact same stored path/name) uses the same red `•`/bold/`Resolve` treatment but is resolved by an adoption confirmation rather than by immediately opening the merge flow; a **missing** row renders grayed with `Not found` in its `Last synced` cell, and `Open` reads `Export` for it; an **ineligible-name** row (renamed remotely outside `.txt`/`.text`) renders grayed with its real current name and path shown, and `Open` likewise reads `Export`. Color is never the only signal — the `•` prefix, the bold name, the `Not found` timestamp text, and the visibly ineligible name carry the state. `Export` is disabled when the record has no cached envelope (Section 8). Independently of these network-derived indicators, a row whose record has **unsynced local changes** carries the same bold name and attached `•` prefix in the normal text color (not the red diverged/replacement-candidate treatment); this flag is persisted, so the dot also shows offline. A diverged row is itself unsynced, so its prefix is the red one.
- Remote renames and moves are absorbed silently: records are keyed by file id, the by-id probe returns the current name and path, and the row simply updates (the background check below). The table needs no rename affordance, and the only user-facing row states are: normal, diverged (red, `Resolve`), replacement-candidate (red, `Resolve` with adoption confirmation), missing (gray, `Not found`, `Export`), and ineligible-name (gray, `Export`).

Cache-record invariant (Section 8): every cache belongs to a recent-list record; a record may exist without a cache, in which case the next online `Open` downloads and re-caches the file before the password dialog. `Open` on an uncached record while offline reports the offline state instead of opening.

### Background Revision Check, Freshness, And Conflict Indicators

When the Dropbox-Mode home loads while linked and online (app launch, returning Home from the editor, regaining connectivity), the app starts a background revision check over the recent-files records — a metadata probe per record, addressed by the record's Dropbox **file id**. Ids are stable across renames and moves, so the probe finds the file wherever it now lives and whatever it is now called. The check must never block or slow user actions: `Open` works immediately from cache, and indicator changes arrive asynchronously (a row may change state while the user is looking at it; that is by design, not a defect).

The probe result is processed in a fixed order, so the outcomes below cannot race each other: first **missing / replacement-candidate** (the id fails to resolve, then the stored path is checked for an exact eligible different-id candidate); then **metadata adoption and eligibility** (the record adopts the current name/path, and an ineligible extension blocks every sync action for the record — no pending push, no refresh — rendering it export-only); then **content equality** (a revision difference whose content is unchanged is metadata-only — see Moved or renamed); and only then the revision/pending classification (up to date / pending push / stale-but-clean / diverged).

Per-record outcomes:

- **Up to date** (remote revision matches `baseRev`, no unsynced local changes): no indicator.
- **Pending push** (remote revision matches `baseRev`, unsynced local changes exist): flush the pending envelope with a revision-conditional upload, so offline edits to files that are not currently open reach Dropbox from the home check. A conditional failure reclassifies the record as diverged.
- **Stale-but-clean** (remote changed, no unsynced local changes): NOT a conflict, never marked red. The app refreshes the cache by downloading the new envelope — in the background, or at the latest on the next online `Open`, before the password dialog (a visible loading moment is acceptable). No password is needed; the refresh is envelope-level.
- **Diverged** (remote changed AND unsynced local changes): the conflict indicator above. Before surfacing this state, a Home sync/check may download the remote envelope to rule out a stale conflict; if the remote ciphertext already equals the pending local ciphertext, the record is marked synced and the indicator clears without opening the merge flow or decrypting. `Resolve` first opens the unlock password dialog — the merge flow decrypts local, remote, and base, so it needs the password — and then enters the merge flow (below). Resolution requires being online: while offline the indicator is simply not shown and resolution is deferred; the remote envelope is not downloaded and saved locally just to enable offline resolution.
- **Moved or renamed** (the by-id probe returns metadata whose name or path differs from the record): not an indicator state. The record and its row silently adopt the current name and paths — the user sees the row update, never `Not found`. If the new name leaves the `.txt`/`.text` contract (for example `notes.txt` → `notes.md`), the row instead renders grayed like the missing state, with its real current name and path shown, and `Open` reads `Export`: the app must never sync to an ineligible path (Section 7), and a later rename back to an eligible name restores the row on the next check. Whether a pure move/rename bumps the remote revision is verified at implementation time, and a revision bump without a content change must never surface as a conflict: when the probed `content_hash` (or the downloaded remote envelope) matches the last-synced state, the change is metadata-only — the record adopts the new revision as `baseRev` without touching the cache or pending state, and a pending push may then proceed.
- **Replacement candidate** (the id no longer resolves, but an eligible Dropbox file with a different id exists at the exact stored lower path, including the same filename and extension): the conflict-like indicator above. The check is report-only and never rewrites the id silently. `Resolve` asks `A different file exists under the same name at this path. Do you want to adopt it?` If the user cancels, the cached envelope opens under the app-imposed read-only lock when a cache exists (otherwise there is no cached copy to open). If the user confirms, the provider re-probes the old id and the exact path; only if the old id is still missing and the candidate still matches does it rewrite the record to the candidate's file id. If the cached ciphertext is absent or already equals the candidate's Dropbox ciphertext, the row becomes synced to the candidate. If the cached ciphertext differs, the app records a normal Dropbox conflict with no trusted base snapshot (the deleted file is not the candidate's ancestor), then opens the same merge flow used for diverged rows.
- **Missing** (the id no longer resolves and no exact same-path replacement candidate exists — the file was deleted remotely): the not-found indicator above. Session-only: a restore from Dropbox's trash returns the row to normal on a later check. The cached envelope remains exportable; content that must survive goes `Export` → `Import` → promote.
- **Probe failure** (network or server error): no indicator change.

Home sync feedback: pressing the Dropbox block's `Sync` action runs the selected-file sync plus the recent-row checks. It shows `Up to date.` only when the pass succeeds and no cache, record metadata, selected row, unsynced flag, or session indicator changes. It shows `Sync complete.` when the pass succeeds and anything user-visible changes, including a cache refresh/push, a missing/diverged/replacement-candidate/ineligible indicator appearing, or a stale indicator clearing. The automatic home/background pass shows `Sync complete.` only for the same changed case; a no-op background pass stays quiet.

Opening before the check finishes is allowed by design — the user may open an "old" cache. The editor then applies the **first-sync gate**:

- In a Dropbox file session, autosave to the local cache starts immediately, but the FIRST push to Dropbox waits until a revision check for that file passes — either the background check's result or the push's own revision-conditional rejection serves as the check.
- If the file turns out to be remotely changed, the editor shows the **Resolve banner** (`File changed on Dropbox.`) and stops pushing (autosave to cache continues). If the user exits without having modified the document, the row never shows a conflict; the cache is refreshed per stale-but-clean above and the next open is fresh. If local modifications exist, the editor's **Resolve banner** becomes the conflict-resolution entry point (Section 4); exiting instead returns Home, where the row carries the diverged indicator while online.

### Authorization Loss, Unlink, And Account Switching

- **Involuntary authorization loss** (expired, revoked, or insufficiently scoped — detected at token refresh or mid-API-call): clears token material only. The recent-files list, caches, unsynced state, the draft, and `accountId` are retained. The home Dropbox block enters the authorization-lost state (Relink / Export-only, above).
- **Unlink** (the user's explicit action): lives in the Home Settings dialog (Section 15), not the Dropbox block. If every cache is synced to the app's best knowledge, Unlink proceeds without a warning. If any cache has unsynced local changes, Unlink first asks for confirmation via an in-app modal (not `window.confirm`) and warns that those edits will not sync until Dropbox is linked again. A voluntary Unlink pauses the link (`linked: false`) but retains the refresh token, recent-files list, caches, `accountId`, and `accountLabel`. Cached rows remain visible on Home and open only under the app-imposed read-only lock above.
- **Link with retained authorization** (pre-OAuth, distinct from the post-OAuth guard below): because voluntary `Unlink` keeps the retained Dropbox grant, pressing `Link` while that grant exists first shows `Continue with this account?` with `Cancel` / `Switch` / `Continue`. The prompt says the app has authorization for `<email>` and asks the user to continue with that account or switch to another. `Continue` redirects with `force_reapprove=true` and no forced reauthentication, so Dropbox can reuse the retained grant/session when it is still valid. `Switch` first forgets only the retained grant (not recent files/caches) and then redirects with `force_reapprove=true` and `force_reauthentication=true`, forcing Dropbox's sign-in/account-selection step. If no retained grant exists, even with old recent files, `Link` starts OAuth directly with no remembered-account prompt. The post-OAuth account-switch guard below remains authoritative for every returned account id.
- **Account-switch guard** (post-OAuth): when a link completes, the app compares the OAuth-returned `account_id` against the stored `accountId`. Equal: proceed. No stored id (an install with recent files but no stored `accountId`, Section 8): ownership cannot be verified, so when recent files exist the app shows a one-time confirmation naming the linked account before any sync runs — it cannot prove the match, only make the assumption visible — and then stores the id. Different: the existing recent files and caches belong to another account, and Dropbox paths must never cross accounts (a same-named path in the new account is a different file — syncing old caches against it could overwrite the new account's data). The app shows a blocking choice: switch to the new account, wiping the previous account's recent files and caches, or cancel — which stays unlinked and leaves the previous account's data intact for a later relink to that account. "Blocking" is enforced in the provider, not just the UI: while the mismatch is unresolved (`pendingAccountSwitch`, Section 8), every Dropbox operation — sync, download, upload, listing — refuses. The returned refresh token is stored in the normal token slot, but it is unusable while `pendingAccountSwitch` is set. `accountId` and `accountLabel` remain the previous owner until Continue. `Cancel` clears the returned token and pending label/id while leaving the previous owner/caches intact; `Continue` wipes the previous recents/caches and adopts the pending id/label as `accountId`/`accountLabel`. The guard dialog shows the pending account's email/display label when available, falling back to the id only when Dropbox account-info lookup fails; it says `This is a different Dropbox account. Continue with <account>?` and appends `Cached files from the previous account will be lost.` only when cached envelopes actually exist. The draft is never wiped by an account switch.
- There is no `Relink` button in the linked state: relinking is `Unlink` + `Link`, and the authorization-lost state's `Relink` label is the same begin-link action.

### Basic Sync Flow

1. User opens a Dropbox file from the home recent-files list; the editor session works from that file's local cache.
2. App checks Dropbox link status, the file's sync state, and network availability. (If Dropbox is voluntarily unlinked, cached files are openable only under the app-imposed read-only lock; if authorization is lost, rows are export-only. Only the draft and Local File Mode remain normally editable.)
3. If linked and online, app reads the file's remote metadata and revision — the background revision check may already have supplied this (the first-sync gate, above).
4. If the file id no longer exists or no longer resolves, first check the stored path for the replacement-candidate case above. A same-path different-id file is adopted only after user confirmation; otherwise surface the missing state. Never silently create or bind to a replacement at the old path.
5. If remote revision equals the file's `baseRev` and unsynced local changes exist, upload the latest encrypted local envelope using revision-conditional update; with no unsynced changes there is nothing to upload (a check must never create a needless Dropbox revision).
6. If remote revision differs from `baseRev` (or `baseRev` is null or unrecognized) and the file has NO unsynced local changes, download and adopt the remote envelope — the stale-but-clean refresh above; no merge and no conflict. Adopting the remote envelope sets BOTH `syncedModifiedAt` and `localModifiedAt` to the adopted remote `client_modified`, so a file edited only on another device shows that device's modified time in both columns. Adoption happens only while no editor session has the file open (home contexts): an open session's cache and `baseRev` are never swapped underneath it (the first-sync gate above), so an in-session sync leaves a stale-but-clean record untouched — still no conflict — and the next home pass refreshes it.
7. If remote revision differs from `baseRev`, or `baseRev` is null or no longer matches any revision Dropbox currently recognizes for the file, AND unsynced local changes exist, download the remote encrypted envelope and enter the merge flow. A `baseRev` that Dropbox no longer recognizes — for example after the remote file was rewritten, replaced, or its revision history pruned while this device was offline for a long time — must be treated as a conflict, never as a fast-forward upload. The app must not upload over a remote revision it cannot relate to its own `baseRev`.
8. The upload sends Dropbox `client_modified` equal to the record's `localModifiedAt` (formatted as second-precision UTC, `YYYY-MM-DDTHH:MM:SSZ` — Dropbox rejects sub-second precision), so the synced revision carries the working copy's real modified time rather than the upload instant. After successful upload, store the returned Dropbox file metadata and revision on the file's record, set `lastSyncedEnvelope` to the uploaded envelope, clear `pendingLocalEnvelope`, and set `syncedModifiedAt` to the uploaded `client_modified` (the returned metadata echoes it back) while leaving `localModifiedAt` unchanged — so the `Last synced` and `Last modified` columns now match.

Only clear pending local state after Dropbox confirms upload success and the new revision is stored.

An online autosave **pushes** the encrypted envelope to Dropbox through `provider.save()` (a revision-conditional upload), so edits reach Dropbox without a manual tap. What is **not** run on every autosave is the fuller `syncNow()` cycle (push **plus** a remote-revision check that can surface a conflict/merge); that fuller sync runs from the **Home Sync action**, when the device regains connectivity (offline→online), when the Dropbox-Mode home is shown — after locking from the editor (Home) or reopening the app — and when the editor **regains focus/visibility** (the lightweight remote-change check, Section 4); it flushes the file's offline-pending edits and also starts the background revision check (above) over the rest of the recent files. There is no editor Save / sync-now button (Sections 4 and 15) — the editor surfaces a remote change through the **Resolve banner**, not an active/inactive Sync control. The visible Dropbox sync status (the toolbar pill and the footer label) is a single shared derivation: it reads **Synced** only when the current document is both locally saved and Dropbox-synced (Dropbox status `ready` and the local save state is not dirty/saving/error), **Unsynced** whenever local edits are not yet on Dropbox (unsaved, an in-flight save/upload, a queued pending sync, or a failed autosave), and otherwise the specific blocked state — **Offline**, **Conflict**, or a link/attention prompt. All mutating Dropbox operations (sync, promotion upload) run through a single serialized queue so they cannot overlap.

### Offline Editing

When a Dropbox file session is open and the device is offline or sync fails:

- Continue allowing edits.
- Autosave the encrypted local envelope to the file's cache (Section 8).
- Store the latest encrypted unsynced envelope in the file's `pendingLocalEnvelope`.
- Show sync status `Unsynced` or `Offline`.
- Retry sync when the app regains connectivity, on the Home Sync action, or when the Dropbox-Mode home or the editor regains focus/visibility.

### Merge Strategy

The app does not store Git-style plaintext diffs. It stores encrypted base snapshots and encrypted pending snapshots.

The merge flow is **user-initiated**: a revision conflict surfaces a passive indicator with a
Resolve action, and nothing is uploaded until the user enters the flow. The entry points are
the editor's contextual **Resolve banner** (below) and the home recent-files `Resolve` action;
entering from the home collects the password in the unlock dialog first, since
the merge must decrypt local, remote, and base. When the flow opens while online it re-downloads the remote side first, so the merge always reflects the current remote rather than an earlier captured snapshot (a remote that changed again after the conflict was first recorded); offline, it falls back to the last captured snapshot. Once entered:

1. Decrypt `lastSyncedEnvelope` in memory as base text.
2. Decrypt `pendingLocalEnvelope` or current local envelope in memory as local text.
3. Decrypt downloaded remote envelope in memory as remote text.
4. Run a three-way text merge: base, local, remote.
5. If merge is clean, encrypt merged text into a fresh envelope and upload with a Dropbox
   revision-conditional update — without further per-hunk review.
6. If merge has conflicts, show the conflict editor.

If a needed side cannot be decrypted with the current password, do not merge: the remote being
unreadable offers a revision-conditional **Keep local** (overwriting the unreadable remote) and a
ciphertext-only **Keep remote** (adopt the captured remote encrypted envelope as the local
cache/base, clear the pending local conflict, then leave the editor so the user can unlock with
the remote copy's current password), plus encrypted export of both copies. A missing remote offers
retry and encrypted local export.

If no usable base snapshot is available — `baseRev` is null or unrecognized by Dropbox and no `lastSyncedEnvelope` can be decrypted — run the merge as a two-way comparison between local and remote text against an empty base. This surfaces all differing regions as conflicts rather than silently preferring one side, so the user resolves them explicitly in the conflict editor.

Conflict editor requirements:

- Presented as an inline merged view: auto-merged clean text in document order, with each
  remaining conflict shown in place as a resolvable block.
- Clearly show local, remote, and merged/conflicted regions.
- Allow accepting local, accepting remote, keeping both (local lines then remote lines), or manually editing merged text. Each choice is available per conflict, and bulk actions can apply accept-all-local (`Keep local`), accept-all-remote (`Keep remote`), or keep-both-for-all (`Take union`). The bulk actions work at any point in the flow, including before every conflict has an individual choice, and they replace all current choices.
- The Save action stays disabled until every conflict has a resolution (whether chosen individually or by a bulk action); a leftover resolution set from an earlier merge must never make Save appear ready. Save resolved text as a normal encrypted envelope.
- Upload resolved encrypted envelope (revision-conditional) after user confirms.
- Offer encrypted export of local and remote versions before overwriting anything.

Plaintext base/local/remote/merged text must not be written to IndexedDB, and must be dropped
from memory when the app locks or the editor is cancelled.

### Editor Resolve banner and remote-change detection

With no editor Save button, the in-editor entry point to conflict resolution is a contextual
**Resolve banner**: *"File changed on Dropbox — Resolve."* It is driven by the session's stored
sync state (above), not only a live failure, so it covers every way a conflict arises: the
**first-sync gate** (opening a cache the background check already knows is remotely changed —
pushing is paused *before* any 409), a **diverged** result from the home/background check, and a
**409** on an autosave's conditional upload. Whenever that state is set the banner shows; when it
clears (resolved or refreshed) the banner goes away. Online, tapping it opens the merge flow
(collecting the password if needed, like the home `Resolve`); offline, the banner explains that
resolution needs a connection while editing continues and autosave keeps writing the **local
cache only** (paused), so nothing is lost. **Export stays available throughout**, so a conflicted
session can always download an encrypted copy of the current local text. A conflict therefore has
two exits and an escape: the **Resolve** banner (three-way merge), the editor's **Dropbox button →
the session's own file** (force-push "my version," Section 4), or **Export** (take a copy, resolve
later). The home recent-files `Resolve` action is unchanged.

Removing the Save button also removes the explicit in-editor "check the remote now." Remote changes
are detected through **automatic triggers** instead of a button: autosave's revision-conditional
push (a remote change → 409 → diverged), and the background check on **reconnect**, on **going
Home**, and on the editor **regaining focus / visibility** (returning to the tab or app runs a
lightweight check). The Line-2 sync pill (**Synced / Unsynced / Offline / Conflict / Needs
attention**) reflects the result. **Accepted limitation:** a session that is only *viewed* (no
edits) between those triggers will not notice a remote change until the next trigger fires — there
is no continuous polling.

## 10. User Flows

### Create (New Draft)

Home creation is local-first by design in both storage modes: the only home creation action is `New draft`, and the only way a new Dropbox file comes into existence is promoting a draft (the editor's **Dropbox** button or the home `Dropbox` promote — Sections 4 and 9). There is no home-level provider-specific "create file" action.

`New draft` (shown when no draft exists — see Draft And Files Actions below):

1. Open the create-password dialog — a password field plus a confirmation field that must match (`Passwords do not match.` blocks creation), followed by `Use strong password hardening`, then `Use secret key` (Section 6). Password dialogs provide an app-provided show/hide control — an eye icon (open = reveal, closed = hide) — to verify the exact string without relying on native password-field behavior that can suppress non-Latin input methods. The hardening toggle initializes from the Home Settings default and warns if it is turned on from Standard. The Secret-key toggle is enabled and on by default when a local Secret key is configured, so the new draft is created as `required-v1`; when none is configured it is shown disabled and off, so the draft is created as `none`. Cancelling the dialog creates nothing.
2. Create an empty plaintext document, encrypt it immediately using the hardening and Secret-key choices from the dialog (Section 6), store it as the draft (Section 8), and open the editor in a draft session.

The draft deliberately has no destination step — it is browser-local by definition, and its destination is chosen later, at promotion or by exporting/downloading an encrypted copy.

### Unlock

If an encrypted document exists for the active provider:

1. Show locked screen.
2. In Local File Mode, show the **Local files** block (recent-file table, `Set path root`, `Browse`, and `Open`) plus the shared draft/Files actions. In Dropbox Mode, show the home described in Sections 4, 9, and 15: the Dropbox block (recent-files table, `Browse`/`Open`) and the same draft/Files actions. `Open` (or a one-tap Browse selection) leads to the unlock password dialog; `Edit draft` likewise.
3. Load the encrypted envelope: the selected local file in Local File Mode; the file's local cache (or the draft record) in Dropbox Mode. A Dropbox file known stale-but-clean is refreshed by download before the password dialog when online (Section 9); an uncached recent file is downloaded first and requires being online.
4. Ask for the password in the unlock password dialog (a single field), opened by the Unlock/Open action. There is no always-visible password field on the locked/home screen; every password is collected in a dialog. When the file being opened requires a Secret key (`secretKey: "required-v1"`), the dialog adds a `Secret key` disclosure below the password field that reveals an editable Secret-key field pre-filled with the configured key (Section 6): it is collapsed by default when a local key is configured (pre-filled with that key) and expanded by default when none is configured (empty). Focusing the field selects its current contents, so a tap makes it paste-ready — a paste replaces the pre-filled key wholesale. The field's value is **authoritative** for the unlock: the pre-filled Settings key is used unless the user edits it, and submitting with the field empty prompts for the key (Section 16) rather than silently falling back to the Settings key. The key entered here is used only for this unlock and the resulting session — it is never written to the Settings key, and the raw typed string follows the same input hygiene as the password field (no autocomplete/autocorrect/autocapitalize/spellcheck) and is cleared from dialog state on success, cancel, or close. A `none` file's unlock dialog is unchanged (password only).
5. Attempt decrypt.
6. On success, load plaintext into CodeMirror.
7. On failure, show the applicable Section 16 unlock failure inside the dialog, which stays open with the field selected for retry; Cancel/Escape closes it and changes nothing.

The UI must not reveal whether failure was caused by wrong password, wrong Secret key, corruption, unsupported metadata, or authentication failure.

The password dialogs (both unlock and create) are real forms: pressing Enter / the mobile keyboard's Go key submits the primary action — on iOS Safari, native form submission is what fires there, not a keydown on a lone input. The primary action (`Unlock` / `Create`) sits to the right of `Cancel`. Both buttons stay disabled while a slow Argon2id decrypt/create is in flight (a cancel cannot half-undo it).

A missing local file is not a decrypt failure: in Local File Mode, when the saved handle's target no longer exists (the file was moved, renamed, or deleted), the app shows the specific local-file-missing message from Section 16 instead of the generic unlock failure. This is a filesystem-level condition detected before decryption and reveals nothing about the password or envelope contents. The recent-file entry is kept so the user can relocate the file with `Browse` (or remove the entry with `Delete from list`).

If Local File Mode cannot access the saved file handle, ask the user to reopen the encrypted file before password entry.

### Draft And Files Actions (Provider Homes)

Below either provider block, the home offers **mode-specific** draft actions. There is no password field on the screen — every password is collected in a dialog. The buttons (icon buttons except `New/Edit draft`, which is narrowed to fit the longer Dropbox row) form one row that **wraps to a second line** on narrow phones (Section 15).

- **Local files home:** `New draft` / `Edit draft` · `Delete draft` · **`Save As`**.
- **Dropbox home:** `New draft` / `Edit draft` · `Delete draft` · **`Dropbox`** · **`Export draft`** · **`Import draft`**. `Import`/`Export` stay so the app remains fully usable for people who do not have or do not want a Dropbox account; the `Dropbox` promote button is **muted/grayed while unlinked** (linking is Home-only, Section 4).
- With no draft (provider recent-file caches do not count), the first action reads `New draft`, and `Delete draft`, `Export draft`, `Save As`, and the home `Dropbox` promote are disabled. `Import draft` is always enabled.
- With a draft, the first action reads `Edit draft` and opens the single-field unlock password dialog; the promotion and `Delete`/`Export` actions enable. The label stays `Edit draft` until the draft is deleted or promoted — after a promotion the home shows `New draft` again (the promoted document now lives in the recent-files list, at the top, selected).
- `New draft` runs the creation flow above (create-password dialog with two fields; no destination step).
- `Delete draft` deletes the draft after a concise confirmation dialog (`Delete the draft?` with OK/Cancel). It deletes only the draft; Dropbox files, caches, and the link state are unaffected.
- `Export draft` (Dropbox home) saves the draft's stored encrypted envelope as-is through the platform export flow — no password is required, because the record is already ciphertext (equivalent to copying the IndexedDB blob). The draft itself is not modified or deleted. It confirms with `Draft exported.` **only** when the export reliably completes (a file is actually written through the File System Access save dialog); a canceled export and the anchor-download fallback — whose completion the app cannot observe — show no message, rather than a possibly-false confirmation. (The authorization-lost Dropbox block's per-file `Export` behaves the same way for a cached file — Section 9.)
- `Import draft` (Dropbox home) reads an encrypted `.txt`/`.text` from Files into the draft (the Import flow below).
- **`Save As`** (Local home) and **`Dropbox`** (Dropbox home) **promote** the locked draft to a new file. They write the draft's **stored envelope verbatim** — no password, no re-encryption, because the draft is already ciphertext (exactly like `Export draft`) — register it as a recent file (top, selected), and clear the draft **only after** the write/upload succeeds (a failed promotion preserves the draft). `Save As` subsumes `Export draft` for Local mode (it makes a real working file rather than a loose copy), which is why Local mode drops `Import`/`Export draft`. The editor's `Save As` / `Dropbox` buttons, by contrast, act on an *unlocked* session and re-encrypt the current plaintext under the current password with a fresh nonce.

Delete and Import-over-existing run under the same cross-tab guard as the other draft-replacement flows: they refuse while another window has the draft unlocked.

### Edit And Autosave

- Mark document dirty on every editor change.
- Debounced autosave after 750ms of inactivity.
- Autosave encrypts the full current plaintext into a fresh envelope with a fresh nonce.
- Autosave writes encrypted envelope through the active provider.
- Local File Mode saves back to the selected encrypted local file when permission is available.
- A Dropbox file session writes the file's encrypted local cache, then — when online, linked, and past the first-sync gate (§9) — uploads to Dropbox as part of the same save; when offline or the upload cannot run, it keeps the envelope in the file's `pendingLocalEnvelope` until a later sync succeeds.
- A draft session writes the encrypted envelope to IndexedDB only; nothing uploads until the draft is promoted.
- Local save status values (the save indicator): `Saved`, `Saving`, `Unsaved`, `Save failed`, `Needs file permission`.
- Dropbox sync status values (the sync indicator, §9): `Synced`, `Unsynced`, `Offline`, `Conflict`, plus a link/attention prompt when Dropbox needs the user.
- On `visibilitychange` to hidden and `pagehide`, attempt immediate encrypted save. These backgrounding events are autosave triggers only: they must never lock, destroy editor state, or clear plaintext, password, or key references. Section 5 is the authoritative statement of this rule; it is not restated elsewhere.

### Lock

When user locks:

1. Attempt final encrypted save if dirty.
2. Destroy CodeMirror editor state.
3. Clear plaintext app state.
4. Clear password input state.
5. Clear derived key references.
6. Terminate the regex search worker so no in-flight document text, query, or replacement lingers.
7. Return to locked screen.

If the final save fails with unsaved changes on a **voluntary** exit (manual Lock or the
Home button), the app first attempts a flush; only if that also fails does it show an
**escalated confirmation** (distinct from the ordinary `Exit?`): *"Couldn't save your
latest changes — they'll be lost if you exit."* with **[Export a copy] · [Exit anyway] ·
[Stay]**, Export offered inline. `Export a copy` runs the encrypted export; `Exit anyway`
discards the unsaved edits and hard-locks; `Stay` returns to the editor. (An **involuntary**
exit — auto-lock — instead soft-locks; see Auto-Lock below.)

### Auto-Lock

- The `autoLockMinutes` setting (Section 8 `settings` store) controls an inactivity timeout. It defaults to `0`, which means never auto-lock.
- The available choices are Never (`0`) and a small set of preset minute values; the user selects the value in Settings (Section 15). The choice is persisted in the IndexedDB `settings` store so it survives reload and relaunch.
- While a document is unlocked and `autoLockMinutes` is greater than `0`, an inactivity timer runs. User activity (key presses, pointer/touch interaction, scrolling) resets the timer. When the timer elapses without activity, the app auto-locks.
- Auto-lock follows the same flow as a manual Lock: attempt a final encrypted save, then destroy editor state and clear plaintext, password, and key references. **When the final save fails with unsaved changes, auto-lock instead soft-locks** — it neither discards the plaintext (data loss) nor stays fully unlocked (no privacy):
  - **Soft-lock.** The editor is blacked out (its content, preview, search panel, messages, and content-derived status counts are unrendered — plaintext leaves the DOM) behind a password overlay: *"Unsaved changes will be lost if you exit now. Enter password to continue."* The overlay gates re-entry on the **correct password** (compared to the in-memory session password); with it the user gets **[Continue]** (un-hide the still-in-memory session) and **[Export a copy]** (an encrypted download through the independent Export path — a data-preserving escape that works even when the background retry can never succeed, e.g. a permanently dead file handle). **[Exit & discard]** drops the work and hard-locks to Home with no password. The session (plaintext + password) is **retained in memory** behind the overlay, and the inactivity timer is suspended while soft-locked and re-armed on Continue.
  - **Security trade (accepted).** A hard lock *wipes* plaintext+password; a soft-lock *retains* them, so it stops someone casually picking up the device but **not** a memory dump / devtools on the unlocked machine. It is scoped to the rare failed+dirty case — **every other auto-lock still hard-wipes** — and is acceptable for this personal-use, local-first app.
  - **Retry → upgrade to hard-lock.** While soft-locked the app keeps retrying the save; the **instant a retry succeeds** the data is safe, so it promotes the soft-lock to a normal hard-lock (wipes memory and returns Home). Plaintext lingers only as long as it genuinely cannot be persisted.
  - **Bound (accepted).** A soft-lock protects against *walking away*, not against a **tab crash, reload, or app-kill** — memory is gone then, and the unsaved work with it.
- The inactivity timer is independent of the backgrounding rule in Section 5: backgrounding still never locks on its own, and auto-lock fires only when the configured inactivity period has elapsed.

### Import Encrypted File (Files → Draft)

1. User chooses an encrypted `.txt`/`.text` file through a file input or supported desktop file picker. File pickers must accept `.txt` and `.text` only.
2. App validates the envelope header/metadata.
3. When a draft already exists, the app asks `Replace the draft?` — after the file is picked, never when `Import` is tapped (cancelling keeps the current draft unchanged and shows no message — a non-event, like cancelling the file picker). Dropbox files and their caches are not involved: importing touches only the draft.
4. App stores the encrypted envelope as the draft — written directly, never through a provider `save`, so importing never uploads — and confirms with `Draft imported.` once the write actually completes (never on a canceled import).
5. App returns to the home screen and opens the unlock password dialog for the imported draft directly; cancelling keeps it locked for a later `Edit draft`.

Import never uploads, and it requires no password or configured Secret key (the file is stored as the ciphertext it already is; its original password and, when applicable, Secret key are needed only to edit it later).

### Save As / Export Encrypted Copy

The editor's storage actions are mode-specific (Section 4 lists the buttons per session; this details the Save As and Export flows):

- **Local File Mode — Save As (full rebind, current password):** destination first. This action appears for local-file sessions and for a draft opened from the Local files home. The app asks where to save through a native save dialog pre-filled with the active file's sanitized basename when the session is already bound to a local file, or `enote.txt` for a draft (the picker's own replace confirmation covers overwrites); where the File System Access API accepts a starting handle, a bound local-file session starts the picker in the current file's parent folder. It reuses the **current** session/document password with **no password prompt** — Save As never sets or changes a password (rotation is the separate Change Password action below); a draft Save As is the local-mode analogue of the editor's Dropbox promotion (Section 4). It only then encrypts the current plaintext into a new envelope (fresh random salt and nonce, the session's captured KDF parameters, and the session's captured Secret-key write policy) under that current password and writes it. On success the picked file becomes the **active document** (the session password is unchanged) — Save As semantics as in desktop editors: all subsequent autosaves write to the picked file (under the unchanged session password), the picked file becomes the active entry in the recent-file list, and the editor content and undo/redo history are preserved (the editing session continues uninterrupted). When the Save As source is a draft opened from the Local files home, this is also a *promotion*: the draft slot empties as the document becomes the written local file (the local-mode analogue of the Dropbox promotion, Section 4), so the home reads `New draft` afterward and the new file sits in the recent-file list, selected. To return to the previous file, go Home and open it, or Save As onto it again. A cancelled picker changes nothing. If auto-lock fires before the write completes, the flow aborts with nothing written — plaintext is gone with the lock, so no copy can be produced.
- **Dropbox Mode (file and draft sessions) — Dropbox + Export to Files:** the primary action is the **Dropbox** button (save a copy to / promote to Dropbox and rebind the session, Section 4); the second action is **Export to Files (current-password export)**, which encrypts the current document under the *current* document password, the session's captured KDF parameters, and the session's captured Secret-key write policy into a freshly-nonce'd envelope (so the copy always matches the editor, never a stale autosave) and saves it through the platform export flow below. There is no export-password prompt.

**Platform export flow (no in-app filename prompt).** The app never asks for an export filename in its own UI:

- On platforms with the File System Access API (desktop Chromium), the export opens a single native save dialog (`showSaveFilePicker`) pre-filled with the suggested default filename; the user may edit the name and browse to a folder there. The dialog accepts `.txt` and `.text` only, the app additionally verifies that the picked filename ends in `.txt` or `.text` before writing, and a cancelled dialog aborts the export silently.
- On platforms without it (iOS Safari, Android Chrome), the export downloads immediately as a browser download named with the suggested default filename; the user renames or moves it afterward in the Files app / download manager. These platforms offer no rename opportunity at save time.

To preserve the save dialog's user-activation requirement, the app opens the picker first and only afterward encrypts (or fetches) the envelope and writes it through the picked handle. Nothing is written when encryption fails, the envelope is unavailable, or the dialog is cancelled.

**Suggested default filename.** The default is `enote.txt`. When the export is associated with a named file — the open Dropbox file for Export to Files (or for the recent-list `Export` actions, Section 9), the active local file for Save As in a local-file session — the suggestion uses that file's name instead, reduced to a sanitized basename: never a path (a stored Dropbox path must not reach the save dialog), filesystem-unsafe characters removed, an existing `.txt`/`.text` extension kept (`.txt` appended otherwise), and falling back to `enote.txt` whenever the stored name is missing or unusable. A Local-files-mode draft has no bound local file, so its Save As suggestion remains `enote.txt`. The conflict-copy exports (Section 9) use the suffixed defaults `enote-local-conflict.txt` and `enote-remote.txt` and follow this same platform export flow.

Plaintext export is not a normal app feature; both actions write only a newly encrypted `.txt`/`.text` envelope. Export to Files never changes the session password, the storage mode, the selected local file, any Dropbox file or its cache, or the draft; its picked file handle is used once and never retained. Save As in Local File Mode deliberately *does* change the selected local file — that is the rebind described above — while never changing the session password or the storage mode; it leaves the draft untouched when the source is an already-bound local file, but empties the draft slot when the source is a draft opened from the Local files home (the promotion above, mirroring the Dropbox promotion).

### Password Rotation (Change Password)

Changing a document's password is a **dedicated Change Password action** in the editor
toolbar (the key icon, next to Insert Random String), separate from Save As (which
always reuses the current password). It is available in **every editor session** — a
browser-local draft, a Dropbox file session, and a local-file session.

Change Password rotates the password **in place**: it opens a two-field new-password
dialog (new password plus confirmation, followed by `Use strong password hardening`, then
the Secret-key toggle below, `OK` / `Cancel`), then re-encrypts the current
plaintext into a fresh envelope (a new random salt and nonce at the KDF policy and Secret-key mode chosen in the dialog —
see Section 6) under the new password and writes it back to **the same place autosave
writes** — the browser-local draft record, the Dropbox file (a revision-conditional
upload, exactly like an autosave), or the bound local file — **never** an Export to
Files copy. There is no destination picker, no new file, and no rebind. Because the
document is unchanged apart from its password, the session password switches to the new
one immediately, so edits made *after* the rotation continue to autosave under it — the
rotation takes effect at once and survives continued editing, and the editor stays open
(it never returns to the home screen). A mismatched confirmation blocks the rotation and
the dialog stays open. The read-only flag is preserved.

The `Use strong password hardening` toggle (Section 6) defaults to the current file's hardening:
on for a `strong` file and off for a `standard` file. Turning it on from Standard shows
the memory/performance warning; leaving it on when the file is already Strong does not warn.
The new password may equal the old one, so the hardening toggle alone can change KDF strength.

The dialog also shows a `Use secret key` slide-toggle (Section 6),
defaulting to the document's current mode: turning it **on** re-encrypts as `required-v1`
(adding Secret-key protection — the only way to convert a `none` file, using the session's
key: the configured Settings key, or the key the file was unlocked with), and turning it
**off** re-encrypts as `none` (removing protection, saving the document as password-only).
The toggle is enabled when a key is available to apply — a configured Settings key, or a
session that already holds the validated key payload from unlocking a `required-v1` file (see the
key-availability cases in Section 6). It is disabled and off only when neither is
available, which happens for a `none` document on a keyless device, so Change Password
there simply keeps it `none` and cannot add protection; a `required-v1` document always
carries a session key from its own unlock, so its toggle is enabled. Because the new
password may equal the old one, the toggle alone can switch the Secret-key mode without
otherwise changing the password. If auto-lock fires before the dialog completes, the
rotation aborts with nothing written. A failed write reverts the session **atomically** to
both its previous password and its previous Secret-key mode/bytes, so a failed add or
remove never leaves later autosaves/exports writing a mode the durable file did not adopt.
On success the save-status line reads **Password changed** (in place of `Autosaved`) for a
few seconds.

Export to Files is unaffected — it remains a current-password one-shot export, and there
is **no new-password export**. Password rotation is always in place, via Change Password.

Old exported envelopes remain decryptable with the password they were written with.

## 11. Editor Specification

Use CodeMirror 6 packages:

- `@codemirror/state`
- `@codemirror/view`
- `@codemirror/commands`
- `@codemirror/search`
- `@codemirror/lang-markdown`

Required behavior:

- Plain text document model.
- When a document opens (unlock, create, or Save As rebind), the editor receives keyboard focus with the caret at the start of the document, so typing can begin without a click or tap.
- Markdown source syntax highlighting.
- Exact text preservation through save, reload, export, import, and sync (after the one-time LF normalization at unlock — Section 6, Plaintext encoding).
- Undo/redo with a deep history (configured `minDepth` of 10,000 change groups) within the current unlocked editing session, bounded only by browser memory and editor library limits.
- Select all.
- Line wrapping, configured in the editor Settings dialog (no toolbar button). Defaults on.
- Whitespace visibility (spaces, tabs, and trailing whitespace), configured in the editor Settings dialog (no toolbar button). Defaults off.
- Tab inserts a literal tab character at the cursor, replacing any selection (typewriter semantics, not code-editor line indentation), rather than moving focus; Escape then Tab remains the keyboard path out of the editor for accessibility.
- `Ctrl/Cmd+S` runs the app's file action instead of the browser's save-page dialog: Save As for local-file sessions and drafts opened from the Local files home, Export to Files for Dropbox file sessions and drafts opened from the Dropbox home. Inert while a modal dialog is open.
- Dropping a text file onto the editor inserts its text at the drop point (editor-library behavior, kept deliberately). The insertion is an ordinary undoable edit; dropping never navigates the page away from the app.
- Pasting inserts plain text, with one markdown-mode convenience: when the clipboard's rich flavor is exactly one linked text (a single anchor that is the whole copied content — for example a hyperlink copied from a web page), the paste inserts the markdown link `[text](url)`. Any other rich paste, and every paste in plain mode, inserts the plain-text flavor unchanged — no general HTML-to-markdown conversion is attempted, so ordinary pastes can never be mangled.
- The last line can scroll above the bottom of the viewport, so the end of the document stays editable above the on-screen keyboard.
- The insertion point stays visible while the editor is not focused: a dimmed, slightly wider caret is drawn at the primary cursor whenever focus is elsewhere (keyboard closed, or while typing in the find box), so caret-targeted actions — Insert Random String above all — have a visible target even though tapping them requires the keyboard to be down. It blinks in the same rhythm as the focused caret, and the regular caret takes over the moment the editor regains focus. Applies in every orientation and in read-only mode.
- Read-only mode (document-level), described below.
- Current line highlight.
- Line and column display.
- Character count (and selected-character count when a selection is non-empty).
- Word count (and selected-word count when a selection is non-empty).
- Insert a random string at the cursor from a toolbar button (see "Random string insertion" below).
- Copy and select a line's last word by clicking its line number in the gutter (see "Line-number copy" below).
- Mobile touch editing.
- Desktop keyboard shortcuts for save, find, replace, and lock where practical.

Read-only mode (document-level):

- The read-only flag is document state stored in the encrypted envelope's authenticated metadata (Section 7) — never a `settings` record — so it travels with the file across sessions, devices, and Dropbox sync. It is an accidental-edit safeguard, not access control: there is no separate password and the session password is unchanged. Because toggling it rewrites the envelope, it counts as a modification for `localModifiedAt`/`client_modified` (Section 8) exactly as on a desktop filesystem — flipping the flag and syncing advances both the `Last synced` and `Last modified` columns.
- While read-only: typing, paste, cut, drag-drop insertion, Insert Random String, and every replace action are unavailable (changes are rejected at the editor-state level; the related controls are disabled, and the search panel's replace row is hidden outright — Section 12). The caret remains visible and keyboard-driven — arrow keys move it, Shift+arrows select, and copy works from the keyboard — and selection, search and navigation, line-number copy, lock, export, and Save As all keep working. Tab falls through to focus navigation instead of inserting a tab character.
- Toggle entry points: a toolbar lock button (outline icon = writable, tap to make read-only; filled icon = read-only, tap to make writable; shows the active treatment while read-only) and a `Read-only` checkbox in the editor Settings dialog. Both drive the same action.
- Toggling re-encrypts the current plaintext with the flag flipped and saves immediately through the active provider — the toggle itself is the save, since autosave cannot run while the document is read-only. A failed save reverts the toggle. Feedback: `Read-only on.` / `Read-only off.`
- A Save As copy (including a rebind) inherits the current flag, and a Change Password rotation preserves it. New drafts start writable.
- Compatibility: a flag-less envelope opens writable. Unknown-field handling follows the authenticated metadata rules in Section 7.

Editor modes:

- The `editorMode` setting selects between `plain` and `markdown`. Both modes use the same plain-text document model; the mode only changes presentation, never the saved bytes.
- In `plain` mode the editor applies no Markdown language extension and no syntax highlighting, and the Markdown preview is unavailable/hidden.
- In `markdown` mode the editor loads `@codemirror/lang-markdown` with the GitHub Flavored Markdown extension (tables, strikethrough, task lists — matching the Section 13 preview renderer) for source syntax highlighting, and enables the Markdown preview pane/toggle described in Section 13.
- Switching modes never rewrites, reflows, or reformats document content; it only adds or removes highlighting and preview affordances.

Saved content is exactly `view.state.doc.toString()`. Visual formatting never modifies saved content.

Editor display and text-service defaults:

- Default editor font is a fixed-width system font stack.
- Font selection uses fonts available through the operating system/browser. The app does not bundle, download, or install app-specific fonts.
- Default font size is a readable desktop/mobile editor size.
- `spellcheck=true`
- `autocorrect=on` where supported
- `autocapitalize=sentences` where supported (normal typing assistance in the editor)
- Spellcheck, autocorrect, and autocapitalize can be changed in Settings; an explicit choice is persisted and overrides the install default.
- The Find and Replace inputs always disable autocapitalize (they take literal search text).

Random string insertion:

- The main editor toolbar (Section 15) has an Insert Random String button that inserts a freshly generated random string at the cursor, replacing the current selection when one is non-empty.
- The insertion is an ordinary editor edit: it is undoable, marks the document dirty, triggers autosave, and scrolls the insertion point into view.
- The string is composed of ASCII uppercase letters, lowercase letters, and digits — the 62-character set `A–Z`, `a–z`, `0–9`.
- Randomness uses the platform cryptographically secure RNG (`crypto.getRandomValues` / libsodium CSPRNG), never `Math.random` (Section 6), because a generated string may be used as a password, Secret key, or token. Mapping random bytes onto a non-power-of-two alphabet uses rejection sampling so every character is uniformly distributed (no modulo bias).
- The length is user-configurable in the editor Settings dialog (Section 15). It defaults to `12` at first install, is bounded to a sane range (1–128 characters), and is persisted in the `settings` store under `randomStringLength` (Section 8) so it survives reload and relaunch.

Line-number copy:

- Clicking (or tapping) a line number in the editor gutter copies that line's last word to the system clipboard. The last word is the line's final run of non-whitespace characters, with any trailing whitespace and the line break excluded. A line with no whitespace copies the whole line; a blank or whitespace-only line copies nothing. Punctuation attached to the token is kept. "Whitespace" is the JavaScript `\s` class (space, tab, NBSP, and other Unicode spaces).
- The action also **selects** the copied word in the editor, so the user can see exactly which string was placed on the clipboard. The selection works in both writable and read-only sessions (read-only blocks document edits, not the selection). It never modifies the document text or undo history; only the selection/cursor moves to the copied word.
- A successful tap is confirmed with an info-tone message — `Last word copied.` — which auto-dismisses (Section 16). The confirmation is optimistic: it reports that the copy was initiated; a platform-refused clipboard write (rare) is not detectable in the fire-and-forget path.
- The copy uses the asynchronous Clipboard API, which requires a secure context (HTTPS, an installed PWA / Add to Home Screen, or `localhost`) and a user gesture; the click or tap supplies the gesture, and every production environment is a secure context. The gutter handles both mouse click and touch (`touchend`) — iOS Safari delivers only the touch event there. This is a deliberate, user-initiated export of plaintext to the OS clipboard (see Accepted Residual Risks).

## 12. Find/Replace

The toolbar Find control opens a slide-down Find/Replace panel below the toolbar and focuses the query field. The panel overlays the top of the editor rather than pushing the text down: the document keeps its position and its first lines are covered while the panel is open. The covered strip is registered as an editor scroll margin, so anything the editor scrolls into view — match navigation, the caret, typing — is placed just below the panel rather than underneath it; a match in the covered first lines therefore becomes visible when navigated to. There is no separate Find All button, result panel, or result list. As the user types in the find field or changes search options, all current matches are highlighted automatically in the editor.

Keyboard shortcuts (desktop): while a document is unlocked, `Ctrl/Cmd+F` opens the panel and focuses the Find field, and `Ctrl/Cmd+H` opens the panel and focuses the Replace field — not an alias of `Ctrl/Cmd+F`. In both cases any existing text in the targeted field is selected, so typing immediately starts a new query/replacement. `F3` / `Shift+F3` / `Ctrl/Cmd+G` / `Shift+Ctrl/Cmd+G` run find next/previous (opening the panel when it is closed). `Escape` pressed anywhere inside the panel closes it and returns focus to the editor. The bindings are registered at the document level in the capture phase, so they take priority over the editor library's bundled search keymap and the browser's native find bar — the custom panel is the single search UI — and they stand down during IME composition and while any modal dialog is open. The editor's `Mod+D` add-next-occurrence multi-cursor binding and `Alt+G` go-to-line remain available; neither exposes a second find/replace UI.

Search panel supports:

- query
- replacement text
- regex toggle
- case-sensitive toggle
- whole-word toggle
- next match
- previous match
- replace previous/selected match
- replace next/selected match
- replace all

Search and replacement text are memory-only and never persisted.

Search panel layout:

- The find row and replace row sit side by side on one line as roughly-equal halves — find on the left, replace on the right — whenever the viewport is wider than 640px. This is the **same breakpoint** at which the Markdown preview switches from overlay to side-by-side, so the two layouts switch together; the trigger is width-based (and therefore orientation- and platform-independent: iPhone, Android, and desktop behave identically). Within each half the text input flexes and its buttons stay fixed-width. A theme-aware vertical divider separates the two halves.
- At 640px and below the two rows stack vertically (one column) and the divider is removed — matching the Markdown preview going to overlay at the same width. This is the phone-portrait case.
- While the document is read-only (Section 11) the replace row — input and buttons — is hidden entirely rather than disabled, reclaiming its line of space on phones. The replace draft is not cleared; it reappears unchanged when the document becomes writable again.

Search feedback placement:

- The informational match summary — the current match position (e.g. "3 of 3") and replace results (e.g. "Replaced 2 matches.") — appears in the editor status bar in the info (green) color while the search panel is open.
- The summary is live while typing: a valid query immediately shows its total match count (e.g. "2 matches", including "0 matches") with no navigation needed, updating as the query or the document changes and going silent when the query is emptied. A command result ("2 of 3", "Replaced 2 matches.") replaces the count until the next query or option change.
- Error feedback (invalid/expensive regex, a navigation or replace command finding no matches, too many matches, stale/unready editor) appears in the message area below the toolbar in the error (red) color. The live "0 matches" count is not an error: green "0 matches" answers the typed query, while red "No matches." answers a Find/Replace command that had nothing to act on.
- A live count stopped at the engine's match cap displays as "10000+ matches" rather than claiming an exact total (highlights likewise cover only the scanned matches).
- An empty query shows no validation message.

Regex semantics:

- Use JavaScript `RegExp`.
- Always use global scanning for automatic highlighting, navigation, and Replace All.
- Add `i` when case-sensitive is disabled.
- Avoid newest regex flags with weak iOS support.
- Replacement strings use JavaScript replacement-token semantics, including `$&`, numbered captures such as `$1`, named captures such as `$<name>`, `$$`, `` $` ``, and `$'` where browser-supported.

Regex execution:

- Literal search and replace run synchronously in the main editor thread. They use no worker and no timeout: literal scanning is linear and cannot run away, so the lowest-latency path is a direct synchronous call. (These are Web/module workers, distinct from the single PWA service worker described in Section 14.)
- Regex search, navigation, and replacement run in a single persistent module worker that is reused across requests rather than spawned per request. The worker is created lazily on the first regex operation.
- Worker-backed regex operations must enforce a timeout. On timeout the worker is terminated to stop the runaway computation; the operation shows `Regex too expensive.`, does not highlight matches, and does not modify the document; and the worker is recreated lazily on the next regex request.
- Only one regex request runs in the worker at a time. If a newer regex request arrives while one is still running, the older request is superseded: the worker is terminated and respawned so a possible runaway cannot block the newer request.
- The search worker must not retain document text, query, or replacement in worker-global state between requests; each request's data exists only for that message-handler invocation and is discarded when it returns.
- Search query and replacement text remain memory-only and must not be persisted by the main thread or worker.
- The search worker is terminated on lock/logout so no document text, query, or replacement lingers in a worker between unlocked sessions.

Invalid regex:

- Do not crash.
- Do not highlight matches.
- Search and replace actions report an inline/status error and do not modify the document.
- Navigation and replace actions are disabled when the query is empty.
- When regex mode is on and the query is an invalid regex, navigation and replace actions are disabled until the query is fixed or regex mode is turned off.

Regex safety:

- Regex mode must reject patterns that are syntactically valid but likely to cause excessive backtracking, including nested quantifier shapes such as `(a+)+b`.
- Empty-capable patterns are allowed, not rejected. Anchors and boundaries (`^`, `$`, `\b`, `\B`), lookarounds, and empty-capable quantifiers (`a*`, `.*`, `(abc)?`) are valid queries — blanket-rejecting them would block reasonable searches and common mid-typing states.
- Global regex iteration must guarantee forward progress: a zero-length match advances the scan by one position so an empty-capable pattern can never cause an infinite loop. Zero-length matches are skipped — not highlighted, navigated, counted, or replaced — so only non-empty matches are collected (for example `a*` over `aaa bbb` yields the run `aaa`, not interleaved empty matches; a pattern such as `\b` that only ever matches empty yields zero matches rather than an error).
- Rejected unsafe regexes (excessive-backtracking patterns) and invalid regexes behave like unavailable search actions: do not highlight matches, do not modify the document, disable navigation and replace actions, and show `Regex too expensive.` (or the invalid-regex error).
- Regex searches and replacements must be bounded by a timeout and match cap even after pre-validation passes.

Whole word:

- Literal whole-word mode treats ASCII letters, digits, and underscore as word characters.
- Regex whole-word mode applies the same ASCII word-boundary filtering to regex matches.

Automatic highlighting and navigation:

- Highlight matches in the editor using CodeMirror decorations.
- Next and previous select the current match, scroll it into view, and show the current index such as `1 of 2`.
- Repeated next/previous navigation wraps around the document.
- Render at most 10,000 highlighted matches.
- If Replace All would exceed the match cap, do not replace and show `Too many matches. Showing first 10000.`
- Replace All keeps the caret approximately at its pre-replace position by re-anchoring to the same line and column (clamped to the new text); it never jumps to the document start. Approximate by design: replaced spans shift content, and a replaced selection is collapsed.
- The Find and Replace inputs each show a clear (✕) control inside the right edge of the box, visible only while the box has text. Tapping it empties the box (clearing the live match highlights when it is the Find box) and keeps focus in the input so the mobile keyboard stays up. It is a borderless glyph drawn by the app — identical in every browser and theme; native browser search-cancel controls are suppressed so duplicate clear buttons do not appear.
- Reject clearly expensive or timed-out searches and show `Regex too expensive.`

## 13. Markdown Behavior

Markdown is edited as source text. Syntax highlighting is visual only.

Markdown preview behavior:

- Preview is derived from the current plaintext in memory.
- Preview HTML is never persisted.
- HTML is sanitized by an **allowlist, not a blocklist**: only a fixed set of safe
  elements and attributes survive; anything not explicitly allowed is dropped.
  - The navigational attribute `href` allows only `http:`, `https:`, `mailto:`, and
    relative URLs; `javascript:` and `data:` are removed.
  - Resource-loading attributes (`src`) are removed entirely. The preview performs **no**
    automatic resource load from document content — not a remote request, and not even a
    same-origin one, since a relative `src` would still transmit document text in the
    request URL (path/query) to the host's logs. This is enforced at the sanitizer layer,
    so it holds even with the CSP absent. `<img>` survives only to render its `alt` text;
    automatic image display is a non-goal.
  - Inline event-handler attributes (`on*`), inline `style`, and `srcset` are removed.
  - Form controls are removed: the preview is read-only, so even a disabled task-list
    checkbox is dropped rather than risk a raw-HTML interactive control.
  - `script`, `iframe`, `object`, `embed`, `link`, `meta`, `style`, `base`, `<svg>`, and
    `<math>` (and other embedded/active content) are removed.
  - The only `data-*` attributes allowed are the two **source-line sync anchors**
    (`data-enote-source-line`, `data-enote-render-key`), and only with app-controlled
    values: a numeric source line and the exact render key of the in-progress render
    (`ALLOW_DATA_ATTR` stays `false`; the two are admitted by name and value-checked).
    A copy of these attributes typed into a note's own raw HTML is dropped, because its
    render key cannot match the current render and a non-numeric line is rejected — so it
    can never become a false sync anchor. These attributes are inert (no script/resource
    vector); the gate is correctness, and the allowlist remains the security boundary.
- Remote images, scripts, iframes, styles, fonts, and active content are blocked. The
  production CSP is the outer layer; the sanitizer is the in-app layer and must stand on
  its own even if the CSP were ever absent (for example a header-only host).
- Links open only after explicit user action, in a separate browsing context with the
  opener severed (`target="_blank"`, `rel="noopener noreferrer"`).

Preview position sync (side-by-side preview only):

- The renderer stamps each anchored block with its 1-based Markdown source line
  (`data-enote-source-line`) plus the current render key (`data-enote-render-key`), so a
  rendered block can be mapped back to its source line. Anchored blocks are headings,
  paragraphs, top-level list items, blockquotes (container only), code blocks, tables, and
  horizontal rules. `ul`/`ol` containers are not anchored (a list is represented by its
  item anchors). Source lines are derived from marked's verbatim token `raw`; constructs
  whose `raw` does not reconstruct against the source — nested list items (their
  indentation is stripped) and blockquote inner blocks (their `>` is stripped) — degrade
  to their nearest anchored ancestor rather than mapping to a wrong line.
- Two one-shot align actions are offered in a thin row above the side-by-side panes:
  **Jump to Markdown** scrolls the preview so the block containing the editor's top source
  line sits at the top; **Jump to Editor** scrolls the editor to the block currently at the
  preview's top. (The button over the editor pane is *Jump to Markdown*, over the preview
  pane *Jump to Editor* — each pulls the other pane to the side you are reading.) Alignment
  is **block-anchor exact** (the containing / nearest-preceding block), not pixel-perfect
  within a wrapped block.
- Opening the preview shows it already aligned to the editor's current top line — the same
  as pressing *Jump to Markdown* — in **both** the side-by-side and overlay layouts. The
  editor's top line is captured at the moment the preview is toggled open (before the
  overlay layout hides the editor). The one exception is reaching markdown mode with the
  preview already toggled on (not via the preview toggle): that opens at the preview's
  natural top, since the editor may be hidden and offer no reliable line to read.
- Closing the **overlay** preview performs the mirror move — the editor is scrolled to the
  source line of the block at the preview's top (the same as *Jump to Editor*), because the
  editor was hidden while the preview scrolled and its own position is stale. The line is
  captured before the pane closes and applied once the editor is visible again. Closing the
  side-by-side preview does not jump: both panes were visible throughout.
- Alignment is against the preview as currently rendered. The preview render is deferred
  relative to keystrokes, so immediately after an edit it may briefly lag; pressing again
  once it catches up re-aligns to the new content.
- The preview scrolls past its end like the editor does (Section 11): an empty spacer one
  line short of the pane height lets the last block sit at the top of the pane. This also
  makes *Jump to Markdown* exact for blocks near the document end.
- The sync row is shown only with the side-by-side preview; it is hidden in the narrow-
  screen overlay layout, where per-pane alignment has no meaning — so in the overlay the
  open-time alignment is the only sync (there is no reverse-align button).

## 14. PWA And Offline Behavior

Manifest:

```json
{
  "name": "eNoteWeb",
  "short_name": "eNoteWeb",
  "start_url": ".",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#000000",
  "icons": [
    {
      "src": "icon.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any maskable"
    },
    {
      "src": "apple-touch-icon.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any"
    }
  ]
}
```

Use `start_url: "."` so the installed PWA launches relative to the directory where it is deployed, rather than assuming the app is hosted at the domain root.

Use a bundled local SVG app icon with `sizes: "any"` and `purpose: "any maskable"`, plus an opaque PNG icon (`purpose: "any"`) for raster consumers. iOS "Add to Home Screen" ignores SVG icons and fills transparency with black, so also reference the opaque PNG from `index.html` via `<link rel="apple-touch-icon" href="apple-touch-icon.png">`; without it iOS renders the home-screen tile from a dark page screenshot. The PNG must be opaque (no transparency) so iOS does not composite it onto black.

Manifest color meanings:

- `background_color` controls the launch/splash-screen background shown by some installed PWA runtimes before the app finishes painting.
- `theme_color` controls browser/OS chrome tinting for the installed app where supported, such as the title bar, status bar, task switcher color, or address bar tint.

Service worker caches:

- `index.html`
- production JS bundles
- CSS bundles
- manifest
- icons
- libsodium assets: `libsodium-wrappers-sumo` embeds its WASM as Base64 inside the JavaScript bundle, so no separate `.wasm` asset is emitted and precaching the JS bundle covers libsodium. If a future build configuration emits libsodium WASM as a separate asset, that asset must also be precached.
- CodeMirror and app assets bundled into the build

Service worker does not cache:

- plaintext documents
- IndexedDB vault records
- Dropbox API responses containing encrypted vault content unless explicitly stored through the encrypted sync layer
- arbitrary remote URLs

App update strategy:

The app is offline-first: once installed it runs entirely from its precached bundle and never requires a network round-trip to launch or edit. The installed app stays pinned to the exact build the user is running and never changes its own running version automatically. A newly published build never alters, interrupts, or replaces the running app on its own — not on launch, not on a schedule, not when connectivity returns, and not after the app is closed and reopened. The running version changes only when the user explicitly confirms an update (the `Update` action, Section 15), and only from the locked/home screen.

This is a deliberate trust property for an encrypted editor: the user — not the publisher's release cadence and not the browser's background behavior — decides exactly when new code begins running on their device.

Deployment assumption: the production app is published as a static site on GitHub Pages, so the app's own origin is the GitHub-hosted copy of the latest published build. "Checking for a newer version" therefore means fetching a small version manifest from the app's own origin. This introduces no new network destination and stays within `connect-src 'self'`. If the app were ever hosted off-GitHub while still checking a cross-origin GitHub URL such as `raw.githubusercontent.com` or `api.github.com`, that exact origin would have to be added to `connect-src` and to the Section 5 network policy; co-locating the app and its update source intentionally avoids that.

App base path:

- The app may be deployed at the domain root (`/`) or under a subpath (a GitHub project Pages site serves from `https://<user>.github.io/<repo>/`). All app-shell URLs resolve relative to the deployed **base**, not the domain root: the service-worker registration path and scope, every precache entry (including the app-shell `/` entry), the navigation fallback document, `version.json`, the `index.html` `apple-touch-icon` link, and the manifest `icons` and `start_url`.
- Concretely: the manifest uses a relative `start_url` (`"."`) and relative icon `src` (`icon.svg`, `apple-touch-icon.png`); the `apple-touch-icon` link is likewise base-relative; `version.json` is fetched next to `index.html` under the base; and the build is produced against the configured base (the bundler's `base` option / `import.meta.env.BASE_URL`, and `self.registration.scope` inside the service worker) so a subpath deployment cannot fall back to a domain-root URL. A user-root or custom-domain deployment keeps the base at `/`.
- The `manifest.webmanifest` icon `src` and the `index.html` `apple-touch-icon`/`icon`/`manifest` links are **base-relative** (`icon.svg`, `apple-touch-icon.png`, `manifest.webmanifest`), resolving under the deployed base together with the rest of the app-shell URLs above rather than against the domain root.

Build version identifier:

- Each production build embeds a version identifier (the git commit short hash plus build timestamp, or a monotonic build number) as a compile-time constant in both the app bundle and the service worker.
- The identifier must be **unique per build artifact** — distinct builds must never share one, even when produced from the same commit. Use sub-second timestamp precision, a content hash, or a monotonic build number; a git short hash plus a whole-second timestamp is not sufficient. Two builds that collided on the identifier would share a version-keyed cache, so a staged build could overwrite the pinned build's cache and break the freeze.
- The same identifier is written to a small `version.json` served next to `index.html` under the app base (see App base path), for example `{ "version": "<id>", "builtAt": "<iso8601>" }`. `builtAt` is a valid ISO-8601 UTC timestamp. `version.json` contains no sensitive data.
- The embedded build identifier is surfaced in the Settings dialogs (see Section 15) so a user or auditor can confirm the running build matches a published release and reproduce it from the corresponding source commit. The identifier is non-sensitive and carries no plaintext, key, token, or document data.

Version pinning and staged updates:

- Each build's assets are precached under a service-worker cache keyed by that build's version identifier. The app records which version is **pinned** (active) for this installation, and the service worker always serves the app shell (`index.html`, JS, CSS, manifest, icons, and other precached assets) from the pinned version's cache.
- The browser may, on its own schedule (typically when the installed app is opened while online), re-fetch the service-worker script and install a newer published build in the background. That newer build is **staged**: its assets may be precached into their own versioned cache, but staging must not change the pinned version. Even after the browser activates a newer service-worker instance, that instance must keep serving the pinned build until the user explicitly updates. Closing and reopening the installed app, regaining connectivity, or any browser-initiated service-worker update must never change which build the user is running.
- Pruning: the service worker must retain the pinned version's cache and any staged version's cache. It may prune older superseded caches, but only after a new version has been successfully pinned, and it must never delete the cache currently being served.

Update detection — passive indicator:

- When a staged build newer than the pinned build is available (detected from the browser's background service-worker update and/or a `version.json` comparison), the locked/home screen shows a passive `Update available` indicator (Section 15).
- The indicator is informational only. It must never start, schedule, or perform an update by itself; it only signals that tapping `Update` would move the user to a newer build. The actual update happens solely through the explicit user action below.
- The browser's automatic background re-check of the service-worker script is the mechanism that can populate this indicator without a user action. It is a request to the app's own origin only (no new network destination, no document content, no credentials), and it changes nothing the user is running.

Manual update check and update:

- The app never *activates* an update on launch, on a schedule, or when connectivity is regained. Activation is entirely user-initiated through the `Check for updates` and `Update` actions in the locked/home-screen Settings dialog (Section 15).
- `Check for updates` forces an immediate check: it fetches `version.json` from the app's own origin with `cache: "no-store"` (so the service-worker cache cannot mask a newer manifest) and asks the browser to check for a newer service-worker script, then compares the manifest to the running build's pinned version identifier. Freshness is decided by comparing the parsed `builtAt` timestamps (not by string comparison); a manifest missing a valid `version`, or with a missing or malformed ISO-8601 UTC `builtAt`, is treated as "could not check" (below), never as an update.
- Every network wait in the check is **time-bounded** (manifest fetch — covering both the response headers and reading the body — and the background service-worker re-check). A stalled origin that accepts the connection but never responds therefore resolves to "could not check" instead of leaving the check pending; the "Checking for updates" dialog can never become a permanent, unclosable modal. While the check is in progress the dialog also offers `Cancel`, which abandons the check immediately, closes the dialog, and suppresses any late result (a user cancel is distinct from a timeout: cancel simply dismisses, a timeout shows "could not check").
- If a newer version is available (whether already surfaced by the passive indicator or found by this on-demand check), the app shows an "update available" dialog offering `Update` and `Cancel`:
  - `Update` ensures the new build's assets are fully precached into their versioned cache, then repoints the pinned version to the new build, prunes superseded caches only after the new cache is fully populated (so a failed or partial download never leaves the app without a complete working cache), and reloads the app onto the new build.
  - `Update` must apply the offered build whether its service worker is still `waiting` or has already activated in the background while continuing to serve the pinned cache (in which case there is no waiting worker). The app locates the correct worker — waiting or active — and drives it to repoint the pin; because serving is governed by the pinned version rather than by which worker is active, the reload then lands on the new build regardless.
  - Before repointing the pin, the app confirms the worker it is about to activate reports the same build identifier that was offered to the user, passing that expected identifier into the activation request; the worker refuses to repoint on a mismatch. This prevents a `version.json`/service-worker-script skew from silently installing a build other than the one the user was shown.
  - `Cancel` keeps the current pinned version unchanged and takes no further action; any staged newer build remains staged and unused until the user updates later.
- If no newer version is available, the app shows an "app is up to date" dialog with an `OK` action and keeps the current pinned version.
- If the device is offline, the fetch fails or stalls past the timeout, the manifest is missing (HTTP 404 / page not found), or the response is malformed, the app shows a "could not check for updates" dialog with an `OK` action and keeps the current pinned version.
- If applying a confirmed update fails (no staged build matching the offered version can be activated, or an activation step times out), the app shows a distinct "could not update" dialog with an `OK` action. If the failure occurs **before** the activation request is sent to the worker (e.g. no matching staged build is found), the current pinned version is unchanged. Once the activation request has been sent, however, the page-side timeout only governs the **UI**: it cannot abort the worker's in-flight precache/pin work, so the worker may still complete activation in the background and a subsequent reload could land on the new build even after "could not update" was shown. Apply is therefore best-effort, not transactional, on the timeout path. (Applying is **not** user-cancelable once `Update` is pressed: mid-activation cancellation is semantically unsafe, so apply relies on its time bounds alone.) Fully abortable/transactional activation is a separate follow-up.

Update activation and session safety:

- The `Check for updates` and `Update` actions, and the passive `Update available` indicator, are exposed only on the locked/home screen, so no document is unlocked when an update is checked, confirmed, and activated. Activating immediately, including the reload, therefore cannot lose in-memory plaintext or unsaved edits.
- The app must never activate a staged build, swap the running code, repoint the pinned version, call `clients.claim()`/`skipWaiting()` into effect, or reload for an update while a document is unlocked. A staged build waits, unused, until the user updates from the locked screen.
- This is a **cross-window** invariant, not just a same-window one: because serving is governed by the pinned version (a Cache Storage record shared across all windows), repointing the pin in one window would change the build served to every other open window — and pruning the superseded cache could then 404 a lazy-loaded asset a window still running the old build never cached. The app must therefore not apply an update while *any* window (not only the one initiating it) has a document unlocked. The locked-screen-only exposure makes the initiating window safe; the cross-tab vault Web Lock (Section 15) makes the others detectable, and an update is refused while that lock is held by another window. When an update does repoint the pin, the worker notifies the other (necessarily locked) windows so they reload onto the new pin rather than keep serving the stale, soon-to-be-pruned cache; an unlocked window is never auto-reloaded.

Offline behavior:

- After first online load, app launches offline from iOS/Android Home Screen or Windows Edge app shortcut.
- User can unlock, edit, autosave encrypted local changes, search, export, and lock offline.
- Local File Mode continues saving to the selected encrypted local file if permission remains available.
- Dropbox Mode status shows offline or pending sync.
- Dropbox sync resumes when network returns.

Windows app-window behavior:

- The recommended Windows installation is Microsoft Edge's installed app/PWA flow.
- A desktop shortcut may alternatively launch Edge explicitly with `msedge.exe --app="https://<app-origin>/"`.
- The Windows app window should open without ordinary browser tabs or address bar.
- The app must not depend on being the user's default browser.

## 15. UI Specification

The app is a compact tool UI.

Design principles:

- prioritize editor space
- quiet, utilitarian, readable
- touch-friendly on mobile
- keyboard-friendly on desktop
- no decorative landing page
- no remote imagery
- no unnecessary animation
- no analytics, telemetry, or tracking of any kind

Required screens:

- Create (the New draft create-password dialog)
- Locked / Unlock (no on-screen password field; actions open password dialogs)
- Password dialogs: single-field unlock; password-plus-confirmation for Create and Change Password
- Main Editor
- Markdown preview pane / toggle (in `markdown` mode; see Section 13)
- Find/Replace panel
- Import confirmation
- Save As (Local File Mode) / Dropbox + Export to Files (Dropbox Mode) editor storage actions; the home `Save As` / `Dropbox` draft promotions; Change Password (editor toolbar, every session); Import (Files → draft)
- Provider homes: the Dropbox block (Link / small corner Sync when linked / Relink on authorization loss; recent-files table with row menu; Browse / Open / Resolve / Export — Unlink moved to the Home Settings dialog) or Local files block (Set path root, recent-files table with row menu, Browse / Open), followed by the **mode-specific** draft/Files actions — Local `New/Edit draft · Delete draft · Save As`; Dropbox `New/Edit draft · Delete draft · Dropbox · Export draft · Import draft` (with `New/Edit draft` narrowed to fit and the home `Dropbox` promote button muted while unlinked) — forming one row on wide screens that wraps to a second line on narrow phones (Sections 4, 9, 10)
- Recent-files row menu (`Delete from list`) and its confirmations
- Account-switch guard dialog (Section 9)
- Storage provider selection/settings
- Local file permission/reopen dialog
- Dropbox link/status dialog
- Dropbox file browser (choose / upload destination; Section 9)
- Sync conflict editor
- Save-failure UI: the voluntary-exit escalated confirm and the auto-lock soft-lock overlay (Section 10)
- Settings dialog
- Secret key QR popup (Section 6)

Provider home layout:

- The Dropbox block sits at the top: a `Dropbox` heading; in the linked state a SMALL `Sync` action (icon button styled like `Browse`) in the block's upper-right corner (visually subordinate — it must never read as a primary action), the recent-files table, then `Browse` and `Open` side by side. In the unlinked state the block contains only the heading and a `Link` action. In the authorization-lost state the corner action reads `Relink`, `Browse` renders disabled, and `Open` reads `Export`. `Unlink` is not in the block — it is in the Home Settings dialog (Section 9).
- The Local files block mirrors the Dropbox block structure with a `Local files` heading and local storage icon, a SMALL `Set path root` action in the block's upper-right corner, the recent-files table with `Name`, `Path`, and `Last modified`, then `Browse` and `Open` side by side.
- The recent-files table columns are `Name`, `Path`, `Last synced`, and `Last modified` in the Dropbox home, and `Name`, `Path`, and `Last modified` in the Local files home (local files have no remote to sync against). The `Path` cell truncates from the left so the direct parent folder name stays visible at the right edge; rows meet the minimum touch-target size; the table scrolls under a frozen (sticky) header when it overflows vertically. The table also has a minimum width: when the container is narrower than that minimum (a phone in portrait, especially the 4-column Dropbox table) the table keeps its minimum width and the row area scrolls **horizontally** under the same sticky header rather than crushing the columns. Column order is adjustable per home by dragging a column title and is memorized across sessions (the `recentsColumnOrder` setting, Section 8); tapping a header title reveals small left/right controls for touch use, tapping elsewhere hides them, and keyboard users get the same controls on focus plus Alt+Left/Alt+Right. Column widths are adjustable by dragging the separators at the header's column edges and are memorized per home across sessions (the `recentsColumnWidths` setting, Section 8); when a column is moved, its width moves with it. No column shrinks below a small minimum, and the columns always fill the table's current width (the larger of the container width and the table minimum), so resizing redistributes width between neighbors and never changes the scroll range. The resize separators live only in the header row, so they coexist with horizontal scroll: a swipe on the body still scrolls the table, while a drag that starts on a header-edge separator resizes (it sets `touch-action: none` and captures the pointer, so it never scrolls). On coarse-pointer (touch) devices the grab zone is widened to a tappable size and given a faint persistent grip, since there is no hover to reveal it; on fine-pointer devices the grip appears on hover. Diverged (and unsynced) rows render with a bold name and an attached `•` prefix (no separating space) — red for diverged; missing rows render grayed with `Not found` in the `Last synced` cell while the `Path` cell remains the real folder path; ineligible-name rows (renamed remotely outside `.txt`/`.text`) render grayed with their real current name and path (Section 9).
- The draft/Files action buttons sit below the block (Section 10 layout/breakpoints).
- The home card sits in a full-height scroll container and is vertically centered when it fits. When the content (block + action buttons) is taller than the window — a short window, large fonts, or a long recents list — the whole card scrolls as a unit, so the action buttons always stay **inside** the card's frame instead of spilling past its bottom edge. This must hold at every width, including the narrow-phone breakpoint.
- The home Settings (gear) and the passive `Update available` indicator keep their existing upper-right placement on the screen, outside the Dropbox block.

Main editor layout:

- Top toolbar in three groups — left status (the **Home** button and a two-line status), the actions row, and a corner pair (**Read-only**, **Settings**). On narrow screens (≤640px, the same breakpoint as the search-panel/preview restack) the toolbar is two rows: status left and corner right on row 1, every other control on row 2. From 641px up all three groups share one row, with the corner pair at the far right behind a thin divider. Line 1 names the open document — the bound local file's name, the open Dropbox file's name, or **Draft** — and truncates long names with an ellipsis. Line 2 is the save status: **Opened** from unlock/create until the first completed save of the session, then **Autosaved** — a freshly opened document never claims an autosave that has not run; the other states are **Unsaved changes**, **Encrypting autosave...**, and **Autosave failed**. In a Dropbox file session the compact sync state is appended after a `·` (**Synced**, **Unsynced**, **Offline**, **Conflict**, **Check Dropbox**, **Not linked**); there is no separate sync line. The actions row, in order with separators between groups: Undo, Redo | Find (and the Markdown preview toggle in markdown mode) | Insert Random String, Change Password | the storage actions; it scrolls horizontally when it overflows. Tapping **Home** asks for confirmation first — an `Exit?` alert with `OK`/`Cancel` — so a stray tap cannot drop the session back to the locked home. Pressing **Escape** in the editor is the same as tapping **Home** (it opens that same `Exit?` confirmation), and stands down when a dialog or the search panel is open (Escape there does its own thing). There is no Save / sync-now button in any mode. The storage actions are **Save As** for local-file sessions and for drafts opened from the Local files home; and **Dropbox** (save a copy to / promote to Dropbox — muted/grayed when unlinked, since linking is initiated only from the Home screen) plus **Export to Files** for Dropbox file and draft sessions (Section 4).
- The compact Dropbox sync labels mean:
  - **Synced** — the current Dropbox file is locally saved and the selected record's latest known state is synced with Dropbox.
  - **Unsynced** — local edits exist that have not reached Dropbox yet, autosave/upload is in flight, or the app has a queued pending Dropbox sync.
  - **Offline** — the app is offline, or the last Dropbox sync attempt ended offline; encrypted edits remain saved locally and sync later.
  - **Conflict** — the selected file has diverged from Dropbox and must go through Resolve before normal syncing resumes.
  - **Check Dropbox** — Dropbox is linked, but the selected-file sync state is blocked, unknown, or needs a Dropbox-side action/message review; examples include a recoverable Dropbox API error, a missing selected file, a pending account-switch decision, or a selected-file state that has not loaded yet. A selected file that is proven clean by a no-op check or sync clears an old recoverable error and returns to **Synced** instead of continuing to show **Check Dropbox**.
  - **Not linked** — the current document is not connected to a linked Dropbox account.
- Undo and Redo are disabled when there is no available undo or redo action. There is no Save button to enable/disable; the **Dropbox** button is muted/grayed and inert while Dropbox is unlinked (Section 4), and the Line-2 **Autosave failed** state drives the failure handling (the escalated Home confirm and the auto-lock soft-lock, Section 10).
- Editor fills remaining viewport.
- In `markdown` mode, a preview toggle opens the Markdown preview as a pane within the editor area (for example a side-by-side split on wide screens or a swap/overlay on narrow screens). The preview is hidden and the toggle is absent in `plain` mode.
- Status bar shows line/column, character count, word count, editor mode, document kind, and sync state when applicable.
  - Line and column are 1-based (column counts user-perceived characters from the line start to the primary selection head).
  - The character count is the whole-document count in user-perceived characters (extended grapheme clusters via `Intl.Segmenter`, falling back to Unicode code points where unavailable), so emoji and combined CJK count as one. When a selection is non-empty, the count area also reports the selection's grapheme length (for example `100 chars (3 selected)`).
  - The word count is the whole-document count of word-like segments (`Intl.Segmenter` word granularity with `isWordLike`, which ignores whitespace/punctuation and segments space-free scripts such as Japanese; where `Intl.Segmenter` is unavailable it falls back to a whitespace split). When a selection is non-empty, it also reports the selection's word count (for example `100 words (3 selected)`).
  - Editor mode is shown as `Plain text` or `Markdown`; the document kind as `Local file`, `Dropbox`, or `Draft`; sync state is shown only in a Dropbox file session.
  - The position/count group is left-aligned and the mode/provider/sync group is right-aligned — including when the status bar wraps to two lines on narrow screens, where the mode group keeps hugging the right edge of its own line (with the search match summary, when present, to its left).
- Keyboard-driven chrome retraction: while the on-screen keyboard is up **for the editor itself**, the status bar is hidden in every orientation, and on short screens (500px tall or less — landscape phones, where the keyboard leaves almost no height) the toolbar is hidden as well. Everything returns the moment the keyboard closes or focus leaves the editor. Focus in the find/replace boxes retracts **nothing**: the toolbar stays reachable and the match summary in the status bar stays visible while typing a query. Desktop and hardware-keyboard sessions never trigger retraction (there is no on-screen keyboard to detect).
- Mobile toolbar may collapse into compact icon buttons.
- Layout respects iOS safe-area insets.

Settings dialog:

- Opened from a Settings button in the main editor toolbar.
- Controls theme: Light, Dark, or System.
- Controls editor font from system/browser-available fonts only; no remote or app-specific fonts.
- Controls editor font size.
- Controls spellcheck, autocorrect, and autocapitalize.
- Controls line wrapping, whitespace visibility, editor mode, and the document's read-only flag (the checkbox mirrors the toolbar toggle and performs the same flag-flipping save — it is document state, not a persisted setting).
- Controls the auto-lock inactivity timeout (Never by default, or a preset number of minutes); the choice is persisted in the `settings` store (see Section 10, Auto-Lock).
- Controls the length of the inserted random string (a number input like font size; default 12, range 1–128); the choice is persisted in the `settings` store (see Section 11, Random string insertion).
- Displays the read-only build version identifier (git commit short hash and build timestamp) for provenance, so a user or auditor can confirm which build is running and match it to a published release.
- The `Done` button sits in a pinned footer that stays visible while the options scroll inside the dialog (the version string scrolls at the very end of the options). Applies to both the editor and the home settings dialogs.
- Opening a settings dialog never auto-opens a control: the dialog itself takes focus when its first control is a dropdown, because iOS Safari pops the picker for a focused `<select>`.

Locked-screen (home) settings:

- The locked/home screen shows a Settings button in the upper-right corner, using the same settings icon as the editor toolbar.
- It opens a focused dialog that configures only the locked-context preferences: Theme (System/Light/Dark), the auto-lock timeout (Section 10), the Storage provider (Section 4: Local files or Dropbox — no "Automatic" entry), the default KDF policy for future password-choosing dialogs (Section 6), and the optional Secret key (Section 6). On platforms without the File System Access API (for example Firefox or mobile), the Local files option is shown grayed out and cannot be selected; the app never renders a Local File home whose actions cannot work.
- These locked-context preferences are persisted in the `settings` store. Changing the storage provider here re-resolves the active provider and reloads the locked-screen state for the newly selected provider. Changing the default KDF policy rewrites no existing file or cache entry and does not alter the ordinary-save policy of an already opened editor session; it only changes the initial hardening value offered by future create-password dialogs. Provider selection, KDF default changes, and Secret key changes are intentionally exposed only while locked.
- The KDF policy control and Secret key controls live in an **Advanced Settings** section near the bottom of the locked/home Settings dialog, separated from the ordinary provider controls and above the version/update area. The Storage provider selector, Dropbox account label, and Dropbox link action stay visually adjacent and must not be split by Advanced Settings controls. The collapsed Advanced Settings summary reads `Show`; when expanded it reads `Hide`. The KDF policy control appears above the Secret-key block, is labeled `Password hardening`, and offers only `Standard` and `Strong`; it does not expose raw `opslimit` or `memlimit` fields and does not offer a maximum/cap option. Selecting `Strong` from `Standard` shows the memory/performance warning from Section 6 and persists only after confirmation. Below it, the Secret-key block displays the configured canonical Secret key string in a selectable read-only field when set, or `Not set` otherwise, plus `Generate`, `Clear`, `Paste`, and `QR` actions. `Generate` warns that files saved while the key is set require the same key on every device and that losing it can make those files unreadable; when a key is already set, `Generate` uses the stronger replacement warning below and encourages recording/backing up the current key first. Confirming replaces the local key. `Clear` warns that Secret-key-protected files cannot be opened on this device until the same key is pasted again; confirming removes only the local key and rewrites no files. `Paste` requires user activation and uses the Clipboard API when available; if clipboard read is unavailable or denied, `Paste` opens a one-field manual paste dialog. Clipboard failures never clear or alter the existing key. `Paste` confirms before replacing an existing key (Section 6). `QR` is enabled only when a key is set and opens the QR popup described in Section 6. Status and error feedback for these actions (`Secret key pasted.`, `Secret key cleared.`, `Invalid Secret key.`, …) appears inside this section, below the Secret-key action row — not on the home banner the dialog would cover — and auto-dismisses.
- Directly below the Storage provider control, and only while Dropbox is the selected provider, the dialog shows the same current Dropbox connection action as the Home Dropbox block: `Unlink Dropbox` plus the connected account email when linked, `Relink` when authorization is lost, or `Link` when unlinked. With Local files selected these controls are hidden, not disabled. Pressing Unlink closes Settings and opens the Unlink confirmation modal (Section 16).
- The dialog also displays the read-only build version identifier (git commit short hash and build timestamp) for provenance and provides a `Check for updates` button that runs the user-initiated update check (Section 14):
  - While the check runs, a "checking for updates" dialog appears with a `Cancel` action. The check is time-bounded so it cannot hang; `Cancel` lets the user dismiss it immediately and suppresses any late result. (This dialog is never actionless/unclosable, even on a stalled network.)
  - When a newer version is available, an "update available" dialog appears with `Update` and `Cancel`. `Update` downloads and activates the new build and reloads the app; `Cancel` dismisses the dialog and keeps the current build.
  - When the running build is already current, an "app is up to date" dialog appears with `OK`.
  - When the check cannot complete (offline, network failure, a stalled request that times out, or a missing/malformed `version.json`), a "could not check for updates" dialog appears with `OK`, and the current build is kept.
  - When applying a confirmed update fails or times out, a distinct "could not update" dialog appears with `OK`. The current build is kept if the failure precedes the activation request; on an activation timeout the dialog reflects the UI giving up, but the worker may still finish in the background and a later reload could move to the new build (see §14 — apply is best-effort, not transactional, on the timeout path). Applying itself is not cancelable once `Update` is pressed.
- When the browser has staged a newer build in the background (Section 14, Version pinning and staged updates), the locked/home screen shows a passive `Update available` indicator — for example a small badge near the Settings button. The indicator is informational only: it never starts an update on its own, and the user applies the update through `Check for updates` → `Update`. It is shown only while locked.
- Checking for updates, the `Update available` indicator, and applying an update are intentionally exposed only while locked, so an update never activates during an unlocked editing session.

## 16. Error Handling

Message lifetime: ordinary message-strip feedback, including error-tone feedback such as `File not found.`, dismisses itself after about 5 seconds or when replaced by a newer message. Durable failure states that require a decision or protect unsaved data are not message strips: they remain as dialogs or banners (for example autosave failure, soft-lock, and Dropbox conflict/Resolve states) until the user resolves or leaves them.

Generic unlock/import failure (shown inside the unlock password dialog, which stays open for retry):

```text
Could not unlock. Check the password or file.
```

Secret-key-required unlock with no key supplied (shown inside the unlock password dialog when the file requires a Secret key and its inline Secret-key field is empty and none is configured — the dialog stays open with the field expanded for entry):

```text
Enter this file's Secret key, or add it in Settings.
```

Secret-key mode changed under the dialog (shown inside the unlock password dialog when the file was `none` as the dialog opened but a concurrent write made it `required-v1` by the time the unlock is attempted, so the dialog has no inline field to enter the key — the user reopens to get one):

```text
This file changed and now needs a Secret key. Reopen it to continue.
```

Secret-key-protected unlock failure after a decrypt attempt (shown inside the unlock password dialog, which stays open for retry):

```text
Could not unlock. Check the password or Secret key.
```

Create-password mismatch (shown inside the create-password dialog; blocks creation):

```text
Passwords do not match.
```

Password hardening warning (shown as a modal OK/Cancel prompt before a Settings change from `Standard` to `Strong`, and before a password dialog turns `Use strong password hardening` on from an initial Standard state):

```text
Strong password hardening uses more memory and may be slower or fail to open on older devices. Files saved with Strong require that memory on every device. Continue?
```

Remote change detected in a Dropbox file session (the editor **Resolve banner**, Sections 4 and 9; pushing stops, autosave to cache continues — the banner stays until the conflict is resolved or refreshed):

```text
File changed on Dropbox.
```

Offline, the same banner explains that resolution needs a connection:

```text
File changed on Dropbox. Resolving needs a connection; your changes are saved locally.
```

Draft replacement and deletion confirmations (OK/Cancel):

```text
Replace the draft?
```

```text
Delete the draft?
```

Secret key settings confirmations and errors. The confirmations are modal OK/Cancel prompts; the status/error messages (`Invalid Secret key.`, `Secret key pasted.`, `Secret key cleared.`, …) render **inside the Settings dialog**, below the secret-key action row — never on the home banner the open dialog would cover — and auto-dismiss:

```text
Files saved while Secret key is set require the same key on every device. Losing it can make those files unreadable. Continue?
Generate a new Secret key? Files saved with the current key cannot be opened unless you paste the current key again. Record the current key first if you need it.
Replace the current Secret key? Files saved with the current key cannot be opened unless you paste it again. Record the current key first if you need it.
Clear Secret key? Files that require it cannot be opened on this device until you paste the same key again.
Invalid Secret key.
Secret key pasted.
Secret key cleared.
```

Delete from list (the `Delete from list` row-menu item, OK/Cancel; the second form is required when the file's cache holds unsynced local changes):

```text
Remove from recent files? This deletes the browser-local cached copy. The Dropbox file is not deleted.
```

```text
This file has local changes not yet on Dropbox. Remove anyway? The unsynced changes are lost.
```

Unlink confirmation (shown only when a cache holds unsynced changes, from Home Settings; Cancel/Unlink):

```text
This unlinks Dropbox from this app. Cached files stay visible and can be opened read-only or exported. Files with changes not yet on Dropbox will not sync until Dropbox is linked again.
```

Missing-row state (the recent-files `Last synced` cell text, Section 9 — not a toast):

```text
Not found
```

Account-switch guard (Section 9; Continue/Cancel — Cancel stays unlinked and changes nothing):

```text
This is a different Dropbox account. Continue with <account>? Cached files from the previous account will be lost. The draft is kept.
```

Here `<account>` is the pending account's email/display label (`pendingAccountSwitchLabel`) when available, falling back to `pendingAccountSwitch` only when account-info lookup fails.
The cached-files sentence is omitted when no cached envelope exists.

The one-time confirmation for an install with recent files but no stored `accountId` (Section 9) names the linked account the same way but discards nothing.

Link with retained authorization (pre-OAuth, Section 9; Cancel/Switch/Continue; `<email>` is `accountLabel`):

```text
Continue with this account? This app has authorization for <email>. Continue with this account, or switch to a different one.
```

Save failure (a failed local write — the only copy is in memory; the two exit branches are Section 10):

- The save-status line (Section 15) reads `Autosave failed`; editing continues and Export stays available throughout (the universal savior).
- On a **voluntary** exit (Home / manual lock) of a failed + dirty document, show the escalated confirmation `Couldn't save changes` — *"Couldn't save your latest changes — they'll be lost if you exit."* — with `Export a copy` / `Exit anyway` / `Stay`.
- On **auto-lock** of a failed + dirty document, soft-lock: black out the editor behind the `Unsaved changes not saved` password overlay (*"Unsaved changes will be lost if you exit now. Enter password to continue."*) offering `Exit & discard` and, after correct-password re-entry, `Continue` / `Export a copy`. The session is retained in memory and a successful background retry upgrades it to a hard lock.

Local file permission failure:

- Keep encrypted recovery copy in IndexedDB.
- Show `Needs file permission`.
- Ask user to reopen or reselect the encrypted local file.
- Do not silently switch to Dropbox.

Local file missing (moved, renamed, or deleted):

```text
File not found.
```

- Shown instead of the generic unlock failure; the condition is detected at the filesystem level before decryption and reveals nothing about the password or envelope contents.
- Keep the recent-file entry so the user can relocate the file with `Browse` or remove it with `Delete from list`.

Draft deletion (Dropbox-Mode home):

```text
Draft deleted.
```

- Shown after a confirmed `Delete draft`; a failed deletion shows `Could not delete the draft.` and leaves the draft unchanged.

Local file diagnostics:

- Local File Mode may expose metadata-only diagnostics for local-file startup, browse, open-recent, permission, read, parse, and unlock operations.
- Diagnostics may be published to `window.__ENOTEWEB_LOCAL_FILE_DIAGNOSTICS__`, dispatched as `enoteweb-local-file-diagnostic` custom events, written to development console logs, and shown in a local-file diagnostic panel.
- Diagnostic entries may include source/stage, file or handle name, file size/type/last-modified timestamp, envelope byte/character counts, trimmed character count, an envelope SHA-256 prefix, parsed envelope metadata such as version/KDF/AEAD names and salt/nonce/ciphertext byte lengths, permission state/mode, user-activation state, and error name/message.
- Diagnostics must be bounded in memory and must not be treated as durable document storage.
- Diagnostics must never include plaintext document content, password, Secret key string or bytes, derived key bytes, ciphertext text, full salt or nonce values, OAuth tokens, search query, replacement text, plaintext diffs, merge content, or document snippets.

Sync failure:

- Keep local encrypted changes.
- Mark status `pending-local` or `error`.
- Retry on user action or connectivity return.

Conflict:

- Do not overwrite remote or local data silently.
- Show conflict editor or export options.

Development logs:

- May include structured categories such as `parse_error`, `unsupported_version`, `decrypt_failed`, `storage_failed`, `sync_failed`.
- Must never log plaintext, password, Secret key string or bytes, derived key bytes, salt, nonce, ciphertext, OAuth tokens, or document snippets.

### Test-Only Globals And Readiness Hooks

The app may expose narrowly scoped globals for automated tests and implementation diagnostics:

- A development-only storage override may force the browser-local draft path in automated tests.
- `window.__ENOTEWEB_SW_READY_STATE__` may expose service-worker readiness as `unsupported`, `disabled`, `ready`, or `error`.
- `window.__ENOTEWEB_LOCAL_FILE_DIAGNOSTICS__` may expose bounded metadata-only local-file diagnostics as described above.

These globals are not product storage APIs and must not be required for normal user workflows. They must never contain plaintext document content, passwords, Secret key strings or bytes, derived key bytes, OAuth tokens, search or replacement text, plaintext merge content, or document snippets.

Behavior-altering test hooks must be gated behind a build flag and compiled out of production builds. In particular, development-only storage overrides must have no effect in a production build so that setting a global cannot steer a production user onto a different, potentially weaker storage provider. Read-only diagnostic surfaces (`window.__ENOTEWEB_SW_READY_STATE__`, `window.__ENOTEWEB_LOCAL_FILE_DIAGNOSTICS__`) may remain in production builds, but only as the strictly read-only, metadata-only values constrained above; they must never alter provider selection, storage, or crypto behavior.

## 17. Testing And Acceptance Criteria

Unit tests:

- crypto roundtrip
- wrong password failure
- tampered ciphertext failure
- tampered metadata failure
- unsupported algorithm rejection
- fresh nonce on repeated saves
- UTF-8 roundtrip with ASCII, Japanese text, emoji, newlines, and long text
- envelope parser rejects malformed files
- canonical AAD stable across JSON field order
- canonical AAD sorts nested object keys recursively
- noncanonical AAD variants are rejected
- envelope missing `app`, or with a wrong `app`, is rejected
- generated envelopes always include `secretKey`; an envelope with absent `secretKey` is read as `"none"` and writes the field on the next save; any present value other than `"none"` / `"required-v1"` is rejected
- `secretKey: "none"` decrypts with password only even when a local Secret key is configured
- `secretKey: "required-v1"` requires the same Secret key (supplied from the Settings key or the unlock dialog's inline field) and password; with no key available the app does not run KDF and prompts for the key, and a wrong password or wrong Secret key uses the Secret-key-protected generic unlock failure
- Secret-key-protected KDF input is passed as a `Uint8Array` and zeroized after derivation; a high-byte generated-key roundtrip succeeds, and concatenation ambiguities such as `(password="ab", key="c")` versus `(password="a", key="bc")` cannot collide
- fresh envelopes store direct numeric `opslimit` and `memlimit` fields, not a Settings policy id; the local `kdfPolicy` setting defaults to `"standard"`, persists `"standard"` / `"strong"`, sanitizes unknown values back to `"standard"`, selecting `Strong` in Settings warns and persists only after confirmation, and `strong` writes `opslimit = 4` plus `memlimit = 134217728`
- envelope with an extra unknown metadata field still decrypts (additive forward compatibility), and tampering with that unknown field fails decrypt
- URL-safe or unpadded Base64 in `salt`/`nonce`/`ciphertext` is rejected
- unsupported envelope version is rejected
- Save As reuses the current session password with no prompt (both a bound-file Save As and a draft promotion), encrypting a fresh envelope under that current password and the session's captured KDF parameters; the session password and KDF parameters are unchanged by Save As
- a Change Password rotation (fresh encrypt of the plaintext under the new password, which may equal the old password) re-encrypts in place at the hardening selected in the dialog with a fresh salt and nonce, the session continues under the new password and selected KDF policy (post-rotation autosaves keep both), and the old password no longer decrypts the document when the password string changed
- opening an envelope whose stored `opslimit`/`memlimit` differ from the local `kdfPolicy` does not change the local setting; ordinary saves preserve the opened envelope's numeric KDF fields, Change Password initializes from the current file and adopts only the dialog-selected policy, and verbatim envelope-copy flows preserve the stored numeric KDF fields exactly
- Save As onto a different file rebinds the session: subsequent autosaves write the picked file, the previous file is left at its last saved content, and undo/redo history survives the rebind
- the read-only flag round-trips through encrypt/parse/decrypt; toggling it saves immediately and the flag persists across lock/unlock (and devices, via the envelope); a flag-less envelope opens writable; a Save As copy inherits the flag; an envelope carrying the flag as an unknown field still unlocks in a reader that does not otherwise use it
- Export (the draft, and the per-file Export in the missing/authorization-lost states) writes the stored envelope verbatim without requiring the password and without modifying or deleting the source record
- Import, stored-envelope Export, missing/auth-lost per-row Export, and locked-draft home promotions preserve the envelope's `secretKey` metadata exactly because they copy ciphertext rather than re-encrypting
- Import accepts a `required-v1` envelope without a configured Secret key because it stores the ciphertext only; the missing-key message appears later at unlock
- an unlocked session captures the Secret-key write policy and validated key payload at create/unlock: ordinary saves, autosaves, Save As, Dropbox destination writes, and current-document Export keep using that policy even if another tab changes or clears the home Secret key; Change Password initializes from the current file's mode and may change it only through its own toggle
- an unlocked session captures KDF parameters at create/unlock: autosave, Save As, Dropbox destination writes, read-only toggles, conflict-resolution commits, and current-document Export preserve them even if the locked/home Password hardening default changes; Change Password to the same password is the active way to adopt a different Password hardening value
- no automatic promotion: opening a `none` file while a Secret key is configured keeps it `none` across edits and saves; a `required-v1` file opened with the matching key (from Settings or the unlock dialog's inline field) stays `required-v1`
- the create-password / change-password dialogs order controls as Password, Confirm password, `Use strong password hardening`, then `Use secret key`; the hardening toggle writes Standard or Strong numeric KDF params, initializes from Settings for New draft and from the current file for Change Password, warns only when turning on from an initial Standard state, and can change hardening with the password unchanged
- the create-password / change-password `Secret key` toggle controls the written mode: a new draft writes `required-v1` (toggle on) or `none` (toggle off); Change Password initializes the toggle from the current file's Secret-key mode, with the toggle on converting a `none` document to `required-v1`, and with the toggle off converting a `required-v1` document to `none` (password-only), with the password optionally unchanged
- the `Secret key` toggle is disabled and off when no key is available (no Settings key and no session key); a keyless device can open, edit, and remove protection from a `required-v1` file (reusing the key entered at unlock) but cannot create or add `required-v1`; the create toggle defaults on when a key is configured and the change toggle defaults to the document's current mode
- the unlock dialog's inline Secret-key field opens a `required-v1` file with a key that is never written to Settings (session-only); the disclosure is collapsed by default when a Settings key exists and expanded when it does not
- the Secret key `QR` popup encodes the exact configured key string, is produced on-device with no network request, and is disabled when no key is set; the rendered code is not persisted, logged, or exported, and a device that scans it recovers the same string `Paste` accepts
- verbatim promotion of a `none` draft stays `none` even when a Secret key is configured
- Import over an existing draft (`Replace the draft?`, asked after the file is picked) and Delete draft each require an explicit confirmation; Cancel leaves the draft untouched
- recent-files list rules: most-recently-opened ordering, the target cap of 20 (a hard limit only when eviction is possible — unsynced records are never silently removed, so the list may temporarily exceed it), deleting the selected row clears the persisted selection
- background-check derivation: stale-but-clean is never marked as a conflict; diverged requires both a remote change and unsynced local changes; a by-id probe returning a changed name or path updates the record silently (a new extension outside `.txt`/`.text` grays the row export-only instead); an id that no longer resolves becomes replacement-candidate only when an eligible different-id file exists at the exact same stored path/name, otherwise missing; pending-push flushes a pending envelope revision-conditionally; indicators are never persisted
- the account-switch guard: a matching or unknown stored `accountId` proceeds and stores the id; a different id stores the returned token in the normal token slot but blocks every Dropbox operation while `pendingAccountSwitch` is set, wipes recent files and caches only after explicit confirmation, and cancel clears the returned token/pending label while leaving the previous owner and caches intact; the draft is never wiped
- the first-sync gate: a first check that reports a remote change (stale or diverged) pauses pushing while cache autosave continues; a check that fails or has not yet landed does NOT block pushing — every push stays revision-conditional, and the conditional rejection is the gate's backstop (Section 9)
- IndexedDB stores encrypted envelopes only
- Local File Mode recent-file list append, active selection, duplicate same-file replacement, and delete-from-list behavior
- search literal, regex, replacement, named captures, automatic highlighting, invalid regex, match cap, timeout
- empty-capable patterns (`^`, `$`, `\b`, `a*`) are accepted, do not hang, skip zero-length matches, and collect only non-empty runs
- regex search reuses a single persistent worker across requests; a timeout terminates and respawns it and a subsequent regex search still works
- a superseding regex request is not blocked by a previous in-flight request
- the search worker is terminated on lock and retains no document text, query, or replacement between sessions
- three-way merge clean merge and conflict cases
- stale/unrecognized `baseRev` (or missing base snapshot) is treated as a conflict, never a fast-forward upload
- the status-bar character count is measured in user-perceived characters (extended grapheme clusters): ASCII and CJK count one-to-one, and a multi-code-unit emoji or ZWJ emoji sequence counts as a single character
- the status-bar word count counts word-like segments (ignoring whitespace and punctuation) and segments space-free Japanese text into more than one word

Browser tests:

- create a document (New draft)
- unlock
- wrong password
- edit and autosave
- reload and unlock edited content
- Windows/Chromium Local File Mode open, save, reload, reopen same encrypted file
- Browse opens previous-version encrypted local files after app rebuild
- Local File Mode recent-file list renders multiple rows and deletes only selected rows from the list
- Local File Mode permission loss and reselect flow
- export encrypted file
- import encrypted file in fresh browser context
- no localStorage/sessionStorage document persistence
- offline launch after service worker installation
- offline edit and reconnect sync
- Dropbox link, upload, download, revision match, revision conflict
- conflict resolution upload
- Dropbox file browser lists folders, eligible files, and grayed ineligible entries in fixed group order; column-header taps toggle ascending/descending within groups; each opening starts at the default sort
- Dropbox file browser one-tap open selects an eligible file; Upload through the browser confirms before overwriting an existing path; the destination filename auto-appends `.txt` when no `.txt`/`.text` extension is given; there is no manual typed-path entry
- Dropbox file browser surfaces a listing failure with Retry (never as an empty folder) and a mid-browse authorization loss (expired, revoked, or missing scope) as a relink prompt without retry loops; listing metadata is never persisted
- a confirmed overwrite uploads revision-conditionally against the revision observed at the existence check; an intervening remote change re-surfaces the confirmation with fresh metadata instead of overwriting
- the locked/home screen has no password field; unlock and creation passwords are collected in dialogs (single-field unlock; create/Change Password dialogs show Password, Confirm password, `Use strong password hardening`, then `Use secret key` when available/relevant), and a mismatched confirmation blocks creation
- file-writing flows resolve their destination before any password step — Save As opens its picker first and then reuses the current password with no dialog, `New draft` deliberately has no destination step, and the promotion collects no password; cancelling a password dialog (New draft or Change Password) creates or writes nothing and leaves the session and selection state unchanged

Browser tests for the home screen:

- the recent-files table populates on Browse open and on draft promotion, orders most-recently-opened first, holds the target cap of 20 (exceeding it only while unsynced records block eviction), persists its selection across reload, and `Open` is disabled with no selection
- `Delete from list` (long-press/right-click) confirms, removes the record and its cache, never touches the Dropbox file, and uses the stronger warning when the cache holds unsynced changes
- the background check marks a diverged row (red, `•` prefix, `Open` → `Resolve`), a replacement-candidate row (same red `Resolve` treatment, adoption confirmation before any id rewrite), and a missing row (grayed, `Not found` in `Last synced`, `Open` → `Export`); indicators are session-only — an offline relaunch shows none
- a stale-but-clean file refreshes by download without a password and never shows the conflict indicator; an `Open` on a known-stale file while online opens the fresh content
- the first-sync gate: opening an old cache before the check completes shows the Resolve banner (`File changed on Dropbox.`) and stops pushing; exiting unmodified refreshes the cache; a modified session reaches the merge flow through the Resolve banner, and the home `Resolve` collects the password first
- a remote rename or move updates the row's name and path silently (no indicator); a rename outside `.txt`/`.text` grays the row export-only and a rename back restores it; a deleted id with no exact same-path candidate shows `Not found`
- the home background check flushes pending offline edits of files that are not open, revision-conditionally; a conditional failure reclassifies the row as diverged
- draft actions: `New draft` ↔ `Edit draft` label rule (caches do not count), `Delete draft`/`Export draft` disabled with no draft, promotion empties the draft slot and inserts the new file at the top of the recents, selected
- `Import draft` replaces only the draft, asks `Replace the draft?` after picking, and never touches Dropbox state
- the authorization-lost block: `Relink` label, `Browse` disabled, `Open` → `Export`; caches are not editable; unsynced changes made before the loss resume syncing after relink
- `Unlink` (in Home Settings) confirms only when unsynced cached changes need naming; it keeps recents/caches and retained authorization, shows cached recents on Home, and opens cached rows under the app-imposed read-only lock; pressing `Link` with retained authorization first asks `Continue with this account?`; `Switch` forgets only the retained grant and forces Dropbox reauthentication; linking a different account triggers the account-switch guard
- no plaintext marker in IndexedDB or exported file
- the app issues no `version.json` request on launch, on a schedule, or on connectivity changes; the app fetches `version.json` only when the user invokes "Check for updates" (the browser's own background re-check of the service-worker script is separate and never activates an update)
- a newer `version.json` shows the "update available" dialog, and choosing Update precaches the new build into a new cache and prunes superseded caches only after the new cache is complete
- a same-or-older `version.json` shows the "app is up to date" dialog and keeps the current cache
- offline, 404, or malformed `version.json` shows the "could not check for updates" dialog and keeps the current cache
- the Check for updates and Update actions are reachable only from the locked/home screen, so an update never activates during an unlocked session
- a newly published build does not change the running app across reload or relaunch; the installed app stays pinned to its version until the user confirms `Update`, even after a browser-initiated background service-worker update (no `skipWaiting`/`clients.claim` swaps the running build on its own)
- a staged newer build surfaces a passive `Update available` indicator on the locked/home screen without activating; `Cancel` leaves the pinned version unchanged, and only `Update` repoints the pinned version and reloads
- `Update` succeeds both when the staged build's service worker is still `waiting` and when it has already activated in the background while serving the pinned cache (so `registration.waiting` is null and the active worker must be driven instead); in both cases the pin repoints to the offered build and the app reloads onto it
- `Update` refuses to activate a worker whose reported build identifier does not match the offered manifest version, so a manifest/worker skew never silently installs a different build
- a manifest with a missing `version`, or a missing or malformed (non-ISO-8601-UTC) `builtAt`, yields "could not check" rather than an update offer; freshness is decided by parsed timestamp, not string comparison
- under a subpath deployment (project Pages base such as `/<repo>/`), the service worker registers at the app's base scope and the precached app-shell, navigation fallback, `version.json`, and manifest icon/`start_url` all resolve under that base
- the build version identifier is embedded in the bundle and shown read-only in the Settings dialog
- auto-lock defaults to Never, persists the selected timeout across reload, resets on activity, and locks after the inactivity timeout elapses
- the locked/home screen exposes a Settings button that opens a Theme / auto-lock / storage-provider dialog
- the locked/home Settings dialog keeps the KDF policy control and Secret-key controls in an Advanced Settings section near the version area, with `Password hardening` above the Secret-key block and Storage provider / account / Unlink still adjacent; the collapsed summary action reads `Show`, the expanded summary action reads `Hide`, expanding Advanced Settings shows the configured canonical opaque key string in a selectable read-only field, and Generate/Clear/Paste/QR behave as specified: Generate and Clear confirm the data-loss implications, Paste validates the canonical key format (with a manual-paste fallback when clipboard read is unavailable), clearing the key does not rewrite files, QR is enabled only when a key is set and opens a popup that renders the exact key string as an on-device QR code without displaying the string as text (no network request), and `Password hardening` offers only `Standard` / `Strong` with the `Strong` warning/confirmation
- with the create-password `Secret key` toggle off (or disabled because no key is configured), a new draft/file writes `secretKey: "none"` and opens with password only; with the toggle on, it writes `secretKey: "required-v1"` and opens on another device only after the same Secret key is pasted in Settings or entered in that device's unlock dialog
- a storage-provider override is persisted, applied at the next launch, and switching it on the home screen reloads the locked-screen state for the selected provider

Browser tests for editor storage and failure handling:

- the editor shows the mode/session button set of Section 4 — Local `Save As`; Dropbox `Dropbox` + `Export to Files` — and **no Save / sync-now button exists** in any mode
- the editor's primary destination button branches to a chosen destination and rebinds the session; an existing-path overwrite confirms with the consequence text and uploads revision-conditionally; the force-out-of-conflict path (the session's own file, matched by id) surfaces the fresh-probe consequence and replaces against the freshly-probed rev
- a diverged Dropbox session shows the **Resolve banner** (not a Save button); tapping it opens the merge flow online and explains offline; Export stays available throughout
- autosave failure + a voluntary Home / manual-lock exit shows the escalated confirm (`Export a copy` / `Exit anyway` / `Stay`) with inline Export; the document is not lost on `Stay` or `Export`
- autosave failure + auto-lock soft-locks (the editor content is removed from the DOM behind a password overlay), retains the in-memory session, gates `Continue`/`Export` behind correct-password re-entry, and a successful background retry upgrades to a hard lock (memory wiped); every other auto-lock still hard-wipes; crash/reload loss is explicitly out of scope
- the home draft row is mode-specific — Local `New/Edit · Delete · Save As`; Dropbox `New/Edit · Delete · Dropbox · Export · Import` (the home `Dropbox` promote muted while unlinked); the promotion buttons disable with no draft
- the home `Save As`/`Dropbox` promotions write the draft's stored envelope verbatim (no re-encryption), register the recent file, and clear the vault only after the write/upload succeeds — a failed promotion preserves the draft

Network/security tests:

- production bundle contains no CDN URLs
- served production app contains the expected CSP meta tag
- built `dist/index.html` contains the expected CSP meta tag
- built static-host header configuration contains the expected CSP header with `frame-ancestors 'none'`
- the meta CSP and the static-host header CSP carry the identical set of shared directives (the header policy differs only by the header-only directives, currently `frame-ancestors 'none'`), so the two copies cannot silently drift
- source `index.html` remains CSP-free for development mode
- CSP connect policy allows only app origin and Dropbox endpoints
- plaintext is never sent in network request body, URL, or headers
- Secret key strings and Secret-key KDF input bytes are never sent in network request body, URL, headers, logs, diagnostics, Dropbox metadata, or exported diagnostic surfaces
- Local File Mode makes no Dropbox API requests
- Dropbox upload body is encrypted envelope text only
- Markdown preview does not request remote resources
- the update check issues no requests outside the app origin (respects `connect-src 'self'`) and sends no document content or credentials
- production bundle contains no analytics, telemetry, crash-reporting, or tracking code or endpoints
- production build exposes no behavior-altering test hooks

Manual Windows tests:

- install app in Microsoft Edge or create Edge `--app` shortcut
- launch app from shortcut while default browser is not Edge
- verify app opens without normal browser tabs or address bar
- create encrypted local file
- create or browse multiple encrypted local files and verify they append to the recent-file list
- overwrite or browse the same physical file and verify the older recent-file row is replaced, not duplicated
- right-click a recent-file row and verify `Delete from list` removes only the table row, not the PC file
- save directly to same local file
- place file inside Dropbox desktop-synced folder and verify the app still treats it as an ordinary local file
- close and relaunch app
- reopen saved file and unlock
- revoke or lose file permission and verify reselect flow

Manual iOS tests:

- install from Safari to Home Screen
- launch from Home Screen
- create a draft
- edit, autosave, lock, unlock
- force-close and relaunch
- restart phone and relaunch
- airplane mode launch/edit/save
- reconnect and sync
- Dropbox OAuth linking completes after the round-trip returns to (or is reopened from) the Home Screen app
- conflict scenario with another device
- encrypted export

Manual Android tests:

- install from Chrome to Home Screen/app launcher
- launch installed PWA
- create a draft, or open a Dropbox file through the recents/browser
- edit, autosave, lock, unlock
- airplane mode launch/edit/save
- reconnect and sync

Acceptance criteria:

- `npm test` passes.
- `npm run build` passes.
- Playwright tests pass.
- Windows Edge app-window smoke test passes.
- Real iPhone Home Screen smoke test passes.
- No plaintext marker appears in IndexedDB, local encrypted file, exported encrypted file, Dropbox upload, service worker cache, localStorage, or sessionStorage.
- App remains usable offline and safely saves through Local File Mode or syncs encrypted changes after reconnect in Dropbox Mode.
