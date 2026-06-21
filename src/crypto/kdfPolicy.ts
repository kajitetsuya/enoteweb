import { DEFAULT_KDF_PARAMS } from './cryptoService'

export type KdfPolicyId = 'standard' | 'strong'

export type KdfPolicyParams = {
  opslimit: number
  memlimit: number
}

export const DEFAULT_KDF_POLICY_ID: KdfPolicyId = 'standard'

const KDF_POLICY_PARAMS = {
  standard: {
    opslimit: DEFAULT_KDF_PARAMS.opslimit,
    memlimit: DEFAULT_KDF_PARAMS.memlimit,
  },
  strong: {
    opslimit: 4,
    memlimit: 134_217_728,
  },
} as const satisfies Record<KdfPolicyId, KdfPolicyParams>

export const KDF_POLICY_OPTIONS: ReadonlyArray<{ label: string; value: KdfPolicyId }> = [
  { label: 'Standard', value: 'standard' },
  { label: 'Strong', value: 'strong' },
]

export const sanitizeKdfPolicyId = (value: unknown): KdfPolicyId =>
  value === 'standard' || value === 'strong' ? value : DEFAULT_KDF_POLICY_ID

export const resolveKdfPolicyParams = (policyId: KdfPolicyId): KdfPolicyParams => {
  const params = KDF_POLICY_PARAMS[policyId]

  return {
    opslimit: params.opslimit,
    memlimit: params.memlimit,
  }
}

export const getKdfPolicyIdForParams = (params: KdfPolicyParams): KdfPolicyId => {
  if (
    params.opslimit === KDF_POLICY_PARAMS.strong.opslimit &&
    params.memlimit === KDF_POLICY_PARAMS.strong.memlimit
  ) {
    return 'strong'
  }

  if (
    params.opslimit === KDF_POLICY_PARAMS.standard.opslimit &&
    params.memlimit === KDF_POLICY_PARAMS.standard.memlimit
  ) {
    return 'standard'
  }

  throw new Error('Unsupported KDF policy parameters.')
}

export const shouldPassKdfPolicyParams = (policyId: KdfPolicyId) => {
  const params = resolveKdfPolicyParams(policyId)

  return (
    params.opslimit !== DEFAULT_KDF_PARAMS.opslimit ||
    params.memlimit !== DEFAULT_KDF_PARAMS.memlimit
  )
}
