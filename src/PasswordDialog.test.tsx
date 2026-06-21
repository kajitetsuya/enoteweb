import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PasswordDialog } from './PasswordDialog'

afterEach(cleanup)

describe('PasswordDialog', () => {
  it('unlock mode submits the typed password and shows the failure in-dialog', () => {
    const onSubmit = vi.fn()
    const { rerender } = render(
      <PasswordDialog
        mode="unlock"
        title="Unlock vault"
        submitLabel="Unlock"
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    )

    // Single field — no confirmation in unlock mode.
    expect(screen.queryByLabelText('Confirm password')).toBeNull()

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(onSubmit).toHaveBeenCalledWith('secret pass')

    // The caller reports the unlock failure; it renders inside the dialog and
    // the field stays for retry.
    rerender(
      <PasswordDialog
        mode="unlock"
        title="Unlock vault"
        submitLabel="Unlock"
        errorMessage="Could not unlock. Check the password or file."
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    )
    expect(screen.getByRole('alert').textContent).toBe(
      'Could not unlock. Check the password or file.',
    )
    expect(screen.getByLabelText('Password')).not.toBeNull()
  })

  it('create mode blocks a mismatched confirmation and submits a matching one', () => {
    const onSubmit = vi.fn()

    render(
      <PasswordDialog
        mode="create"
        title="Set a password"
        submitLabel="Create"
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'one password' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'другой password' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Passwords do not match.')

    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'one password' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onSubmit).toHaveBeenCalledWith('one password')
  })

  it('orders password hardening before the Secret key toggle and submits both choices', () => {
    const onSubmit = vi.fn()
    const { container } = render(
      <PasswordDialog
        mode="create"
        title="Set a password"
        submitLabel="Create"
        kdfPolicyToggle={{ initialStrong: false }}
        secretKeyToggle={{ available: true, initialOn: false }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    )

    const labelTexts = Array.from(container.querySelectorAll('label')).map((label) =>
      label.textContent?.trim(),
    )

    expect(labelTexts).toEqual([
      'Password',
      'Confirm password',
      'Use strong password hardening',
      'Use secret key',
    ])

    fireEvent.click(screen.getByRole('switch', { name: 'Use strong password hardening' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Use secret key' }))
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'same pass' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'same pass' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(onSubmit).toHaveBeenCalledWith(
      'same pass',
      { kind: 'toggle', on: true },
      'strong',
    )
  })

  it('confirms before switching password hardening from Standard to Strong', () => {
    const onConfirmStrong = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)

    render(
      <PasswordDialog
        mode="create"
        title="Set a password"
        submitLabel="Create"
        kdfPolicyToggle={{ initialStrong: false, onConfirmStrong }}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    )

    const strongToggle = screen.getByRole('switch', {
      name: 'Use strong password hardening',
    }) as HTMLInputElement

    fireEvent.click(strongToggle)
    expect(onConfirmStrong).toHaveBeenCalledTimes(1)
    expect(strongToggle.checked).toBe(false)

    fireEvent.click(strongToggle)
    expect(onConfirmStrong).toHaveBeenCalledTimes(2)
    expect(strongToggle.checked).toBe(true)
  })

  it('does not warn when Strong is the dialog initial hardening', () => {
    const onConfirmStrong = vi.fn()

    render(
      <PasswordDialog
        mode="create"
        title="Set a password"
        submitLabel="Create"
        kdfPolicyToggle={{ initialStrong: true, onConfirmStrong }}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    )

    const strongToggle = screen.getByRole('switch', {
      name: 'Use strong password hardening',
    }) as HTMLInputElement

    expect(strongToggle.checked).toBe(true)
    fireEvent.click(strongToggle)
    fireEvent.click(strongToggle)
    expect(onConfirmStrong).not.toHaveBeenCalled()
    expect(strongToggle.checked).toBe(true)
  })

  it('Enter (native form submit) submits; busy disables the submit', () => {
    const onSubmit = vi.fn()
    const { container, rerender } = render(
      <PasswordDialog
        mode="create"
        title="Set a password"
        submitLabel="Create"
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    )

    // The dialog is a <form>; pressing Enter in any field triggers a native
    // submit, which jsdom models via fireEvent.submit on the form element.
    const form = container.querySelector('form.password-dialog') as HTMLFormElement
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'p' } })
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'p' } })
    fireEvent.submit(form)
    expect(onSubmit).toHaveBeenCalledTimes(1)

    rerender(
      <PasswordDialog
        busy
        mode="create"
        title="Set a password"
        submitLabel="Create"
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.submit(container.querySelector('form.password-dialog') as HTMLFormElement)
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('busy also disables Cancel — a slow decrypt/create cannot be half-cancelled', () => {
    const onCancel = vi.fn()

    render(
      <PasswordDialog
        busy
        mode="unlock"
        title="Unlock vault"
        submitLabel="Unlock"
        onCancel={onCancel}
        onSubmit={() => undefined}
      />,
    )

    const cancel = screen.getByRole('button', { name: 'Cancel' })

    expect(cancel.hasAttribute('disabled')).toBe(true)
    fireEvent.click(cancel)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('uses a masked text input with a custom reveal control', () => {
    render(
      <PasswordDialog
        mode="unlock"
        title="Unlock vault"
        submitLabel="Unlock"
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    )

    const password = screen.getByLabelText('Password') as HTMLInputElement
    expect(password.type).toBe('text')
    expect(password.classList.contains('is-masked')).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Show entered text' }))
    expect(password.type).toBe('text')
    expect(password.classList.contains('is-masked')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Hide entered text' }))
    expect(password.type).toBe('text')
    expect(password.classList.contains('is-masked')).toBe(true)
  })

  it('toggles confirmation password visibility independently', () => {
    render(
      <PasswordDialog
        mode="create"
        title="Set a password"
        submitLabel="Create"
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    )

    const password = screen.getByLabelText('Password') as HTMLInputElement
    const confirmation = screen.getByLabelText('Confirm password') as HTMLInputElement

    fireEvent.click(screen.getByRole('button', { name: 'Show confirmation text' }))

    expect(password.type).toBe('text')
    expect(password.classList.contains('is-masked')).toBe(true)
    expect(confirmation.type).toBe('text')
    expect(confirmation.classList.contains('is-masked')).toBe(false)
  })

  it('submits Unicode passwords exactly as typed', () => {
    const onSubmit = vi.fn()
    const password = '\u65e5\u672c\u8a9e\u306e\u30d1\u30b9\u30ef\u30fc\u30c9 \u3000\t'

    render(
      <PasswordDialog
        mode="unlock"
        title="Unlock vault"
        submitLabel="Unlock"
        onCancel={() => undefined}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))

    expect(onSubmit).toHaveBeenCalledWith(password)
  })
})
