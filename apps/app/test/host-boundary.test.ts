import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WireInvokeRequest, WireManifest, WireTransport } from '../../../packages/wire/src/index.ts';
import { createAppStore } from '../src/app/state.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { createChatClient } from '../src/data/chat-client.ts';
import { DataError } from '../src/data/repository.ts';
import { selectSummariesForChat } from '../src/data/summary-vector-select.ts';

/**
 * 应用侧**边界**测试：把这条架构主张钉成可执行的断言 ——
 *
 * 1. **内容是本地的**：角色、设置这些都走仓库（op 日志 + 本地键值），**没有宿主也能用**；
 * 2. **模型必须走宿主**：前端自己调模型会抛 `no-host`（密钥绝不能落到前端）；
 * 3. **向量拿不到就退回词法**：没有通道、或对端没有 `chat.embed` 时，挑摘要返回 `undefined`
 *    （上层据此退回块内的词法检索）—— 绝不让"向量挂了"变成"这次对话失败"。
 *
 * 这三条合起来就是"密钥只在宿主、内容留在本地"这句话的可执行版本。
 */

async function localRepo() {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repo = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await repo.ready;
  return { repo, ports };
}

test('边界：内容（角色、设置）在没有宿主的情况下可用', async () => {
  const { repo } = await localRepo();
  const created = await repo.characters.save({ name: '星野', description: '夜巡的守望者' });
  assert.equal((await repo.characters.list()).length, 1);
  await repo.settings.set('theme', 'dark');
  assert.equal(await repo.settings.get('theme'), 'dark');
  // store 能在没有宿主的情况下建起来，并且内容读得回来（这就是"内容本地优先"的可执行版本）
  const store = createAppStore(repo);
  assert.equal(typeof store.getState, 'function');
  assert.equal((await repo.characters.list()).length, 1, '建了 store 之后内容仍然读得回来');
  assert.equal(created.name, '星野');
});

test('边界：前端自己调模型必须被拒绝（no-host），且提示能照做', async () => {
  const client = createChatClient(undefined);
  let caught: unknown;
  try {
    await client.reply({ messages: [{ role: 'user', content: '你好' }] }, {});
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof DataError, '应当是数据层错误，而不是随便一个异常');
  assert.equal((caught as DataError).code, 'no-host');
  assert.match((caught as DataError).message, /密钥/, '提示要说清为什么不许前端直连');
});

test('边界：没有通道时挑摘要返回 undefined（上层退回词法），不抛错', async () => {
  const summaries = [{ id: 's1', text: '铜铃是父亲留下的遗物。', level: 'scene' as const, covers: [] }];
  const picked = await selectSummariesForChat({
    transport: undefined,
    messages: [{ role: 'user', content: '那个铜铃是什么？' }],
    summaries,
  });
  assert.equal(picked, undefined);
});

test('边界：对端没有 chat.embed 时同样返回 undefined（同样退回词法）', async () => {
  const transport: WireTransport = {
    kind: 'no-embed',
    async manifest(): Promise<WireManifest> {
      // 故意不给 chat.embed：模拟一个没接向量能力的宿主
      return { services: [{ name: 'chat', description: '', methods: [] }] };
    },
    invoke(_request: WireInvokeRequest): AsyncIterable<unknown> {
      return (async function* () {
        yield undefined;
      })();
    },
  };
  const summaries = [{ id: 's1', text: '铜铃是父亲留下的遗物。', level: 'scene' as const, covers: [] }];
  const picked = await selectSummariesForChat({
    transport,
    messages: [{ role: 'user', content: '那个铜铃是什么？' }],
    summaries,
  });
  assert.equal(picked, undefined, '拿不到向量就退回词法，绝不因此让对话失败');
});
