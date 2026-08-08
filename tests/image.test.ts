import { describe, expect, it } from 'vitest'
import { FORMATS, extensionOf, formatOf, isLossless, sizeOf } from '../src/image.js'

/** A PNG header, with the size written where a decoder looks for it. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24)
  bytes.writeUInt32BE(0x89504e47, 0)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

/** A JPEG: the signature, a segment to skip over, then the frame carrying the size. */
function jpeg(width: number, height: number): Buffer {
  const comment = Buffer.from([0xff, 0xfe, 0x00, 0x04, 0x00, 0x00])
  const frame = Buffer.alloc(11)
  frame.writeUInt16BE(0xffc0, 0)
  frame.writeUInt16BE(0x0011, 2)
  frame.writeUInt8(8, 4)
  frame.writeUInt16BE(height, 5)
  frame.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), comment, frame])
}

/** A lossy WebP, whose size sits in the VP8 bitstream header. */
function webp(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(32)
  bytes.write('RIFF', 0, 'ascii')
  bytes.write('WEBP', 8, 'ascii')
  bytes.write('VP8 ', 12, 'ascii')
  bytes.writeUInt16LE(width, 26)
  bytes.writeUInt16LE(height, 28)
  return bytes
}

// The name is the least reliable thing about a file, so the format is read from the
// bytes: a `capture.png` that is really a JPEG is a mistake worth reporting as that one.
describe('reading an image', () => {
  it('names the format from its first bytes', () => {
    expect(formatOf(png(1, 1))).toBe('png')
    expect(formatOf(jpeg(1, 1))).toBe('jpeg')
    expect(formatOf(webp(1, 1))).toBe('webp')
  })

  it('says nothing when the bytes are not an image it knows', () => {
    expect(formatOf(Buffer.from('site:\n  url: http://x\n'))).toBeNull()
    expect(formatOf(Buffer.alloc(0))).toBeNull()
    // A RIFF container that is not a WebP — a wav, say.
    const riff = Buffer.alloc(12)
    riff.write('RIFF', 0, 'ascii')
    riff.write('WAVE', 8, 'ascii')
    expect(formatOf(riff)).toBeNull()
  })

  it('reads the size out of each of the three headers', () => {
    expect(sizeOf(png(1280, 4262), 'png')).toEqual({ width: 1280, height: 4262 })
    expect(sizeOf(jpeg(1280, 4262), 'jpeg')).toEqual({ width: 1280, height: 4262 })
    expect(sizeOf(webp(1280, 4262), 'webp')).toEqual({ width: 1280, height: 4262 })
  })

  it('walks a JPEG past the segments that are not the frame', () => {
    // The comment segment sits between the signature and the frame; a reader that
    // assumed the frame came first would read the size out of the comment's length.
    expect(sizeOf(jpeg(640, 480), 'jpeg')).toEqual({ width: 640, height: 480 })
  })

  it('says nothing for a header that is cut short', () => {
    expect(sizeOf(png(1, 1).subarray(0, 12), 'png')).toBeNull()
    expect(sizeOf(Buffer.from([0xff, 0xd8, 0xff]), 'jpeg')).toBeNull()
  })
})

describe('writing an image', () => {
  it('gives each format the extension it is known by', () => {
    expect(extensionOf('png')).toBe('.png')
    expect(extensionOf('webp')).toBe('.webp')
    // The one that is not simply the name.
    expect(extensionOf('jpeg')).toBe('.jpg')
  })

  it('knows which one keeps every pixel', () => {
    expect(isLossless('png')).toBe(true)
    expect(isLossless('jpeg')).toBe(false)
    expect(isLossless('webp')).toBe(false)
  })

  // AVIF is the omission worth pinning: a browser reads it and will not write it, and
  // `toDataURL` answers a request for one with a PNG rather than an error.
  it('offers only what a browser can actually encode', () => {
    expect([...FORMATS]).toEqual(['png', 'jpeg', 'webp'])
  })
})
