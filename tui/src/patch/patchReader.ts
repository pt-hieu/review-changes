import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

const BLOCK_BYTES = 256 * 1024
const BLOCK_CAPACITY = 64

const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true })

export class PatchReader {
  readonly byteLength: number
  readonly inode: number
  private readonly fileDescriptor: number
  private readonly blocks = new Map<number, { buffer: Buffer; length: number }>()
  private isClosed = false

  constructor(path: string) {
    this.fileDescriptor = openSync(path, 'r')
    const status = fstatSync(this.fileDescriptor)

    this.byteLength = status.size
    this.inode = status.ino
  }

  get descriptor(): number {
    return this.fileDescriptor
  }

  close(): void {
    if (this.isClosed) return

    this.isClosed = true
    this.blocks.clear()
    closeSync(this.fileDescriptor)
  }

  readInto(target: Uint8Array, offset: number, length: number): number {
    const wanted = Math.min(length, this.byteLength - offset, target.length)
    let copied = 0

    while (copied < wanted) {
      const position = offset + copied
      const blockIndex = Math.floor(position / BLOCK_BYTES)
      const block = this.blockAt(blockIndex)
      const blockStart = position - blockIndex * BLOCK_BYTES
      const available = Math.min(block.length - blockStart, wanted - copied)

      if (available <= 0) break

      target.set(block.buffer.subarray(blockStart, blockStart + available), copied)
      copied += available
    }

    return copied
  }

  readView(offset: number, length: number): Uint8Array {
    if (offset < 0 || offset >= this.byteLength || length <= 0) return new Uint8Array(0)

    const wanted = Math.min(length, this.byteLength - offset)
    const blockIndex = Math.floor(offset / BLOCK_BYTES)
    const blockStart = offset - blockIndex * BLOCK_BYTES

    if (blockStart + wanted <= BLOCK_BYTES) {
      const block = this.blockAt(blockIndex)

      return block.buffer.subarray(blockStart, Math.min(blockStart + wanted, block.length))
    }

    const assembled = new Uint8Array(wanted)
    const copied = this.readInto(assembled, offset, wanted)

    return copied === wanted ? assembled : assembled.subarray(0, copied)
  }

  readText(offset: number, length: number): string {
    return textDecoder.decode(this.readView(offset, length))
  }

  private blockAt(blockIndex: number): { buffer: Buffer; length: number } {
    const cached = this.blocks.get(blockIndex)

    if (cached !== undefined) {
      this.blocks.delete(blockIndex)
      this.blocks.set(blockIndex, cached)

      return cached
    }

    let recycled: Buffer | undefined

    if (this.blocks.size >= BLOCK_CAPACITY) {
      const oldestKey = this.blocks.keys().next().value!
      recycled = this.blocks.get(oldestKey)!.buffer
      this.blocks.delete(oldestKey)
    }

    const buffer = recycled ?? Buffer.allocUnsafe(BLOCK_BYTES)
    const length = this.fillBlock(buffer, blockIndex)
    const block = { buffer, length }

    this.blocks.set(blockIndex, block)

    return block
  }

  private fillBlock(buffer: Buffer, blockIndex: number): number {
    let filled = 0
    const base = blockIndex * BLOCK_BYTES

    while (filled < BLOCK_BYTES) {
      const bytesRead = readSync(this.fileDescriptor, buffer, filled, BLOCK_BYTES - filled, base + filled)

      if (bytesRead === 0) break

      filled += bytesRead
    }

    return filled
  }
}
