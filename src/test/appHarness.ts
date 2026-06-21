import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, vi } from 'vitest'

export const fastKdf = {
  opslimit: 2,
  memlimit: 8_388_608,
}

type DraftProviderState = {
  envelope: string | null
}

export const createSeedDraft =
  (providerState: DraftProviderState) => async (envelope: string) => {
    providerState.envelope = envelope
    const { vaultStore } = await import('../storage/vaultStore')
    await vaultStore.saveEnvelope(envelope, new Date(), 'draft')
  }

export const findEditDraftButton = async () => {
  const editDraft = (await screen.findByRole(
    'button',
    {
      name: 'Edit draft',
    },
    { timeout: 15_000 },
  )) as HTMLButtonElement

  await waitFor(() => expect(editDraft.disabled).toBe(false))
  return editDraft
}

export const createDraftThroughDialog = async (password: string) => {
  fireEvent.click(await screen.findByRole('button', { name: 'New draft' }))
  await screen.findByText('Set a password for the new draft')

  const dialog = screen.getByRole('dialog')

  fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: password } })
  fireEvent.change(within(dialog).getByLabelText('Confirm password'), {
    target: { value: password },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
  await screen.findByTestId('editor', undefined, { timeout: 15_000 })
}

export const unlockDraftThroughDialog = async (password: string) => {
  fireEvent.click(await findEditDraftButton())
  await screen.findByText('Unlock draft')

  const dialog = screen.getByRole('dialog')

  fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: password } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Unlock' }))
  await screen.findByTestId('editor', undefined, { timeout: 15_000 })
}

export const mockBlobUrls = () => {
  const originalCreateObjectUrl = URL.createObjectURL
  const originalRevokeObjectUrl = URL.revokeObjectURL

  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:enoteweb-export'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })

  return () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: originalCreateObjectUrl,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: originalRevokeObjectUrl,
    })
  }
}

export const installClipboard = (clipboard: Partial<Clipboard>) => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: clipboard,
  })

  return () => {
    if (previous) {
      Object.defineProperty(navigator, 'clipboard', previous)
    } else {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  }
}
