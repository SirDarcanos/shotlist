/**
 * The formats an image can be written in, and how to read one back.
 *
 * All three are what a browser can encode from a canvas, which is the only encoder here —
 * shotlist has no image library and is not going to grow one for this. AVIF is the
 * obvious omission: Chromium reads it and will not write it, and `toDataURL` answers a
 * request for it with a PNG rather than an error, which is why every conversion checks
 * what it actually got back.
 */
export type Format = 'png' | 'jpeg' | 'webp'

export const FORMATS: readonly Format[] = ['png', 'jpeg', 'webp']

/** What a file of this format is called, and what it is served as. */
export const MEDIA: Record<Format, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

/** The extension a written image takes. */
export function extensionOf(format: Format): string {
  return format === 'jpeg' ? '.jpg' : `.${format}`
}

/** Whether a format keeps every pixel it was given. */
export function isLossless(format: Format): boolean {
  return format === 'png'
}

/**
 * The format a file is in, read from its first bytes rather than its name.
 *
 * A recipe naming `capture.png` that is really a JPEG is a mistake worth reporting as the
 * one it is, and the extension is the least reliable thing about a file.
 */
export function formatOf(bytes: Buffer): Format | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg'
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

/** The pixel size in a PNG's header. */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/**
 * The pixel size in a JPEG, from the frame header.
 *
 * A JPEG is a chain of segments and the size lives in whichever start-of-frame it uses —
 * baseline, progressive or one of the arithmetic variants — so the chain is walked rather
 * than assumed. `ffd0`–`ffd9` carry no length and are stepped over.
 */
function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]!
    if (marker >= 0xd0 && marker <= 0xd9) {
      at += 2
      continue
    }
    const length = bytes.readUInt16BE(at + 2)
    // Every start-of-frame except the two that are not frames at all.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) }
    }
    at += 2 + length
  }
  return null
}

/** The pixel size in a WebP, whichever of the three chunk kinds it uses. */
function webpSize(bytes: Buffer): { width: number; height: number } | null {
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    }
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    }
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    // Fourteen bits each, packed across the four bytes after the signature byte.
    const bits = bytes.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  return null
}

/** The pixel size of an image, or null when its header does not say. */
export function sizeOf(bytes: Buffer, format: Format): { width: number; height: number } | null {
  if (format === 'png') return pngSize(bytes)
  if (format === 'jpeg') return jpegSize(bytes)
  return webpSize(bytes)
}
