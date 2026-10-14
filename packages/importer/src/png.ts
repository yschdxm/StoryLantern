import { ImportError } from './types.ts';

/**
 * 从 PNG 角色卡里取出 JSON 文本。
 *
 * 角色卡藏在 PNG 的文本块里：tEXt/iTXt 的 keyword 为 `chara`（CCv2，内容是 base64 的 JSON）
 * 或 `ccv3`（CCv3）。这里手写最小 PNG 块遍历——只为拿文本块，不需要解码像素，
 * 因此不引任何图像库（Android 上少一个依赖就少一类构建问题）。
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export interface PngTextChunks {
  /** keyword → 文本（已解 base64 之外的原始文本）。 */
  texts: Map<string, string>;
}

export function readPngTextChunks(bytes: Uint8Array): PngTextChunks {
  if (!isPng(bytes)) throw new ImportError('not-png', '不是 PNG 文件');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const texts = new Map<string, string>();
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4] ?? 0, bytes[offset + 5] ?? 0, bytes[offset + 6] ?? 0, bytes[offset + 7] ?? 0);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      // 截断的 PNG：能读到的块已经读到了，剩下的不猜
      throw new ImportError('truncated-png', 'PNG 数据不完整（可能在传输中损坏）');
    }

    if (type === 'tEXt') {
      const chunk = bytes.subarray(dataStart, dataEnd);
      const separator = chunk.indexOf(0);
      if (separator > 0) {
        const keyword = latin1(chunk.subarray(0, separator));
        texts.set(keyword, latin1(chunk.subarray(separator + 1)));
      }
    } else if (type === 'iTXt') {
      const chunk = bytes.subarray(dataStart, dataEnd);
      const parts = splitItxt(chunk);
      if (parts !== undefined) texts.set(parts.keyword, parts.text);
    }

    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }

  return { texts };
}

/** iTXt 结构：keyword\0compressionFlag\0compressionMethod\0langTag\0translated\0text */
function splitItxt(chunk: Uint8Array): { keyword: string; text: string } | undefined {
  const first = chunk.indexOf(0);
  if (first <= 0) return undefined;
  const keyword = latin1(chunk.subarray(0, first));
  let cursor = first + 1;
  const compressionFlag = chunk[cursor] ?? 0;
  cursor += 1; // compressionFlag
  cursor += 1; // compressionMethod
  const langEnd = chunk.indexOf(0, cursor);
  if (langEnd < 0) return undefined;
  cursor = langEnd + 1;
  const translatedEnd = chunk.indexOf(0, cursor);
  if (translatedEnd < 0) return undefined;
  cursor = translatedEnd + 1;
  const text = latin1(chunk.subarray(cursor));
  // 压缩的 iTXt 需要 zlib 解压：这里明确拒绝，而不是返回乱码
  if (compressionFlag === 1) throw new ImportError('compressed-itxt', 'PNG 里的文本块是压缩的，暂不支持');
  return { keyword, text };
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** 角色卡文本块的优先级：ccv3 > chara。两者按规范都是 **base64 编码的 JSON**。 */
export function extractCardTextFromPng(bytes: Uint8Array): { keyword: string; json: string } {
  const { texts } = readPngTextChunks(bytes);
  for (const keyword of ['ccv3', 'chara']) {
    const raw = texts.get(keyword);
    if (raw === undefined) continue;
    return { keyword, json: decodeCardText(raw) };
  }
  throw new ImportError('no-card-in-png', 'PNG 里没有角色卡数据（缺少 chara/ccv3 文本块）');
}

/**
 * 取出的文本可能是 base64，也可能已经是 JSON（少数实现直接放明文）。
 * 不猜：先看是不是 JSON，不是再解 base64；两者都不像就把原文交出去，
 * 让 JSON 解析给出"不是合法 JSON"这种用户能看懂的错误。
 */
function decodeCardText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  try {
    const decoded = decodeBase64Utf8(trimmed);
    if (decoded.trim().startsWith('{')) return decoded;
  } catch {
    // 不是合法 base64：按原文处理
  }
  return trimmed;
}

export function decodeBase64Utf8(text: string): string {
  const normalized = text.replace(/\s+/g, '');
  const binary = globalThis.atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}
