import type { BackupPorts } from '../../../../packages/oplog/src/backup.ts';

/**
 * 备份用的浏览器端口：只要 **sha256 + gzip** 两件事。
 *
 * 为什么不复用同步那套 `createWebCryptoPorts`：那套还要密钥（内容密钥 / 盲化密钥），
 * 而"导出全部为一个文件"是**用户自己保管的整份数据** —— 不签名、不加密、与同步无关
 * （计划里明确写着"远端 op 日志不是 SQLite 备份"）。所以这里不需要任何密钥。
 *
 * gzip 用浏览器自带的 `CompressionStream`（与 Node 的 zlib 是同一套格式），因此零依赖。
 */

async function pump(data: Uint8Array, stream: ReadableWritablePair<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(data);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function createBackupPorts(): BackupPorts {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('这个环境没有 WebCrypto，无法摘要备份');
  return {
    digest: {
      async sha256(data: Uint8Array): Promise<Uint8Array> {
        const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        return new Uint8Array(await subtle.digest('SHA-256', buffer));
      },
    },
    compressor: {
      algorithm: 'gzip',
      compress: (data) =>
        pump(data, new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>),
      decompress: (data) =>
        pump(data, new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>),
    },
  };
}
