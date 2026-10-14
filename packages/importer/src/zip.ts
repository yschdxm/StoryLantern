import { ImportError } from './types.ts';

/**
 * 最小 ZIP 读取器（CHARX 本质是 ZIP）。
 *
 * 只需要"按名字取出一个文件"，因此手写中央目录解析 + 交给平台的
 * `DecompressionStream('deflate-raw')` 解压——浏览器/WebView 与 Node 都有，零依赖。
 */

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  if (!isZip(bytes)) throw new ImportError('not-zip', '不是 ZIP 文件');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 从尾部找 EOCD（0x06054b50）
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= 0 && offset > bytes.length - 66_000; offset -= 1) {
    if (view.getUint32(offset, true) === 0x0605_4b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new ImportError('bad-zip', 'ZIP 结构不完整（找不到中央目录）');

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x0201_4b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.push({ name, method, compressedSize, localHeaderOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export async function readZipEntry(bytes: Uint8Array, wanted: (name: string) => boolean): Promise<{ name: string; data: Uint8Array } | undefined> {
  const entries = listZipEntries(bytes);
  const entry = entries.find((item) => wanted(item.name));
  if (entry === undefined) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localHeaderOffset;
  if (view.getUint32(at, true) !== 0x0403_4b50) throw new ImportError('bad-zip', 'ZIP 局部头损坏');
  const nameLength = view.getUint16(at + 26, true);
  const extraLength = view.getUint16(at + 28, true);
  const start = at + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return { name: entry.name, data: compressed };
  if (entry.method !== 8) throw new ImportError('unsupported-zip-method', `不支持的 ZIP 压缩方式（${entry.method}）`);

  return { name: entry.name, data: await inflateRaw(compressed) };
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}
