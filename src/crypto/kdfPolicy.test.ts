import { describe, expect, it } from 'vitest'
import { DEFAULT_KDF_PARAMS, MAX_KDF_PARAMS } from './cryptoService'
import {
  DEFAULT_KDF_POLICY_ID,
  KDF_POLICY_OPTIONS,
  getKdfPolicyIdForParams,
  resolveKdfPolicyParams,
  sanitizeKdfPolicyId,
  shouldPassKdfPolicyParams,
} from './kdfPolicy'

describe('KDF policy presets', () => {
  it('defaults to the CryptoService default KDF parameters', () => {
    expect(DEFAULT_KDF_POLICY_ID).toBe('standard')
    expect(resolveKdfPolicyParams('standard')).toEqual(DEFAULT_KDF_PARAMS)
    expect(shouldPassKdfPolicyParams('standard')).toBe(false)
  })

  it('resolves the strong preset below the accepted caps', () => {
    expect(resolveKdfPolicyParams('strong')).toEqual({
      opslimit: 4,
      memlimit: 134_217_728,
    })
    expect(shouldPassKdfPolicyParams('strong')).toBe(true)
    expect(resolveKdfPolicyParams('strong').opslimit).toBeLessThanOrEqual(
      MAX_KDF_PARAMS.opslimit,
    )
    expect(resolveKdfPolicyParams('strong').memlimit).toBeLessThanOrEqual(
      MAX_KDF_PARAMS.memlimit,
    )
    for (const option of KDF_POLICY_OPTIONS) {
      const params = resolveKdfPolicyParams(option.value)

      expect(params.opslimit).toBeLessThanOrEqual(MAX_KDF_PARAMS.opslimit)
      expect(params.memlimit).toBeLessThanOrEqual(MAX_KDF_PARAMS.memlimit)
    }
  })

  it('maps exact preset params back to their persisted policy ids', () => {
    expect(getKdfPolicyIdForParams(resolveKdfPolicyParams('standard'))).toBe('standard')
    expect(getKdfPolicyIdForParams(resolveKdfPolicyParams('strong'))).toBe('strong')
    expect(() =>
      getKdfPolicyIdForParams({
        opslimit: 2,
        memlimit: 8_388_608,
      }),
    ).toThrow('Unsupported KDF policy parameters.')
  })

  it('sanitizes unknown stored values to standard', () => {
    expect(sanitizeKdfPolicyId('standard')).toBe('standard')
    expect(sanitizeKdfPolicyId('strong')).toBe('strong')
    expect(sanitizeKdfPolicyId('stronger')).toBe('standard')
    expect(sanitizeKdfPolicyId(null)).toBe('standard')
  })

  it('exposes only the supported user-facing options', () => {
    expect(KDF_POLICY_OPTIONS).toEqual([
      { label: 'Standard', value: 'standard' },
      { label: 'Strong', value: 'strong' },
    ])
  })
})
