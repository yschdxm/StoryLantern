import { useEffect, useState, type ReactNode } from 'react';
import {
  bytesToObjectUrl,
  getAssetClient,
  hashOfAssetRef,
  revokeAssetUrl,
} from '../../data/asset-client.ts';
import { useT } from '../../i18n/context.tsx';

/**
 * 资产缩略图：`asset://<sha256>` → 本机资产库取字节 → object URL 预览。
 *
 * 只读预览，不负责上传/删除。字节取不到（还没同步、被删）时显示「图片缺失」，
 * 但**不**改卡片里的 path——那是数据，不能因为本机暂时没有就抹掉。
 * object URL 在换图/卸载时 revoke，避免内存泄漏。
 */
export function AssetThumb({ path }: { path: string }): ReactNode {
  const t = useT();
  const hash = hashOfAssetRef(path);
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setUrl(undefined);
    setMissing(false);
    if (hash === undefined) return;
    let alive = true;
    let created: string | undefined;
    void getAssetClient()
      .get(hash)
      .then((bytes) => {
        if (!alive) return;
        if (bytes === undefined) {
          setMissing(true);
          return;
        }
        created = bytesToObjectUrl(bytes);
        setUrl(created);
      })
      .catch(() => {
        if (alive) setMissing(true);
      });
    return () => {
      alive = false;
      if (created !== undefined) revokeAssetUrl(created);
    };
  }, [hash]);

  if (hash === undefined) return null;
  if (missing) return <p className="visual-thumb visual-thumb--missing">{t('visuals.thumb.missing')}</p>;
  if (url === undefined) {
    return <span className="visual-thumb visual-thumb--loading" role="status" aria-label={t('visuals.thumb.loading')} />;
  }
  return <img className="visual-thumb" src={url} alt={t('visuals.thumb.alt')} loading="lazy" />;
}
