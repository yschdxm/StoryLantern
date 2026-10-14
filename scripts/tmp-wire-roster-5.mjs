import { readFileSync, writeFileSync } from 'node:fs';

const file = 'apps/app/src/main.tsx';
let text = readFileSync(file, 'utf8');

// buildSyncService 的调用需要一个组装好的 RunSyncInput：抽成局部函数，三处复用
text = text.replace(
  '    const [hasSyncSecret, setHasSyncSecret] = useState(false);',
  [
    '    const [hasSyncSecret, setHasSyncSecret] = useState(false);',
    '    /** 把"当前配置 + 宿主能力"组装成一次同步所需的输入（run / devices / revoke / collect 共用）。 */',
    '    const syncInput = async (config: Awaited<ReturnType<typeof readSyncConfig>>, folderBackend?: FolderBackendProvider) => ({',
    '      repository: opRepositoryForSync,',
    '      settings: ports.settings,',
    '      device: ports.device,',
    '      config,',
    '      backendFactory,',
    '      ...(folderBackend === undefined ? {} : { folderBackend }),',
    '      ...(hostFetch === undefined ? {} : { hostFetch }),',
    '    });',
  ].join('\n'),
);

// devices / revoke / collect：改用 buildSyncService
text = text.replaceAll(
  [
    '              const config = await readSyncConfig(store.getState().settings, ports.device);',
    '              const built = await buildSyncService(config);',
  ].join('\n'),
  [
    '              const config = await readSyncConfig(store.getState().settings, ports.device);',
    '              const built = await buildSyncService(await syncInput(config, scopedFolderProvider(config)));',
  ].join('\n'),
);

writeFileSync(file, text, 'utf8');
console.log('  main.tsx：同步输入已抽出');
