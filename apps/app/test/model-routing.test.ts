import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidatesFor,
  legacyProfile,
  profileKeySetting,
  readProfiles,
  serializeProfiles,
  targetLabel,
  type ModelProfile,
} from '../src/data/model-routing.ts';
import { SETTING_KEYS } from '../src/data/types.ts';

/**
 * 多模型路由的规则本身要能被断言：任务匹配、顺序即回退链、不完整的配置不参与。
 * 密钥的处理方式（写在宿主侧、只传 profileId）在 `apps/shell/src-tauri/src/chat.rs` 里，
 * 这里只断言"路由不会把 key 带进前端"这一条约定。
 */

const profile = (overrides: Partial<ModelProfile> = {}): ModelProfile => ({
  id: 'p1',
  name: '本地小模型',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen',
  temperature: 0.8,
  maxTokens: 512,
  tasks: ['chat'],
  enabled: true,
  ...overrides,
});

const settingsWith = (profiles: ModelProfile[], extra: Record<string, string> = {}): Record<string, string> => ({
  [SETTING_KEYS.modelProfiles]: serializeProfiles(profiles),
  ...extra,
});

test('路由：任务匹配的排前面，没标任务的当通用兜底（顺序即回退链）', () => {
  const settings = settingsWith([
    profile({ id: 'a', name: 'A', tasks: ['summary'] }),
    profile({ id: 'b', name: 'B', tasks: ['chat'] }),
    profile({ id: 'c', name: 'C', tasks: ['chat'] }),
    profile({ id: 'd', name: 'D', tasks: [] }),
  ]);
  assert.deepEqual(
    candidatesFor(settings, 'chat').map((item) => item.id),
    ['b', 'c', 'd'],
  );
  assert.deepEqual(
    candidatesFor(settings, 'summary').map((item) => item.id),
    ['a', 'd'],
  );
  // "只标了摘要"的配置不会拿去聊天：任务标签是用户的意图声明
  assert.ok(!candidatesFor(settings, 'chat').some((item) => item.id === 'a'));
});

test('路由：只标了别的任务时，该任务没有候选（宁可明说没有可用配置）', () => {
  const settings = settingsWith([profile({ id: 'a', tasks: ['summary'] })]);
  assert.deepEqual(candidatesFor(settings, 'chat'), []);
  assert.deepEqual(
    candidatesFor(settings, 'summary').map((item) => item.id),    ['a'],
  );
});

test('路由：停用的、地址或模型名不全的配置都不参与（不给用户制造莫名其妙的失败）', () => {
  const settings = settingsWith([
    profile({ id: 'off', enabled: false }),
    profile({ id: 'nourl', baseUrl: '' }),
    profile({ id: 'nomodel', model: '' }),
    profile({ id: 'ok' }),
  ]);
  assert.deepEqual(
    candidatesFor(settings, 'chat').map((item) => item.id),
    ['ok'],
  );
});

test('路由：没有任何配置时回退到旧的那组单模型设置（M1 设置不必改就能用）', () => {
  const settings = {
    [SETTING_KEYS.baseUrl]: 'http://127.0.0.1:15198/v1',
    [SETTING_KEYS.model]: 'mock',
    [SETTING_KEYS.temperature]: '0.7',
    [SETTING_KEYS.maxTokens]: '256',
  };
  const candidates = candidatesFor(settings, 'chat');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.id, '', '空 id 表示"用默认那组设置"');
  assert.equal(candidates[0]?.model, 'mock');
  assert.equal(candidates[0]?.temperature, 0.7);
  assert.equal(candidates[0]?.maxTokens, 256);
});

test('路由：旧设置没配全时不给候选（而不是发一个必然失败的请求）', () => {
  assert.equal(candidatesFor({}, 'chat').length, 0);
  assert.equal(candidatesFor({ [SETTING_KEYS.baseUrl]: 'http://x/v1' }, 'chat').length, 0);
  assert.equal(legacyProfile({ [SETTING_KEYS.baseUrl]: 'http://x/v1' }), undefined);
});

test('路由：坏 JSON / 缺字段 / 重复 id 都能安全读入（配置不该让应用起不来）', () => {
  assert.deepEqual(readProfiles({}), []);
  assert.deepEqual(readProfiles({ [SETTING_KEYS.modelProfiles]: '{不是 JSON' }), []);
  assert.deepEqual(readProfiles({ [SETTING_KEYS.modelProfiles]: '{"a":1}' }), []);

  const messy = JSON.stringify([
    { id: 'a' },
    { id: 'a', name: '重复的' },
    { id: '  ' },
    null,
    { id: 'b', name: '  ', tasks: ['chat', 'nonsense'], temperature: 'hot', maxTokens: 12.9 },
  ]);
  const parsed = readProfiles({ [SETTING_KEYS.modelProfiles]: messy });
  assert.deepEqual(parsed.map((item) => item.id), ['a', 'b']);
  assert.equal(parsed[0]?.name, 'a', '缺名字时用 id 顶上');
  assert.equal(parsed[1]?.name, 'b');
  assert.deepEqual(parsed[1]?.tasks, ['chat'], '不认识的任务被丢掉');
  assert.equal(parsed[1]?.temperature, 0.9, '坏的温度退回默认');
  assert.equal(parsed[1]?.maxTokens, 12, 'token 取整');
});

test('路由：密钥只按 id 存在宿主侧键上，路由本身不带任何密钥字段', () => {
  assert.equal(profileKeySetting('abc'), 'model.profile.abc.api_key');
  const serialized = serializeProfiles([profile()]);
  assert.ok(!serialized.includes('api_key'), '配置元数据里绝不能出现密钥字段');
  assert.ok(!serialized.includes('key'));
  assert.ok(!Object.keys(profile()).includes('apiKey'));
});

test('路由：候选的展示名能区分"任务匹配"与"兜底"', () => {
  assert.equal(targetLabel(profile({ name: 'A', model: 'm', tasks: ['chat'] })), 'A（m）');
  assert.equal(targetLabel(profile({ name: 'B', model: 'm', tasks: [] })), 'B（m·兜底）');
  assert.equal(targetLabel(profile({ id: '', name: '默认', model: 'm' })), '默认（m）');
});

test('B27：embed / agent 任务能路由，readProfiles 读回它们（未知任务仍被过滤）', () => {
  const settings = settingsWith([profile({ id: 'e', tasks: ['embed'] }), profile({ id: 'g', tasks: ['agent'] })]);
  assert.deepEqual(candidatesFor(settings, 'embed').map((item) => item.id), ['e']);
  assert.deepEqual(candidatesFor(settings, 'agent').map((item) => item.id), ['g']);
  const parsed = readProfiles(settings);
  assert.deepEqual(parsed.find((item) => item.id === 'e')?.tasks, ['embed']);
  assert.deepEqual(parsed.find((item) => item.id === 'g')?.tasks, ['agent']);
  assert.deepEqual(
    readProfiles(settingsWith([profile({ id: 'x', tasks: ['nonsense' as never] })])).find((item) => item.id === 'x')?.tasks,
    [],
    '不认识的任务值不能冒充已知任务',
  );
});
