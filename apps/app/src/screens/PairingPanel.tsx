import { useState, type ReactNode } from 'react';
import { Button, Field } from '../ui/components.tsx';
import { useT } from '../i18n/context.tsx';
import { encodeQr, qrPathData } from '../data/sync/qr.ts';

/**
 * 配对面板：把"新设备要能开始同步"所需的一切，在一台设备的屏幕上生成、在另一台上贴进去。
 *
 * 为什么不做扫码：真正要带外传的是**同步口令**（端到端加密的根），它不能出现在远端，
 * 所以只能从屏幕传到屏幕。扫码需要相机权限 + 二维码**解码**器（第三方依赖或几百行自实现）；
 * 而粘贴一段文本在手机上同样两秒完成，且不依赖任何平台能力。二维码**显示**（编码器）
 * 是自包含的一小块，记为下一步，不在这一轮假装已经能扫。
 *
 * 与 `packages/sync-core/src/pairing.ts` 的关系：那套设计把端到端主密钥直接放进邀请里，
 * 与当前"口令 → keyring → 内容钥匙"的链路不是同一条；接上它属于协议级改动，见 join-link.ts 的说明。
 */
export interface PairingPanelProps {
  createJoinLink(): Promise<{ link: string; expiresAt: number }>;
  applyJoinLink(link: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export function PairingPanel(props: PairingPanelProps): ReactNode {
  const t = useT();
  const [link, setLink] = useState('');
  const [expiresAt, setExpiresAt] = useState(0);
  const [paste, setPaste] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [qrPath, setQrPath] = useState('');
  const [qrSize, setQrSize] = useState(0);

  /** 生成链接的同时画二维码；内容太长（版本 20 都放不下）就只给文本，并说明原因。 */
  const drawQr = (value: string): void => {
    try {
      const code = encodeQr(value);
      setQrPath(qrPathData(code));
      setQrSize(code.size);
    } catch (error) {
      setQrPath('');
      setQrSize(0);
      setNote(error instanceof Error ? error.message : String(error));
    }
  };

  const generate = (): void => {
    setBusy(true);
    setNote('');
    void props
      .createJoinLink()
      .then((created) => {
        setLink(created.link);
        setExpiresAt(created.expiresAt);
        drawQr(created.link);
      })
      .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  const apply = (): void => {
    setBusy(true);
    setNote('');
    void props
      .applyJoinLink(paste)
      .then((result) => {
        setNote(result.ok ? t('sync.pair.applied') : result.error);
        if (result.ok) setPaste('');
      })
      .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Field label={t('sync.pair.title')} hint={t('sync.pair.create.hint')}>
        <Button disabled={busy} onClick={generate}>
          {t('sync.pair.generate')}
        </Button>
      </Field>
      {link !== '' && (
        <>
          {/* 二维码只是便利：真机能不能扫由相机 App 决定，所以文本链接始终一起给出 */}
          {qrPath !== '' && (
            <svg
              className="pair-qr"
              viewBox={`0 0 ${qrSize} ${qrSize}`}
              width={qrSize * 6}
              height={qrSize * 6}
              role="img"
              aria-label={t('sync.pair.qr')}
              shapeRendering="crispEdges"
            >
              <rect width={qrSize} height={qrSize} fill="#fff" />
              <path d={qrPath} fill="#000" />
            </svg>
          )}
          <p className="muted">{t('sync.pair.qr.hint')}</p>
          {/* 只读、可全选：这段文本里含同步口令，只应在本机屏幕上出现 */}
          <textarea className="input" readOnly rows={3} value={link} aria-label={t('sync.pair.title')} />
          <p className="muted">
            {t('sync.pair.expires', { time: new Date(expiresAt).toLocaleTimeString() })}
          </p>
        </>
      )}
      <Field label={t('sync.pair.paste')} hint={t('sync.pair.paste.hint')}>
        <textarea
          className="input"
          rows={3}
          value={paste}
          placeholder="storylantern://join?v=1&c=…&p=…"
          onChange={(event) => setPaste(event.target.value)}
        />
      </Field>
      <Button disabled={busy || paste.trim() === ''} onClick={apply}>
        {t('sync.pair.apply')}
      </Button>
      {note !== '' && <p className="muted">{note}</p>}
    </>
  );
}
