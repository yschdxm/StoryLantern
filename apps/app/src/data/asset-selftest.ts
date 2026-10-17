/**
 * 资产库自检（开发者面板用）：**真实走一遍宿主 put/get/list/remove**。
 *
 * 为什么值得有：资产通道（相册选择 → 宿主目录 → 同步索引）在浏览器里能跑通，
 * 不代表 Tauri 宿主的 `assets` 服务能跑通；真机上点一下自检，比"看起来有缩略图"可靠。
 *
 * `SELF_TEST_PNG_BASE64` 是一张 1×1 透明 PNG：**自检样本，不是产品图片/示例内容**。
 */

import type { AssetClient } from './asset-client.ts';

/** 1×1 透明 PNG（字节级自检样本）。 */
export const SELF_TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6n0sAAAAASUVORK5CYII=';

export function selfTestPngBytes(): Uint8Array {
  const binary = atob(SELF_TEST_PNG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type AssetSelfTestStep = 'put' | 'hash' | 'get' | 'list' | 'remove';

export interface AssetSelfTestResult {
  step: AssetSelfTestStep;
  ok: boolean;
  /** 通过时是辅助信息（hash/字节数）；失败时是原因。 */
  detail?: string;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** 串行执行；任一步失败立即停止并返回已执行的结果（UI 据此显示哪一步/为什么）。 */
export async function runAssetSelfTest(client: AssetClient): Promise<AssetSelfTestResult[]> {
  const bytes = selfTestPngBytes();
  const results: AssetSelfTestResult[] = [];

  let hash: string;
  try {
    hash = await client.put(bytes);
    results.push({ step: 'put', ok: true, detail: hash });
  } catch (cause) {
    return [...results, { step: 'put', ok: false, detail: messageOf(cause) }];
  }

  try {
    const expected = await sha256HexOf(bytes);
    const ok = hash === expected;
    results.push({ step: 'hash', ok, detail: ok ? hash : `期望 ${expected}，实际 ${hash}` });
    if (!ok) return results;
  } catch (cause) {
    return [...results, { step: 'hash', ok: false, detail: messageOf(cause) }];
  }

  try {
    const read = await client.get(hash);
    const ok = read !== undefined && sameBytes(read, bytes);
    results.push({ step: 'get', ok, detail: ok ? `${String(bytes.length)} 字节` : '回读为空或字节不一致' });
    if (!ok) return results;
  } catch (cause) {
    return [...results, { step: 'get', ok: false, detail: messageOf(cause) }];
  }

  try {
    const hashes = await client.list();
    const ok = hashes.includes(hash);
    results.push({ step: 'list', ok, detail: ok ? hash : '列表里没有刚写入的 hash' });
    if (!ok) return results;
  } catch (cause) {
    return [...results, { step: 'list', ok: false, detail: messageOf(cause) }];
  }

  try {
    const removed = await client.remove(hash);
    results.push({ step: 'remove', ok: removed, detail: removed ? hash : '宿主返回未删除' });
  } catch (cause) {
    results.push({ step: 'remove', ok: false, detail: messageOf(cause) });
  }
  return results;
}


