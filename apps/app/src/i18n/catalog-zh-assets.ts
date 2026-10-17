import type { AppMessages } from './messages-types.ts';

/** 中文分片：开发者资产库自检（设置 → 数据与备份 → L3）。 */
export const zhAssets: AppMessages = {
  'settings.row.assetSelfTest': '资产库自检',
  'settings.value.assetSelfTest': '图片存取 / 字节往返',
  'asset.selftest.kind': '实现',
  'asset.selftest.kind.host': '宿主资产服务（持久）',
  'asset.selftest.kind.memory': '浏览器内存（刷新即失）',
  'asset.selftest.persistent': '刷新后保留',
  'asset.selftest.persistent.yes': '是',
  'asset.selftest.persistent.no': '否',
  'asset.selftest.count': '资产数量',
  'asset.selftest.countValue': '{{count}} 个',
  'asset.selftest.bytes': '占用字节',
  'asset.selftest.bytesValue': '{{bytes}} 字节',
  'asset.selftest.bytesSampled': '抽样 {{count}} 个，共 {{bytes}} 字节',
  'asset.selftest.hint': '自检会写入一张 1×1 的临时样图并立即删除，用来验证宿主资产服务真的能 put/get/list/remove。',
  'asset.selftest.run': '运行自检',
  'asset.selftest.running': '正在自检…',
  'asset.selftest.notRun': '还没有运行。',
  'asset.selftest.ok': '自检通过：写入、哈希、回读、列表、删除全部成功。',
  'asset.selftest.failed':
    '自检在「{{step}}」失败：{{message}}。原因可能是宿主资产服务不可用或存储只读；请重试，必要时重启应用；不会影响现有卡片和图片。',
  'asset.selftest.statsFailed': '读取资产库失败：{{message}}。可能是宿主服务暂时不可用；请重试；已有卡片不受影响。',
  'asset.selftest.step.put': '写入',
  'asset.selftest.step.hash': '哈希比对',
  'asset.selftest.step.get': '回读',
  'asset.selftest.step.list': '列表',
  'asset.selftest.step.remove': '删除',
};
