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
import {
  signJoinWithRecovery,
  verifyRecoverySignature,
  type RecoveryFile,
  type RecoveryProofPort,
} from '../../../../../packages/sync-core/src/recovery.ts';
import { createWebCryptoRecoveryProof } from './recovery-key.ts';
import { canUseCurve, curveOfPublicKey } from './envelope.ts';

/**
 * 加入流程（"输密码进来"这条路）。
 *
 * 两步：
 *  1. **写自己的加入请求**：我不在 keyring 里（说明还没人把钥匙包给我）时，
 *     用**密码派生的钥匙**写一份带两把公钥的请求到明文区 `join/<deviceId>.json`；
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
  publicKey: string;
  agreementKey: string;
  joinProof: JoinProofPort;
  /** 忘记口令时：用恢复私钥签一份恢复证明带在请求里（没有就走口令那条路）。 */
  recoveryProof?: string;
  /** 或者直接给私钥，这里自己签（界面粘的就是私钥，少一步）。 */
  recoveryPrivateKey?: string;
  now?: () => number;
}

/** 写（或更新）自己的加入请求。 */
export async function publishJoinRequest(input: PublishJoinInput): Promise<void> {
  // 粘了私钥就在这儿签：证明绑定设备与时间，搬运与重放都不行
  const signed =
    input.recoveryPrivateKey === undefined || input.recoveryPrivateKey === ""
      ? undefined
      : await signJoinWithRecovery(createWebCryptoRecoveryProof(), {
          privateKey: input.recoveryPrivateKey,
          deviceId: input.deviceId,
          at: input.now?.() ?? Date.now(),
        });
  const proof = input.recoveryProof ?? signed;
  const request = await createJoinRequest(input.joinProof, {
    deviceId: input.deviceId,
    publicKey: input.publicKey,
    agreementKey: input.agreementKey,
    ...(proof === undefined ? {} : { recoveryProof: proof }),
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
  /** 恢复密钥实现 + 共享目录里公布的恢复公钥：给了就允许「没口令但有恢复证明」的设备加入。 */
  recoveryProof?: RecoveryProofPort;
  recoveryPublicKey?: string;
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

  // 恢复公钥公布在共享目录里（明文，公钥不是秘密）：谁都能验，但谁也拿不到私钥
  const recoveryPort = input.recoveryProof;
  const recoveryPublicKey = input.recoveryPublicKey ?? "";
  const recoveryFile: RecoveryFile = { v: 1, publicKey: recoveryPublicKey, createdAt: 0 };
  const recoveryVerifier =
    recoveryPort === undefined || recoveryPublicKey === ""
      ? undefined
      : (item: { deviceId: string; at: number; recoveryProof?: string }) =>
          verifyRecoverySignature(recoveryPort, recoveryFile, {
            deviceId: item.deviceId,
            at: item.at,
            signature: item.recoveryProof ?? "",
          });

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
      ...(recoveryVerifier === undefined ? {} : { verifyRecovery: recoveryVerifier }),
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
    // 真机踩到：库里还躺着旧 X25519 对端的加入请求时，本机（WebView 不认识 X25519）会**直接抛错**，
    // 整个同步都失败。服务不了的对端就交给能服务的设备去接纳——这里如实跳过并把原因带出去。
    const curve = curveOfPublicKey(request.agreementKey);
    if (!(await canUseCurve(curve))) {
      outcome.refused.push({
        deviceId: request.deviceId,
        reason: `本机不认识 ${curve} 这条曲线，交给支持它的设备来接纳`,
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
    } else {
      outcome.refused.push({ deviceId: request.deviceId, reason: '写回 keyring 被抢占（有人同时在加人），下次同步再试' });
    }
  }

  if (seenChanged) await input.device.set(JOIN_SEEN_KEY, JSON.stringify(seen));
  return outcome;
}
