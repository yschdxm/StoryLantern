import type { AppMessages } from './messages-types.ts';

/** English shard for the developer asset-library self-test (Settings → Data → L3). */
export const enAssets: AppMessages = {
  'settings.row.assetSelfTest': 'Asset library self-test',
  'settings.value.assetSelfTest': 'Image put/get byte round-trip',
  'asset.selftest.kind': 'Implementation',
  'asset.selftest.kind.host': 'Host asset service (persistent)',
  'asset.selftest.kind.memory': 'Browser memory (lost on refresh)',
  'asset.selftest.persistent': 'Survives refresh',
  'asset.selftest.persistent.yes': 'Yes',
  'asset.selftest.persistent.no': 'No',
  'asset.selftest.count': 'Assets',
  'asset.selftest.countValue': '{{count}}',
  'asset.selftest.bytes': 'Bytes',
  'asset.selftest.bytesValue': '{{bytes}} bytes',
  'asset.selftest.bytesSampled': 'sampled {{count}}, {{bytes}} bytes',
  'asset.selftest.hint': 'The self-test writes a temporary 1×1 sample image and removes it, proving the host asset service can really put/get/list/remove.',
  'asset.selftest.run': 'Run self-test',
  'asset.selftest.running': 'Running…',
  'asset.selftest.notRun': 'Not run yet.',
  'asset.selftest.ok': 'Self-test passed: put, hash, read-back, list and remove all succeeded.',
  'asset.selftest.failed':
    'Self-test failed at “{{step}}”: {{message}}. The host asset service may be unavailable or the storage read-only; retry, restart the app if needed; existing cards and images are unaffected.',
  'asset.selftest.statsFailed': 'Could not read the asset library: {{message}}. The host service may be temporarily unavailable; retry; existing cards are unaffected.',
  'asset.selftest.step.put': 'put',
  'asset.selftest.step.hash': 'hash check',
  'asset.selftest.step.get': 'read-back',
  'asset.selftest.step.list': 'list',
  'asset.selftest.step.remove': 'remove',
};
