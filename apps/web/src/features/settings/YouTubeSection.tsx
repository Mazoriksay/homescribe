import type { CookieStatus, Pairing } from '@homescribe/shared';
import { Button } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import {
  useCreatePairingMutation,
  useDeleteCookiesMutation,
  useGetCookiesQuery,
  useUploadCookiesMutation,
} from '../../api/api';
import { apiBase, basePath } from '../../app/base';
import { useLocale, useT } from '../../i18n/useT';
import styles from './Settings.module.css';

/** "5 minutes ago" in the UI language. */
export function timeAgo(iso: string, locale: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(seconds, 'second');
}

/** YouTube cookies: the extension or a cookies.txt (SPEC.md §7.8). */
export function YouTubeSection() {
  const t = useT();
  const locale = useLocale();
  const { hash } = useLocation();
  const section = useRef<HTMLElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const { data: cookies } = useGetCookiesQuery(undefined, { pollingInterval: 30_000 });
  const [createPairing, { data: pairing, isLoading: pairingLoading }] = useCreatePairingMutation();
  const [upload, { isLoading: uploading }] = useUploadCookiesMutation();
  const [remove, { isLoading: removing }] = useDeleteCookiesMutation();
  const [uploadFailed, setUploadFailed] = useState(false);

  // "Connect YouTube" on a recording links here.
  useEffect(() => {
    if (hash === '#youtube') section.current?.scrollIntoView({ block: 'start' });
  }, [hash]);

  const status = (c: CookieStatus) => {
    if (c.status === 'none') return t('settings.youtube.none');
    if (c.status === 'expired') return t('settings.youtube.expired');
    const ago = c.updatedAt ? timeAgo(c.updatedAt, locale) : '';
    return c.status === 'ok'
      ? t('settings.youtube.ok', { ago })
      : t('settings.youtube.unchecked', { ago });
  };

  const onFile = async (chosen: File | undefined) => {
    if (!chosen) return;
    setUploadFailed(false);
    const result = await upload(await chosen.text());
    setUploadFailed('error' in result);
    if (file.current) file.current.value = '';
  };

  return (
    <section
      ref={section}
      id="youtube"
      className={styles.section}
      aria-labelledby="settings-youtube"
    >
      <h2 id="settings-youtube" className={styles.heading}>
        YouTube
      </h2>
      {cookies && (
        <p>
          {status(cookies)}
          {cookies.source && (
            <span className={styles.source}>
              {' · '}
              {t(`settings.youtube.source.${cookies.source}`)}
            </span>
          )}
        </p>
      )}
      <p className={styles.muted}>{t('settings.youtube.account')}</p>
      <div className={styles.buttons}>
        <Button type="primary" loading={pairingLoading} onClick={() => void createPairing()}>
          {t('settings.youtube.connect')}
        </Button>
        <Button loading={uploading} onClick={() => file.current?.click()}>
          {t('settings.youtube.upload')}
        </Button>
        {cookies && (cookies.status !== 'none' || cookies.paired) && (
          <Button loading={removing} onClick={() => void remove()}>
            {t('settings.youtube.remove')}
          </Button>
        )}
        <input
          ref={file}
          type="file"
          accept=".txt,text/plain"
          hidden
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
      </div>
      {uploadFailed && (
        <p className={styles.muted} role="alert">
          {t('settings.youtube.badFile')}
        </p>
      )}
      {pairing && <ExtensionSteps pairing={pairing} />}
    </section>
  );
}

/**
 * Whether the extension is installed in this browser: its icon is a
 * web-accessible resource, so it loads only when the extension is there.
 * Firefox gives each install its own address, so there it never loads.
 */
function useExtensionInstalled(extensionId: string) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const image = new Image();
    image.onload = () => setInstalled(true);
    image.onerror = () => setInstalled(false);
    image.src = `chrome-extension://${extensionId}/icon.png?${attempt}`;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [extensionId, attempt]);
  return { installed, recheck: () => setAttempt((n) => n + 1) };
}

function ExtensionSteps({ pairing }: { pairing: Pairing }) {
  const t = useT();
  const { installed, recheck } = useExtensionInstalled(pairing.extensionId);
  const server = `${window.location.origin}${basePath}`;
  const link = `chrome-extension://${pairing.extensionId}/pair.html#${new URLSearchParams({
    server,
    code: pairing.code,
  })}`;
  return (
    <div className={styles.form}>
      <ol className={styles.steps}>
        <li>
          <a href={`${apiBase}/extension.zip`} download>
            {t('settings.youtube.download')}
          </a>{' '}
          {t('settings.youtube.unzip')}
        </li>
        <li>{t('settings.youtube.chromium')}</li>
        <li>
          {installed ? (
            <a href={link} target="_blank" rel="noopener">
              {t('settings.youtube.pairLink')}
            </a>
          ) : (
            <span className={styles.muted}>
              {installed === false && t('settings.youtube.notInstalled')}{' '}
              <button type="button" className="link-action" onClick={recheck}>
                {t('settings.youtube.recheck')}
              </button>
            </span>
          )}
        </li>
      </ol>
      <p className={styles.muted}>{t('settings.youtube.manual', { server, code: pairing.code })}</p>
      <p className={styles.muted}>{t('settings.youtube.firefox')}</p>
    </div>
  );
}
