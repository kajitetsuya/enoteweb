# eNoteWeb

eNoteWeb is a private, end-to-end-encrypted text editor that runs in your
browser and can be installed like an app.

Your document content is saved only as encrypted `.txt` or `.text` envelope
files. The password, plaintext, and derived keys stay in memory only while a
document is unlocked. Dropbox, when linked, receives encrypted envelope text and
Dropbox file metadata, not plaintext.

## How to Install

### Windows Edge

1. Open `https://kajitetsuya.github.io/enoteweb/` in Microsoft Edge.
2. Click the install icon near the right side of the address bar.
3. Click `Install`.

If the install icon does not appear, open `Settings and more` (`...`) >
`More tools` > `Apps` > `Install this site as an app`.

### iOS Safari

1. Open `https://kajitetsuya.github.io/enoteweb/` in Safari.
2. Tap `Share`.
3. Tap `Add to Home Screen`.
4. Turn on `Open as Web App` if Safari shows that option.
5. Tap `Add`.

### Android Chrome

1. Open `https://kajitetsuya.github.io/enoteweb/` in Chrome.
2. Tap `More` (`...`) to the right of the address bar.
3. Tap `Add to home screen`.
4. Tap `Install` and follow the on-screen instructions.

## How to Uninstall

Before uninstalling, make sure any draft is exported, promoted to a local or
Dropbox file, or disposable. Removing the installed app or clearing site data can
delete browser-local data such as the draft, settings, Dropbox caches, and the
local Secret key. Local files and Dropbox files themselves are not deleted by
uninstalling the app.

### Windows Edge

1. Open Microsoft Edge.
2. Go to `edge://apps`.
3. Select `Details` on the eNoteWeb app card.
4. Select `Uninstall`.
5. Confirm whether to delete app history and data.

### iOS Safari

1. Make sure the draft is exported or disposable.
2. Touch and hold the eNoteWeb Home Screen icon.
3. Tap `Delete Bookmark`.

### Android Chrome

1. Make sure the draft is exported or disposable.
2. Open Android `Settings`.
3. Go to `Apps` > `See all apps`.
4. Tap eNoteWeb.
5. Tap `Uninstall`.

## Recommended Use

### Windows PC

1. Use `Local files` as the storage provider.
2. Keep your encrypted `.txt` or `.text` files in a Dropbox-synced folder if you
   want Dropbox Desktop to sync them outside eNoteWeb.
3. In the `Local files` block, use `Set path root` and choose your local Dropbox
   folder root. This only makes recent-file paths easier to read; it does not
   grant Dropbox access or restrict which files you can open.

### iPhone, iPad, and Android

1. Use `Dropbox` as the storage provider in Home Settings.
2. From the locked Home screen, tap `Link` and sign in to the same Dropbox
   account your PC uses.
3. Open and edit the same encrypted Dropbox files that your PC syncs through the
   Dropbox folder.

### General

- Use the same Secret key on every device that should open Secret-key-protected
  files.
- Record the Secret key somewhere safe before relying on it. A file saved with
  Secret-key protection needs both the password and the matching Secret key.
- Keep independent encrypted backups of files you cannot afford to lose.

## Who It Is For

Use eNoteWeb when you want a simple encrypted text editor for notes that can
work offline and does not require a server account for local use.

- On Windows or desktop Chromium browsers, `Local files` is usually the best
  storage provider.
- On iPhone, iPad, and Android, `Dropbox` is usually the best storage provider,
  because mobile browsers do not provide smooth persistent save-back access to
  arbitrary local files.
- A `Draft` is always available for creating or importing encrypted content
  before choosing a local file or Dropbox destination.

## First Use

Open the app URL in your browser. On iPhone or iPad, open it in Safari and use
`Add to Home Screen` if you want the installed app experience.

From the locked Home screen:

1. Open `Settings`.
2. Choose `Local files` or `Dropbox`.
3. Create a `New draft`, or browse/open an existing encrypted file.
4. Choose a password. eNoteWeb cannot recover forgotten passwords.

There is no manual Save button. While a document is unlocked, changes autosave
to the active destination.

## Storage Choices

### Local Files

`Local files` opens and saves encrypted `.txt` or `.text` files directly on
disk where the browser supports the File System Access API. If a local file is
inside a Dropbox-synced folder, Dropbox desktop sync is outside eNoteWeb; the app
still treats the file as an ordinary local file.

`Save As` writes the current encrypted document to a chosen local file and then
continues editing that file.

### Dropbox

`Dropbox` syncs user-selected encrypted Dropbox `.txt` or `.text` files. Link
Dropbox only from the locked Home screen; the OAuth round trip can reload or
leave the app, so linking is not started from an unlocked editor.

Each Dropbox file has its own encrypted local cache. If Dropbox is offline or
unavailable, cached encrypted changes are kept locally and sync later when
possible.

### Drafts

A draft is a single encrypted browser-local document that is not yet bound to a
local file or Dropbox file. Use it to start writing before choosing a durable
destination.

- In `Local files`, `Save As` promotes the draft to a local encrypted file.
- In `Dropbox`, `Dropbox` promotes the draft to a Dropbox encrypted file.
- `Export draft` writes a one-shot encrypted copy without changing the draft.
- `Import draft` reads an encrypted `.txt` or `.text` file into the draft; it
  does not upload to Dropbox or change existing Dropbox files.

## Editing

The editor supports plain text and Markdown source mode, sanitized Markdown
preview, find and replace, undo and redo, line wrap, visible whitespace, random
string insertion, read-only mode, and line-number copy.

The toolbar shows the document name, save state, and Dropbox sync state when
relevant. Use `Home` to leave the unlocked editor and return to the locked Home
screen.

## Passwords and Secret Key

Every document is encrypted with a password. Password changes are explicit:
use `Change Password` while the document is unlocked.

The optional `Secret key` is an extra local key used together with the password
for files saved with Secret-key protection. It is useful only if the same Secret
key is available on every device that should open those files.

Important limits:

- eNoteWeb cannot recover a lost password.
- A Secret-key-protected file cannot be opened without the matching Secret key.
- The Secret key is local to the current browser or installed app.
- The Secret key is not synced through Dropbox and is not stored in encrypted
  files.
- Clearing the Secret key setting does not rewrite existing files.

## Dropbox Conflicts

Dropbox sync is revision-aware. If Dropbox changed while this device also has
local changes, eNoteWeb pauses syncing and shows `File changed on Dropbox.`
Use `Resolve` when online to compare the versions and save the resolved result.

`Export to Files` remains available in Dropbox mode so you can save an encrypted
copy of the current document before resolving a conflict or leaving a session.

## Offline Use and Updates

The app shell works offline after it has loaded. Local File Mode can keep saving
to the selected local file while browser file permission remains available.
Dropbox Mode saves encrypted changes to its local cache and syncs later when
Dropbox is linked, online, and safe to sync.

Updates are explicit. The app can show that a newer build is available, but it
does not switch builds while a document is unlocked.

## Privacy and Security Limits

eNoteWeb is designed so plaintext and keys stay local to the running app while a
document is unlocked. It still has important limits:

- A weak password can be guessed offline if an attacker obtains an encrypted
  file.
- Browser-owned storage can be cleared by the browser, the operating system,
  private browsing cleanup, storage pressure, or app/site-data removal.
- If the hosted app itself is compromised, malicious code could read plaintext
  after you unlock a document.
- Dropbox can observe encrypted-file metadata such as account, path, file size,
  timestamps, IP address, and sync frequency when Dropbox sync is active.
- On static hosts without custom response headers, some browser protections such
  as `frame-ancestors` may not apply.

Keep independent encrypted backups of files you cannot afford to lose.

## Development

This repository is mainly a public source snapshot rather than a shared
contribution workspace. For local inspection or small maintenance changes:

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm test
npm run lint
npx tsc -b
npm run build
npm run test:e2e
```

On Windows PowerShell, use `npm.cmd` and `npx.cmd` if the `npm` or `npx`
PowerShell shims are blocked by execution policy.

Dropbox sync is optional. For local Dropbox testing, copy `.env.example` to
`.env.local` and set `VITE_DROPBOX_APP_KEY` to your Dropbox app key. To build
for a GitHub Pages project path, set `BASE_PATH`, for example
`BASE_PATH=/enoteweb/ npm run build`.

## More Information

- [HELP.md](HELP.md) is the full user manual.
- [SPEC.md](SPEC.md) is the detailed design contract.
- [LICENSE.md](LICENSE.md) contains the software license.
