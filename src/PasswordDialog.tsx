import { useState, type CSSProperties } from 'react'
import eyeOpenIcon from '../icons/preview.svg'
import eyeClosedIcon from '../icons/eye_closed.svg'

const passwordInputClassName = (revealed: boolean) =>
  `password-text-input${revealed ? '' : ' is-masked'}`

// Masked-icon style for the Show/Hide peek buttons: the icon inherits the
// button's text color via `currentColor` (so it themes), exactly like the
// toolbar icons. `preview.svg` is the open eye (Show), `eye_closed.svg` the
// closed eye (Hide).
const peekIconStyle = (icon: string): CSSProperties =>
  ({ ['--icon-url']: `url("${icon}")` }) as CSSProperties

// The create/change-password `Secret key` slide-toggle config (SPEC §6/§10):
// `available` enables it (a key can be applied); when false it renders disabled
// and off. `initialOn` is the default checked state when available (create →
// app-key-set; Change Password → the document's current mode).
export type SecretKeyToggleConfig = {
  available: boolean
  initialOn: boolean
}

export type KdfPolicyToggleConfig = {
  initialStrong: boolean
  onConfirmStrong?: (() => boolean) | undefined
}

// The unlock dialog's inline `Secret key` field config (SPEC §10), present only
// for a `required-v1` file: pre-filled with the Settings key, expanded by
// default when none is configured.
export type SecretKeyFieldConfig = {
  initialValue: string
  initiallyExpanded: boolean
}

// What the dialog reports alongside the password: the create/change toggle
// state, or the unlock dialog's entered Secret-key string.
export type PasswordDialogSecretKey =
  | { kind: 'toggle'; on: boolean }
  | { kind: 'unlock-key'; value: string }

export type PasswordDialogKdfPolicy = 'standard' | 'strong'

// Password dialog content (SPEC §10): every password is collected in a dialog,
// never an always-visible field. 'unlock' is a single field whose failure
// message appears inside the dialog (the dialog stays open for retry);
// 'create' SETS a password and carries a confirmation field — a mismatch
// blocks with `Passwords do not match.`. The caller wraps this in ModalShell
// and clears `errorMessage` / closes as its flow requires. The optional
// Secret-key controls (SPEC §6/§10): a slide-toggle for create/Change Password,
// or an inline editable field for unlocking a `required-v1` file.
export const PasswordDialog = ({
  busy = false,
  errorMessage = '',
  kdfPolicyToggle,
  mode,
  onCancel,
  onSubmit,
  secretKeyField,
  secretKeyToggle,
  submitLabel,
  title,
}: {
  // Disables the submit while the caller is decrypting/creating (Argon2id is
  // slow on phones; a second tap must not double-submit).
  busy?: boolean
  // Unlock failures render inside the dialog: `Could not unlock. ...`.
  errorMessage?: string
  kdfPolicyToggle?: KdfPolicyToggleConfig | undefined
  mode: 'unlock' | 'create'
  onCancel: () => void
  onSubmit: (
    password: string,
    secretKey?: PasswordDialogSecretKey,
    kdfPolicy?: PasswordDialogKdfPolicy,
  ) => void
  secretKeyField?: SecretKeyFieldConfig | undefined
  secretKeyToggle?: SecretKeyToggleConfig | undefined
  submitLabel: string
  title: string
}) => {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [mismatchMessage, setMismatchMessage] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [strongHardeningOn, setStrongHardeningOn] = useState(
    () => kdfPolicyToggle?.initialStrong ?? false,
  )
  const [secretKeyOn, setSecretKeyOn] = useState(
    () => Boolean(secretKeyToggle?.available && secretKeyToggle.initialOn),
  )
  const [secretKeyValue, setSecretKeyValue] = useState(secretKeyField?.initialValue ?? '')
  const [secretKeyExpanded, setSecretKeyExpanded] = useState(
    Boolean(secretKeyField?.initiallyExpanded),
  )

  const submit = () => {
    if (busy) {
      return
    }

    if (mode === 'create' && password !== confirmation) {
      setMismatchMessage('Passwords do not match.')
      return
    }

    setMismatchMessage('')

    const selectedKdfPolicy: PasswordDialogKdfPolicy | undefined = kdfPolicyToggle
      ? strongHardeningOn
        ? 'strong'
        : 'standard'
      : undefined

    if (secretKeyField) {
      onSubmit(password, { kind: 'unlock-key', value: secretKeyValue })
    } else if (secretKeyToggle) {
      const secretKey = { kind: 'toggle', on: secretKeyToggle.available && secretKeyOn } as const

      if (selectedKdfPolicy) {
        onSubmit(password, secretKey, selectedKdfPolicy)
      } else {
        onSubmit(password, secretKey)
      }
    } else if (selectedKdfPolicy) {
      onSubmit(password, undefined, selectedKdfPolicy)
    } else {
      onSubmit(password)
    }
  }

  const toggleStrongHardening = (nextOn: boolean) => {
    if (
      nextOn &&
      kdfPolicyToggle &&
      !kdfPolicyToggle.initialStrong &&
      kdfPolicyToggle.onConfirmStrong &&
      !kdfPolicyToggle.onConfirmStrong()
    ) {
      setStrongHardeningOn(false)
      return
    }

    setStrongHardeningOn(nextOn)
  }

  const visibleError = mismatchMessage || errorMessage

  return (
    // A real <form> so the keyboard's Enter / Go key submits natively: on iOS
    // Safari, pressing return inside a lone input only dismisses the keyboard,
    // but a form with a submit button fires onSubmit, which is the reliable
    // cross-platform "Enter = primary action" path (replaces the old per-input
    // keydown handler).
    <form
      className="password-dialog"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <h2 id="password-dialog-title">{title}</h2>
      <label htmlFor="password-dialog-password">Password</label>
      <div className="password-input-row">
        <input
          id="password-dialog-password"
          type="text"
          className={passwordInputClassName(showPassword)}
          autoFocus
          autoCapitalize="none"
          autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
          autoCorrect="off"
          spellCheck={false}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button
          type="button"
          className="password-peek-button"
          aria-label={showPassword ? 'Hide entered text' : 'Show entered text'}
          onClick={() => setShowPassword((visible) => !visible)}
        >
          <span
            className="toolbar-icon password-peek-icon"
            style={peekIconStyle(showPassword ? eyeClosedIcon : eyeOpenIcon)}
            aria-hidden="true"
          />
        </button>
      </div>
      {mode === 'create' ? (
        <>
          <label htmlFor="password-dialog-confirm">Confirm password</label>
          <div className="password-input-row">
            <input
              id="password-dialog-confirm"
              type="text"
              className={passwordInputClassName(showConfirmation)}
              autoCapitalize="none"
              autoComplete="new-password"
              autoCorrect="off"
              spellCheck={false}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            <button
              type="button"
              className="password-peek-button"
              aria-label={
                showConfirmation ? 'Hide confirmation text' : 'Show confirmation text'
              }
              onClick={() => setShowConfirmation((visible) => !visible)}
            >
              <span
                className="toolbar-icon password-peek-icon"
                style={peekIconStyle(showConfirmation ? eyeClosedIcon : eyeOpenIcon)}
                aria-hidden="true"
              />
            </button>
          </div>
        </>
      ) : null}
      {kdfPolicyToggle ? (
        <label className="password-option-toggle">
          <input
            type="checkbox"
            role="switch"
            className="password-option-toggle-input"
            checked={strongHardeningOn}
            disabled={busy}
            onChange={(event) => toggleStrongHardening(event.target.checked)}
          />
          <span className="password-option-toggle-track" aria-hidden="true" />
          <span className="password-option-toggle-text">Use strong password hardening</span>
        </label>
      ) : null}
      {secretKeyToggle ? (
        <label
          className={`password-option-toggle${secretKeyToggle.available ? '' : ' is-disabled'}`}
        >
          <input
            type="checkbox"
            role="switch"
            className="password-option-toggle-input"
            checked={secretKeyToggle.available && secretKeyOn}
            disabled={!secretKeyToggle.available || busy}
            onChange={(event) => setSecretKeyOn(event.target.checked)}
          />
          <span className="password-option-toggle-track" aria-hidden="true" />
          <span className="password-option-toggle-text">Use secret key</span>
        </label>
      ) : null}
      {secretKeyField ? (
        <div className="secret-key-disclosure">
          <button
            type="button"
            className="secret-key-disclosure-toggle"
            aria-expanded={secretKeyExpanded}
            onClick={() => setSecretKeyExpanded((shown) => !shown)}
          >
            <span aria-hidden="true">{secretKeyExpanded ? '▾' : '▸'}</span>
            Secret key
          </button>
          {secretKeyExpanded ? (
            <input
              type="text"
              className="password-text-input secret-key-input"
              aria-label="Secret key"
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={secretKeyValue}
              onChange={(event) => setSecretKeyValue(event.target.value)}
              // Select-all on focus so a tap makes the field paste-ready (the
              // pre-filled Settings key is replaced wholesale by a paste).
              onFocus={(event) => event.currentTarget.select()}
            />
          ) : null}
        </div>
      ) : null}
      {visibleError ? (
        <p className="dialog-error" role="alert">
          {visibleError}
        </p>
      ) : null}
      {/* Cancel sits left, the primary action right. */}
      <div className="dialog-actions">
        {/* Cancel is inert mid-operation: the slow Argon2id decrypt/create is
            not abortable, and closing the dialog while it later succeeds
            would contradict the cancel semantics (SPEC §10 — cancel means
            nothing happens). The App-side Escape handler must honor the same
            `busy` guard. */}
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
