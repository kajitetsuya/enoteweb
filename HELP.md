# eNoteWeb Help

eNoteWeb is an encrypted text editor. It edits plain text, can show Markdown
source highlighting and preview, and stores or syncs only encrypted `.txt` or
`.text` files. Plaintext exists only while a document is unlocked and being
edited.

<!--
Embedding note: keep this as one canonical help source. The app can later show
the whole document or open/filter by stable headings. A Home entry should lead
with Core Concepts, Settings Dialog Map, Home Screen and Home Settings, Home File
Lists, Dropbox Sync and Conflicts, Offline Use, Privacy and Security Limits,
Common Messages, License and Warranty, and About eNoteWeb. An Editor Settings
entry should lead with Settings Dialog Map, Editor Settings, Editor Basics,
Autosave and Locking, Storage Actions in the Editor, Passwords and Change
Password, Read-only, Find and Replace, Markdown, Random String, Line Number
Copy, Privacy and Security Limits, Common Messages, and License and Warranty.
-->

## Core Concepts

### Storage provider

The Storage provider setting on the locked Home screen chooses the home view:

- `Local files`: best for Windows/desktop Chromium. The app opens and saves a
  user-selected encrypted file directly.
- `Dropbox`: best for iPhone, iPad, and Android. The app syncs user-selected
  encrypted Dropbox files through the Dropbox API.

There is no separate browser-local storage mode. Browser storage is used for
encrypted caches, recovery state, settings, and the single draft.

In this help, Storage provider means this Home-screen choice.

### Document kind

An editor session is bound to exactly one document kind:

- `Local file`: an encrypted file selected from the local device.
- `Dropbox file`: an encrypted file selected from Dropbox, with its own
  encrypted local cache.
- `Draft`: the single browser-local encrypted document that is not yet bound to
  a local file or Dropbox file.

Changing the Home storage provider does not convert a document. A draft stays a
draft until you promote it with `Save As` or `Dropbox`.

### Drafts

The draft is useful for creating or importing encrypted content before choosing
a final destination.

- `New draft` creates an empty encrypted draft after you choose a password.
- `Edit draft` unlocks the existing draft.
- `Delete draft` deletes only the draft. It does not delete Dropbox files,
  local files, or Dropbox caches.
- In Local files mode, `Save As` promotes the locked draft to a local encrypted
  file.
- In Dropbox mode, `Dropbox` promotes the locked draft to a Dropbox encrypted
  file, and `Export draft` writes a one-shot encrypted copy.
- `Import draft` reads an encrypted `.txt` or `.text` file into the draft. It
  never uploads to Dropbox and never changes Dropbox files or caches.

When a locked draft is promoted, the app copies the already-encrypted draft to
the chosen destination. It does not ask for the password because it is not
opening the draft. The draft is cleared only after the write or upload succeeds.

## Settings Dialog Map

The Home Settings dialog and the editor Settings dialog share some controls, but
they do not configure the same surface.

### Shared controls

These appear in both Settings dialogs:

- Theme: choose `System`, `Light`, or `Dark`.
- Auto-lock: choose when an unlocked, inactive document should lock
  automatically. `Never` means the app will not lock because of inactivity.
- Version: shows the running build identifier so you can confirm which app build
  is installed.

Backgrounding the app is an autosave trigger, not a lock trigger. The app tries
to save when hidden, but does not wipe the editor solely because the device
backgrounded the app.

### Home-only controls

Home Settings are available only while the app is locked:

- Storage provider.
- Dropbox link, relink, and unlink actions when Dropbox is selected.
- Advanced Settings for Password hardening and the optional Secret key.
- `Check for updates`.

### Editor-only controls

Editor Settings are available only while a document is unlocked:

- Font and font size.
- Random string length.
- Editor mode.
- Autocapitalize, spellcheck, and autocorrect.
- Line wrap and whitespace visibility.
- Read-only.

## Home Screen and Home Settings

Home Settings are available only while the app is locked. They control app-wide
choices that should not change during an unlocked editing session.

### Storage provider

Choose `Local files` or `Dropbox`.

On platforms without persistent local file save-back, such as iPhone Safari,
Android Chrome, or Firefox, `Local files` may be unavailable because the app
cannot safely keep writing to arbitrary local files there.

### Dropbox account actions

When Dropbox mode is selected:

- `Link` starts Dropbox authorization from the locked Home screen.
- `Relink` appears when Dropbox authorization was lost.
- `Unlink Dropbox` appears in Home Settings while Dropbox is linked.

Dropbox linking is Home-only because the OAuth flow reloads or leaves the app.
Starting that flow from an unlocked editor could drop in-memory plaintext and
the session password.

Unlinking removes or pauses Dropbox authorization material, but keeps recent
file records, encrypted caches, and the draft. Cached Dropbox files may remain
visible, but editing is restricted when Dropbox is not linked.

### Password hardening

Password hardening controls how much work the app asks the password-based key
derivation step to do when it freshly encrypts a file.

Options:

- `Standard` is the default. It matches the app's current baseline parameters,
  which are tuned for mobile Safari.
- `Strong` uses more memory and one more Argon2id pass. It can make saved files
  slower to open and may fail on older or memory-constrained devices.

Switching from `Standard` to `Strong` asks for confirmation before the setting is
saved. Switching back to `Standard` does not show that warning.

This setting is the default for future password-choosing dialogs. New draft
creation starts with `Use strong password hardening` on when this setting is
`Strong`, and off when this setting is `Standard`.

Ordinary saving of an already opened document keeps that document's current
hardening, even if you change this setting later in Home Settings. That includes
autosave, Save As, Dropbox destination writes, read-only changes,
conflict-resolution saves, and current-document Export to Files.

To change an existing document's hardening, open the document and use Change
Password. The Change Password dialog starts from the document's current
hardening, and its `Use strong password hardening` toggle chooses what the
rewritten document will use. The new password may be the same as the current
password, so this can be used only to change hardening.

Verbatim copy actions, such as exporting an already encrypted stored file
without opening it, preserve the file exactly as stored.

Encrypted files store the exact numeric hardening parameters used to write them,
not the `Standard` or `Strong` label. That lets any supported build open a file
with the parameters already in the file. Opening a file does not change the
current local setting, and changing the local setting does not silently rewrite
an already opened file on its next autosave.

### Secret key

The optional Secret key is an extra local key used together with the password
for files saved with Secret-key protection.

Important rules:

- The Secret key is local to this browser or installed app.
- It is not synced through Dropbox.
- It is not written into encrypted files.
- It is not recoverable from encrypted files.
- The same Secret key must be set on every device that should open
  Secret-key-protected files.

Actions:

- `Generate` creates a new opaque Secret key.
- `Paste` imports a key string generated by this app.
- `QR` shows the configured key as an on-device QR code for moving it to another
  device. The QR popup does not show the key string as text.
- `Clear` removes only the local configured key. It does not rewrite any file.

Clearing the Secret key does not remove Secret-key protection from existing
files. A file already saved as Secret-key-protected still needs the same key
until it is opened and re-saved through Change Password with the Secret key
toggle off.

Generate, Paste, Clear, and QR are deliberate key-handling actions. Showing a
QR code exposes the key to nearby cameras, screenshots, screen sharing, or
screen recording.

### Version and updates

Both Settings dialogs show the running build version so you can confirm which
app build is installed.

`Check for updates` is available only while locked. A staged update never
activates itself while a document is unlocked. The app changes to a newer build
only after you explicitly choose `Update`.

## Home File Lists

### Local files

The Local files block lists recently opened encrypted local files. `Browse`
chooses a file first, then asks for its password. `Open` opens the selected
recent file.

`Set path root` chooses a folder used only to display recent paths more readably.
It does not restrict which files you can open. Files outside that folder can
still be opened, but the app cannot show the outside path relative to the chosen
root because browsers limit what folder-path details a web app can see. It does
not move files and does not grant Dropbox access.

Deleting a local recent-file row removes only the remembered row and browser
metadata. It does not delete the file from your device.

### Dropbox files

The Dropbox block lists recently opened Dropbox encrypted files. Each row has
its own encrypted local cache.

- `Browse` opens the in-app Dropbox file browser.
- `Open` unlocks the selected recent file.
- `Sync` checks Dropbox and flushes pending encrypted changes when possible.
- `Resolve` appears when a selected file has a conflict or replacement decision.
- `Export` appears for cached files when Dropbox authorization is lost or the
  remote file cannot be opened for editing.

Deleting a Dropbox recent-file row removes the recent record and its encrypted
local cache. It does not delete the Dropbox file. If the cache contains local
changes that have not reached Dropbox, deleting the row loses those unsynced
changes.

## Editor Settings

Open editor Settings from the toolbar while a document is unlocked. These
settings affect the editor surface and typing behavior.

### Theme, auto-lock, and version

Theme and auto-lock are the same shared controls described in Settings Dialog
Map. The editor Settings dialog also shows the running app version.

### Font

Choose from the built-in font styles: `Fixed width`, `System UI`, `Serif`, and
`Sans serif`. eNoteWeb does not download remote fonts or install app-specific
fonts.

### Font size

Choose the editor text size. This changes how text is displayed; it does not
change saved document content.

### Random string length

Choose how many characters Insert Random String will insert. The value is saved
as an app setting and survives reloads.

### Editor mode

Choose `Plain text` or `Markdown`. This controls highlighting and preview
availability only. It never rewrites or reformats saved document text.

### Autocapitalize

Choose whether the browser or operating system may capitalize typed editor text
for you, where supported. Options are `Off`, `None`, `Sentences`, `Words`, and
`Characters`.

Find and Replace fields disable autocapitalization separately so searches and
replacements use the characters you entered.

### Line wrap

When Line wrap is on, long visual lines wrap inside the editor. When it is off,
long lines scroll horizontally. This is display-only and does not insert line
breaks.

### Show whitespace

Show whitespace makes spaces, tabs, and trailing whitespace visible in the
editor. This helps inspect formatting without changing the document.

### Read-only

The Read-only checkbox mirrors the toolbar read-only toggle. Unlike most editor
Settings controls, it is document state saved inside the encrypted file. See
Read-only for the full behavior.

### Spellcheck

Spellcheck controls the browser or operating system spelling assistance in the
editor, where supported.

### Autocorrect

Autocorrect controls browser or operating system typing correction in the
editor, where supported.

## Editor Basics

The editor is the main screen. It focuses the text area when a document opens so
you can start typing immediately.

The toolbar contains:

- `Home`: exits the editor after confirmation.
- Save status and, for Dropbox files, sync status.
- Undo and Redo.
- Find.
- Markdown preview toggle, when Markdown mode is active.
- Insert Random String.
- Change Password.
- The current storage action: `Save As`, `Dropbox`, or `Export to Files`.
- Read-only toggle.
- Settings.

The status bar shows line and column, character count, word count, editor mode,
document kind, and Dropbox sync state when relevant. Character counts use
user-perceived characters where the browser supports them, so combined emoji and
many CJK characters count as one character.

On small mobile screens, the toolbar and status bar may compact or retract while
the on-screen keyboard is open so the document remains editable.

## Autosave and Locking

There is no manual Save button. Edits are saved automatically after a short idle
delay, and the app also tries to save before locking or when the page is hidden.

Autosave always writes an encrypted envelope with fresh encryption randomness.

- Local file sessions autosave back to the selected local encrypted file when
  permission is available.
- Dropbox file sessions autosave to the encrypted local cache, then upload to
  Dropbox when linked, online, and safe to sync.
- Draft sessions autosave only to the encrypted browser-local draft.

When you leave the editor voluntarily, the app tries a final encrypted save. If
that save fails and unsaved changes would be lost, the app asks whether to
export an encrypted copy, exit anyway, or stay in the editor.

If auto-lock fires while a dirty document cannot be saved, the app soft-locks:
the editor content is hidden from the page, but the session is kept in memory so
you can enter the correct password and either continue or export an encrypted
copy. If the retry save later succeeds, the app upgrades to a normal hard lock
and clears the session from memory.

## Storage Actions in the Editor

### Save As

`Save As` appears in Local files mode. It asks for a destination local file,
encrypts the current plaintext with the current session password, writes the new
encrypted file, and then makes that picked file the active document.

Save As does not ask for a new password. Use Change Password to rotate the
password.

### Dropbox

`Dropbox` appears in Dropbox mode. It saves the current document to a chosen
Dropbox `.txt` or `.text` destination and then edits that Dropbox file.

For a draft, this promotes the draft to a Dropbox file. For an existing Dropbox
file session, this can save a copy to another destination or intentionally
overwrite the current Dropbox file after confirmation.

Dropbox uploads are encrypted. Dropbox receives encrypted envelope text and
Dropbox metadata such as path, account, size, and timestamps, not plaintext
document content.

### Export to Files

`Export to Files` appears in Dropbox mode. It writes a one-shot encrypted copy
of the current editor contents using the current password and Secret-key mode.

Export does not rebind the editor, does not change the draft, does not change
Dropbox state, and does not create a syncing connection to the exported file.

## Passwords and Change Password

Passwords are exact strings. The app does not trim, normalize, case-fold, or
rewrite passwords. Non-Latin characters, leading or trailing spaces, invisible
characters, and different Unicode forms are different passwords.

Change Password is the only way to rotate a document password. It re-encrypts
the current document in place, at the same destination autosave uses. It does
not create an exported copy and does not choose a new file.

The Change Password dialog also controls whether the document is saved with
Secret-key protection:

- Toggle on: save as password plus Secret key.
- Toggle off: save as password only.

The new password may be the same as the old password, so the toggle can be used
only to add or remove Secret-key protection.

The Change Password dialog also controls password hardening. It starts from the
current document's hardening and includes `Use strong password hardening`.
Leaving it as-is preserves the document's current hardening. Turning it on saves
the rewritten document with Strong hardening; turning it off saves the rewritten
document with Standard hardening. If the dialog starts at Standard, turning
Strong on shows the memory and device-compatibility warning first.

## Read-only

Read-only is document state stored inside the encrypted file metadata. It
travels with the file across devices and Dropbox sync.

Read-only prevents accidental edits. It is not access control: anyone who can
unlock the file can toggle it off.

While read-only:

- Typing, paste, cut, drag-drop insertion, Insert Random String, and replace
  actions are disabled.
- Selection, copy, search, navigation, export, Save As, Home, and Settings still
  work.
- The replace row is hidden in Find/Replace.

Toggling read-only immediately re-encrypts and saves the document. If that save
fails, the toggle reverts.

## Find and Replace

Open Find from the toolbar or with `Ctrl+F` / `Cmd+F`. Open Replace directly
with `Ctrl+H` / `Cmd+H`. `F3`, `Shift+F3`, `Ctrl+G`, and `Shift+Ctrl+G` navigate
matches on desktop.

The app uses its own Find/Replace panel, not the browser's built-in find bar.
Search text and replacement text are memory-only and are cleared when the
session is locked.

### Find options

- Case sensitive: when off, matching is case-insensitive.
- Whole word: matches only when the characters before and after the match are
  not ASCII word characters (`A-Z`, `a-z`, `0-9`, `_`).
- Regex: treats the Find field as a JavaScript regular expression pattern.

Live match counts are shown while you type. `0 matches` is normal feedback for
the current query. `No matches.` appears when a command tries to move or replace
but has nothing to act on.

### Regex syntax

Regex mode uses the browser's JavaScript `RegExp` engine. The app constructs the
pattern with `new RegExp(pattern, "g")` or `new RegExp(pattern, "gi")` depending
on the Case sensitive option.

This means the syntax is JavaScript regular expression syntax, not PCRE, Python,
Vim, or grep syntax.

References:

- Practical JavaScript regex syntax reference:
  <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Regular_expressions>
- Normative ECMAScript RegExp Pattern grammar:
  <https://tc39.es/ecma262/#sec-patterns>

The app does not expose a flags field. It supplies global matching itself and
adds `i` only when Case sensitive is off. Flags such as `m`, `s`, `u`, `v`, `y`,
and `d` are not user-configurable in the current UI.

Regex mode has extra safety rules:

- Invalid patterns show `Invalid regex.` and do not modify the document.
- Likely runaway patterns, timed-out regex operations, or patterns that exceed
  the app's safety checks show `Regex too expensive.` and do not modify the
  document.
- Empty-capable patterns such as `a*`, `^`, `$`, or `\b` are allowed, but
  zero-length matches are skipped. Only non-empty matches are highlighted,
  counted, navigated, or replaced.
- Highlighting is capped. If Replace All would exceed the match cap, it refuses
  and reports the cap instead of partially replacing.

### Replacement text

In literal search mode, replacement text is inserted exactly as typed. Characters
such as `$&` or `$1` have no special meaning.

In regex mode, replacement text uses JavaScript replacement-token semantics:

- `$&`: the full matched text.
- `$1`, `$2`, etc.: numbered capture groups.
- `$<name>`: named capture group.
- `$$`: a literal dollar sign.
- ``$` ``: text before the match.
- `$'`: text after the match.

### Replace previous and Replace next

`Replace previous` and `Replace next` are deliberately two-step unless the
target match is already selected.

- If the current editor selection exactly matches a search result, the button
  replaces that selected match.
- If no current match is selected, the button first behaves like Find previous
  or Find next. It selects the target match and does not replace anything yet.
- Press the same replace button again to replace the selected match.
- After a replacement, the editor selects the next match in the same direction
  when one exists, so you can review before replacing again.

This is intended to make each single replacement visible before it changes the
document.

### Replace all

`Replace all` replaces every current non-empty match in one operation. It is
undoable as a normal editor edit. The caret stays near its previous line and
column when possible.

Replace All refuses to run if the match count exceeds the app's cap.

## Markdown

Editor mode controls presentation only:

- `Plain text`: no Markdown highlighting and no preview toggle.
- `Markdown`: source highlighting and a Markdown preview are available.

Switching modes never rewrites, reformats, or changes saved document text.

Markdown preview is derived from the current unlocked plaintext in memory. The
preview HTML is not persisted. The preview sanitizer removes scripts, iframes,
styles, forms, active content, unsafe links, and automatic resource loading.
Remote images and embedded remote content are not loaded from document content.

On wide screens, Markdown preview can be shown side by side with source. The
sync controls align preview and source by Markdown block:

- `Jump to Markdown`: align the preview to the editor's current source block.
- `Jump to Editor`: align the editor to the preview's current rendered block.

On narrow screens, preview uses an overlay-style layout and opens aligned to the
current source position.

## Random String

Insert Random String inserts a fresh random string at the cursor or replaces the
current selection.

The string uses uppercase letters, lowercase letters, and digits. Its length is
controlled by the editor Settings value `Random string length`.

Random string generation uses cryptographically secure browser randomness, not
`Math.random`, because generated strings may be used as passwords, tokens, or
other sensitive values.

The insertion is an ordinary edit: it can be undone and it triggers autosave.

## Line Number Copy

Clicking or tapping a line number copies that line's last word to the system
clipboard and selects that word in the editor.

This is a deliberate plaintext export. Clipboard contents may be visible to
other apps, clipboard managers, OS clipboard history, or clipboard sync until
overwritten.

## Dropbox Sync and Conflicts

Dropbox sync is revision-aware. The app uploads encrypted envelopes only when it
can relate the upload to the Dropbox revision it last synced.

If Dropbox changed while this device also has local changes, the editor shows a
Resolve banner or Home shows a `Resolve` action. Normal pushing stops until the
conflict is resolved, but local encrypted autosave continues.

When a conflict exists:

- `Resolve` starts the merge flow when online.
- `Dropbox` to the current file can be used as an intentional "my version wins"
  overwrite after a fresh confirmation.
- `Export to Files` stays available so you can save an encrypted copy of the
  current local version.

Conflict resolution decrypts the needed versions in memory only. Plaintext
merge bases, diffs, local copies, and remote copies are not written to
IndexedDB.

## Offline Use

After the app has loaded online once and its service worker is installed, it can
launch offline as an installed PWA.

Offline behavior:

- You can unlock, edit, search, autosave encrypted local changes, export, and
  lock.
- Local File Mode can keep saving to the selected local file if browser
  permission remains available.
- Dropbox Mode saves encrypted changes to the local cache and syncs later when
  online and linked.

Browser-owned storage can still be cleared by the browser, the OS, private
browsing cleanup, origin changes, app removal, or storage pressure. Do not treat
the browser cache as the only permanent copy of important data. The home screen
shows the draft persistence status below the draft actions.

## Privacy and Security Limits

The app is designed to avoid persisting or sending plaintext document content.
It has no analytics, telemetry, crash reporting, advertising tags, or remote
runtime code.

Persisted data may include encrypted envelopes, encrypted sync snapshots,
encrypted local caches, file handles where the browser supports them, Dropbox
metadata, OAuth/session material needed for Dropbox sync, settings, and the
optional local Secret key setting.

The app must not persist plaintext document content, passwords, derived keys,
search queries, replacement text, plaintext merge content, or decrypted Markdown
preview HTML.

Important limits:

- Plaintext is visible while unlocked and can be captured by screenshots, screen
  recording, accessibility tools, OS text services, browser internals, device
  compromise, or malicious code running in the app.
- Weak passwords are vulnerable to offline guessing if an attacker obtains an
  encrypted file.
- The Secret key improves protection when an attacker obtains only encrypted
  files, but it does not protect against an attacker who can read this app's
  browser storage or run malicious code in the app.
- Dropbox can observe encrypted-file metadata such as account, path, file size,
  timestamps, IP address, and sync frequency when Dropbox sync is active.

## Common Messages

`Could not unlock. Check the password or file.`

The file could not be decrypted or parsed. The app does not reveal whether the
cause was the password, file format, corruption, unsupported metadata, or
authentication failure.

`Enter this file's Secret key, or add it in Settings.`

The file requires a Secret key and none was supplied for this unlock.

`Could not unlock. Check the password or Secret key.`

The file requires a Secret key, but unlock failed. The app does not reveal
whether the password or Secret key was wrong.

`Regex too expensive.`

The regex was rejected or stopped by safety limits. The document was not
modified.

`Autosave failed`

Editing can continue, but the latest changes have not been safely written to the
normal destination. Use Export when offered if you need an encrypted escape
copy.

`File changed on Dropbox.`

Dropbox has a different version of the file. Use Resolve when online, or Export
an encrypted copy of the current local version.

## License and Warranty

eNoteWeb is free and open-source software distributed under the
[MIT License](https://opensource.org/license/mit). See that license for the
exact terms.

The software is provided as-is, without warranty. You are responsible for
keeping backups, remembering passwords, preserving Secret keys, and deciding
whether the app is suitable for your use.

## About eNoteWeb

Project repository: <https://github.com/kajitetsuya/enoteweb>

Copyright © 2026 Tetsuya Kaji.

Development of eNoteWeb was assisted by OpenAI ChatGPT and Anthropic Claude.
