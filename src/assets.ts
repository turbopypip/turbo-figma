import { nativeAvailable, nativeCommand } from './native-command.js';
import { rustBinary } from './network-rust.js';
import { constants } from 'node:fs';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const imageSchema = z.object({ nodeId: z.string().max(100), name: z.string().max(500),
  format: z.enum(['PNG', 'SVG']), data: z.string().max(4 * 1024 * 1024),
  scale: z.number().positive().optional(), scaleBasis: z.literal('clipboard').optional() });
export function decodeImage(value: unknown) {
  const image = imageSchema.parse(value);
  if (image.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(image.data))
    throw new Error('Invalid base64 image');
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.toString('base64') !== image.data) throw new Error('Invalid base64 image');
  if (bytes.length === 0 || bytes.length > 3 * 1024 * 1024) throw new Error('Image exceeds 3 MiB limit or is empty');
  if (image.format === 'PNG' && !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    throw new Error('Invalid PNG signature');
  if (image.format === 'SVG' && !/<svg[\s>]/.test(bytes.toString('utf8')))
    throw new Error('Invalid SVG');
  return { ...image, bytes };
}
export async function decodeImageAsync(value: unknown) {
  if (!await nativeAvailable()) return decodeImage(value);
  const result = await nativeCommand('--assets', { op: 'decode', image: value });
  return { ...result, bytes: Buffer.from(result.data, 'base64') };
}
export class AssetStore {
  private constructor(readonly root: string, readonly native = false, private readonly binary = process.env.FIGMA_RUST_BINARY ?? rustBinary) {}
  static async create(directory: string) {
    if (!path.isAbsolute(directory)) throw new Error('Asset directory must be absolute');
    await mkdir(directory, { recursive: true });
    return new AssetStore(await realpath(directory), await nativeAvailable());
  }
  async write(value: unknown) {
    if (this.native) return nativeCommand('--assets', { op: 'write', root: this.root, image: value }, this.binary);
    const image = decodeImage(value);
    if (await realpath(this.root) !== this.root) throw new Error('Asset directory was replaced');
    // Flat, generated filenames: no agent-controlled paths, subfolders or overwrites.
    const stem = image.name.normalize('NFKC').replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 48) || 'asset';
    const filename = `figma-${stem}-${randomUUID()}.${image.format.toLowerCase()}`;
    const target = path.join(this.root, filename);
    const handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(image.bytes); }
    catch (error) { await handle.close(); await unlink(target).catch(() => {}); throw error; }
    await handle.close();
    return { nodeId: image.nodeId, path: target, bytes: image.bytes.length, format: image.format, scale: image.scale, scaleBasis: image.scaleBasis };
  }
}
