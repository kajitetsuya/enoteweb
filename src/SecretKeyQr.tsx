import { useMemo } from 'react'
import encodeQR from 'qr'

// Quiet zone: the QR spec requires a light margin of at least 4 modules around
// the symbol so scanners can locate it. `border` bakes it into the matrix as
// light cells, which our white background then fills.
const QUIET_ZONE_MODULES = 4

/**
 * Renders a Secret key string as a QR code, entirely on-device.
 *
 * The matrix is computed locally by `qr` (a zero-dependency, pure encoder — no
 * network) and exists only while this component is mounted (i.e.
 * while the popup is open), so closing the popup discards it. The code is drawn
 * as a single inline-SVG `<path>` of dark modules on a fixed white background —
 * dark-on-light in every theme so it stays scannable, and with no
 * `dangerouslySetInnerHTML` or `data:` URI. The key string itself never leaves
 * the device.
 */
export function SecretKeyQr({ value }: { value: string }) {
  const { size, path } = useMemo(() => {
    const matrix = encodeQR(value, 'raw', { ecc: 'medium', border: QUIET_ZONE_MODULES })
    const dimension = matrix.length
    // One path covering every dark module: `M<x> <y>h1v1h-1z` is a 1x1 square.
    let d = ''
    for (let y = 0; y < dimension; y++) {
      const row = matrix[y]
      if (!row) continue
      for (let x = 0; x < dimension; x++) {
        if (row[x]) d += `M${x} ${y}h1v1h-1z`
      }
    }
    return { size: dimension, path: d }
  }, [value])

  return (
    <svg
      className="secret-key-qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Secret key QR code"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}
