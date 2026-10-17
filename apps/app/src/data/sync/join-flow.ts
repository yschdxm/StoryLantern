import type { SyncBackend } from '../../../../../packages/sync-core/src/backend.ts';
import { describeError } from '../error-text.ts';
import {
  JOIN_PREFIX,
  createJoinRequest,
  joinPath,
  parseJoinRequest,
  serializeJoinRequest,
  verifyJoinRequest,
  type JoinProofPort,
} from '../../../../../packages/sync-core/src/join.ts';
import {
  KEYRING_FILE,
  parseKeyring,
  serializeKeyring,
  type KeyWrapPort,
  type Keyring,
} from '../../../../../packages/sync-core/src/keyring.ts';
import type { DeviceStore } from '../op-ports.ts';

/**
 * 加入流程（"输密码进来"这条路）。
 *
 * 两步：
 *  1. **写自己的加入请求**：我不在 keyring 里（说明还没人把钥匙包给我）时，
 *     用**密码派生的钥匙**写一份带协商公钥的请求到明文区 `join/<deviceId>.json`；
 *  2. **接收别人的请求**：列出 `join/`，**先查黑名单**、再验密码证明；
 *     验过的就用它的协商公钥把**当前数据钥匙**包一份加进 keyring（**epoch 不变**）。
 *
 * 为什么 epoch 不变：内容密钥没换，只是多一个人能解开它——这正好是"临时踢出后输密码还能回来"的语义。
 * 要**永久禁用**才换代（新钥匙只包给留下的设备），那是另一条流程。
 *
 * 并发：加条目是"读-改-写"。哑存储没有 CAS，所以写回后**读回校验**，
 * 少了就重试（有上限）；处理过的请求记在本机，避免重复包。
 */

/** 本机已处理过的加入请求（deviceId -> at），避免重复包钥匙。 */
export const JOIN_SEEN_KEY = 'sync.join.seen.v1';

export interface PublishJoinInput {
  backend: SyncBackend;
  deviceId: string;
  agreementKey: string;
  joinProof: JoinProofPort;
  now?: () => number;
}

/** 写（或更新）自己的加入请求。 */
export async function publishJoinRequest(input: PublishJoinInput): Promise<void> {
  const request = await createJoinRequest(input.joinProof, {
    deviceId: input.deviceId,
    agreementKey: input.agreementKey,
    ...(input.now === undefined ? {} : { at: input.now() }),
  });
  await input.backend.put(joinPath(input.deviceId), new TextEncoder().encode(serializeJoinRequest(request)));
}

export interface AcceptJoinInput {
  backend: SyncBackend;
  device: DeviceStore;
  keyWrap: KeyWrapPort;
  /** 当前数据钥匙（只有名单里的人解得开它，所以能拿到就说明"我有资格发钥匙"）。 */
  contentKey: Uint8Array;
  /** 黑名单：这些设备的请求**一律不认**（即使它知道口令）。 */
  banned: ReadonlySet<string>;
  joinProof: JoinProofPort;
  selfId: string;
  now?: () => number;
}

export interface AcceptOutcome {
  /** 这次真的把钥匙包给了谁。 */
  accepted: string[];
  /** 被拒绝的（附原因，界面要能直接显示）。 */
  refused: { deviceId: string; reason: string }[];
}

async function loadSeen(device: DeviceStore): Promise<Record<string, number>> {
  const raw = await device.get(JOIN_SEEN_KEY);
  if (raw === undefined || raw === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** 读 keyring（读不到就当没有）。 */
async function readKeyring(backend: SyncBackend): Promise<Keyring | undefined> {
  try {
    return parseKeyring(new TextDecoder().decode(await backend.get(KEYRING_FILE)));
  } catch {
    return undefined;
  }
}

/**
 * 处理别人的加入请求：黑名单优先 → 验密码证明 → 把当前数据钥匙包给对方。
 *
 * 返回"接受了谁 / 拒绝了谁（为什么）"，界面可以如实展示。
 */
export async function acceptJoinRequests(input: AcceptJoinInput): Promise<AcceptOutcome> {
  const outcome: AcceptOutcome = { accepted: [], refused: [] };

  let listing: Awaited<ReturnType<SyncBackend['list']>>;
  try {
    listing = await input.backend.list(JOIN_PREFIX);
  } catch {
    return outcome; // 还没有 join/ 目录：没什么可做的
  }

  const seen = await loadSeen(input.device);
  let seenChanged = false;

  for (const entry of listing.entries) {
    if (!entry.path.startsWith(JOIN_PREFIX)) continue;
    let request;
    try {
      request = parseJoinRequest(new TextDecoder().decode(await input.backend.get(entry.path)));
    } catch (cause) {
      outcome.refused.push({
        deviceId: entry.path.slice(JOIN_PREFIX.length),
        reason: `加入请求读不了：${describeError(cause)}`,
      });
      continue;
    }
    if (request.deviceId === input.selfId) continue;
    if ((seen[request.deviceId] ?? 0) >= request.at) continue; // 处理过了

    const decision = await verifyJoinRequest(input.joinProof, request, {
      revoked: input.banned,
      knownSince: (deviceId) => seen[deviceId],
    });
    if (!decision.ok) {
      outcome.refused.push({ deviceId: request.deviceId, reason: decision.reason ?? '不接受' });
      // 被拒绝的（例如黑名单）也记下来：否则每次同步都会重复报同一条
      if (!input.banned.has(request.deviceId)) {
        seen[request.deviceId] = request.at;
        seenChanged = true;
      }
      continue;
    }

    // 把它加进 keyring：读-改-写 + 读回校验 + 有上限的重试
    // 真机踩到：库里还躺着旧曲线对端的加入请求时，本机（P-256）会**直接抛错**，整个同步都失败。
    // 服务不了的对端就交给能服务的设备去接纳——这里如实跳过并把原因带出去（旧曲线实现已删除）。
    if (!((await input.keyWrap.canWrapFor?.(request.agreementKey)) ?? true)) {
      outcome.refused.push({
        deviceId: request.deviceId,
        reason: '这个对端用的是已淘汰的旧曲线（32 字节公钥），本版本不再支持：请让它重新配对',
      });
      continue;
    }
    const wrapped = await input.keyWrap.wrapFor(request.agreementKey, input.contentKey);
    let added = false;
    for (let attempt = 0; attempt < 4 && !added; attempt += 1) {
      const keyring = await readKeyring(input.backend);
      if (keyring === undefined) {
        outcome.refused.push({ deviceId: request.deviceId, reason: '共享目录里还没有 keyring，先由一台已授权设备建号' });
        break;
      }
      const existing = keyring.entries.find((candidate) => candidate.deviceId === request.deviceId);
      const next: Keyring = {
        v: 1,
        epoch: keyring.epoch,
        entries: [
          ...keyring.entries.filter((candidate) => candidate.deviceId !== request.deviceId),
          { deviceId: request.deviceId, wrapped },
        ],
      };
      if (existing !== undefined && existing.wrapped === wrapped) {
        added = true; // 已经是这份了，不必再写
        break;
      }
      await input.backend.put(KEYRING_FILE, new TextEncoder().encode(serializeKeyring(next)));
      // 读回校验：别人可能同时也在加人（哑存储没有 CAS）
      const verify = await readKeyring(input.backend);
      added = verify?.entries.some((item) => item.deviceId === request.deviceId && item.wrapped === wrapped) === true;
    }

    if (added) {
      outcome.accepted.push(request.deviceId);
      seen[request.deviceId] = request.at;
      seenChanged = true;
      // 接纳后把请求文件删掉：它里面的"口令证明"等同于一个可离线猜口令的 oracle。
      // best-effort（后端可能不支持删除）；失败不影响接纳结果，下次同步会再试。
      try {
        if (input.backend.delete !== undefined) await input.backend.delete(entry.path);
      } catch {
        // 忽略：请求文件残留只会多一次重复处理（seen 已挡），不影响正确性
      }
    } else {
      outcome.refused.push({ deviceId: request.deviceId, reason: '写回 keyring 被抢占（有人同时在加人），下次同步再试' });
    }
  }

  if (seenChanged) await input.device.set(JOIN_SEEN_KEY, JSON.stringify(seen));
  return outcome;
}

/** v2 的证明带 `v2:` 前缀；没有前缀的是旧快 KDF 格式（会被清理）。 */
export function isLegacyJoinProof(proof: string): boolean {
  return proof !== '' && !proof.startsWith('v2:');
}

/**
 * 清理旧格式加入请求：旧证明是用"快 KDF"派生的口令密钥封的，留在共享目录里
 * 就等于给拿到后端读取权限的人一个离线猜口令的 oracle。升级到 v2 后这些请求本来也要重发。
 *
 * 返回删掉的条数；读不了的请求跳过（不因为一条坏数据卡死清理）。
 */
export async function dropLegacyJoinRequests(backend: SyncBackend): Promise<number> {
  let listing: Awaited<ReturnType<SyncBackend['list']>>;
  try {
    listing = await backend.list(JOIN_PREFIX);
  } catch {
    return 0;
  }
  let dropped = 0;
  for (const entry of listing.entries) {
    if (!entry.path.startsWith(JOIN_PREFIX)) continue;
    let request;
    try {
      request = parseJoinRequest(new TextDecoder().decode(await backend.get(entry.path)));
    } catch {
      continue;
    }
    if (!isLegacyJoinProof(request.proof)) continue;
    try {
      if (backend.delete !== undefined) await backend.delete(entry.path);
      dropped += 1;
    } catch {
      // 删不掉就下次再试；不阻断同步
    }
  }
  return dropped;
}
