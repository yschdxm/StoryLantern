import { useEffect, useState, type ReactNode } from 'react';
import { getAssetClient } from '../data/asset-client.ts';
import { runAssetSelfTest, type AssetSelfTestResult } from '../data/asset-selftest.ts';
import { describeError } from '../data/error-text.ts';
import { useT } from '../i18n/context.tsx';
import { Button } from '../ui/components.tsx';
import { SettingsRow } from '../ui/SettingsRow.tsx';

interface LibraryStats {
  count: number;
  sampledCount: number;
  sampledBytes: number;
  sampled: boolean;
}

const SAMPLE_LIMIT = 20;

/**
 * 资产库自检（开发者/真机验证用）：真实调用宿主 `assets` 的 put/get/list/remove。
 *
 * 真机上能拍到缩略图，不代表宿主的资产服务可用；这里做字节级往返。
 * 结果用 `data-testid` 暴露，方便 adb/Playwright 断言。
 */
export function AssetSelfTest(): ReactNode {
  const t = useT();
  const client = getAssetClient();
  const [stats, setStats] = useState<LibraryStats | undefined>(undefined);
  const [statsError, setStatsError] = useState<string | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<AssetSelfTestResult[] | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const hashes = await client.list();
        const sample = hashes.slice(0, SAMPLE_LIMIT);
        let sampledBytes = 0;
        let sampledCount = 0;
        for (const hash of sample) {
          const bytes = await client.get(hash);
          if (bytes !== undefined) {
            sampledBytes += bytes.length;
            sampledCount += 1;
          }
        }
        if (alive) setStats({ count: hashes.length, sampledCount, sampledBytes, sampled: hashes.length > sample.length });
      } catch (cause) {
        if (alive) setStatsError(describeError(cause));
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, reload]);

  const run = async (): Promise<void> => {
    setRunning(true);
    setResults(undefined);
    try {
      setResults(await runAssetSelfTest(client));
    } catch (cause) {
      setResults([{ step: 'put', ok: false, detail: describeError(cause) }]);
    } finally {
      setRunning(false);
    }
  };

  const failed = results?.find((result) => !result.ok);
  const allOk = results !== undefined && failed === undefined;

  return (
    <div className="settings-group" data-testid="asset-selftest">
      <SettingsRow label={t('asset.selftest.kind')} value={t(`asset.selftest.kind.${client.kind}`)} arrow={false} />
      <SettingsRow
        label={t('asset.selftest.persistent')}
        value={client.persistent ? t('asset.selftest.persistent.yes') : t('asset.selftest.persistent.no')}
        arrow={false}
      />
      <SettingsRow label={t('asset.selftest.count')} value={t('asset.selftest.countValue', { count: stats?.count ?? 0 })} arrow={false} />
      <SettingsRow
        label={t('asset.selftest.bytes')}
        value={
          stats === undefined
            ? '—'
            : stats.sampled
              ? t('asset.selftest.bytesSampled', { count: stats.sampledCount, bytes: stats.sampledBytes })
              : t('asset.selftest.bytesValue', { bytes: stats.sampledBytes })
        }
        arrow={false}
      />
      {statsError !== undefined && (
        <div className="notice notice--warn">
          {t('asset.selftest.statsFailed', { message: statsError })}{' '}
          <Button
            variant="ghost"
            onClick={() => {
              setStatsError(undefined);
              setReload((value) => value + 1);
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      <p className="field__hint">{t('asset.selftest.hint')}</p>
      <button
        type="button"
        className="btn btn--primary btn--block"
        data-testid="asset-selftest-run"
        disabled={running}
        onClick={() => void run()}
      >
        {running ? t('asset.selftest.running') : t('asset.selftest.run')}
      </button>
      <div data-testid="asset-selftest-result">
        {results === undefined ? (
          <p className="muted">{t('asset.selftest.notRun')}</p>
        ) : allOk ? (
          <p className="notice notice--ok">{t('asset.selftest.ok')}</p>
        ) : (
          failed !== undefined && (
            <p className="notice notice--warn">
              {t('asset.selftest.failed', {
                step: t(`asset.selftest.step.${failed.step}`),
                message: failed.detail ?? '',
              })}
            </p>
          )
        )}
        {results !== undefined && (
          <p className="muted">
            {results
              .map((result) => `${result.ok ? '✓' : '✗'} ${t(`asset.selftest.step.${result.step}`)}`)
              .join(' · ')}
          </p>
        )}
      </div>
    </div>
  );
}
