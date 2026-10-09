import type { CookieStatus, Pairing } from '@homescribe/shared';
import { Button, Popconfirm } from 'antd';
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
      <div className={styles.actions}>
        <Button type="primary" loading={pairingLoading} onClick={() => void createPairing()}>
          {t('settings.youtube.connect')}
        </Button>
        {cookies && (cookies.status !== 'none' || cookies.paired) && (
          <Popconfirm
            title={t('settings.youtube.removeConfirm')}
            okText={t('settings.youtube.remove')}
            cancelText={t('settings.cancel')}
            onConfirm={() => void remove()}
          >
            <button type="button" className="link-action" disabled={removing}>
              {t('settings.youtube.remove')}
            </button>
          </Popconfirm>
        )}
      </div>
      {pairing && <ExtensionSteps pairing={pairing} />}
      <details className={styles.more}>
        <summary>{t('settings.youtube.file')}</summary>
        <div className={styles.form}>
          <p className={styles.muted}>{t('settings.youtube.fileHow')}</p>
          <div>
            <Button loading={uploading} onClick={() => file.current?.click()}>
              {t('settings.youtube.upload')}
            </Button>
          </div>
          <input
            ref={file}
            type="file"
            accept=".txt,text/plain"
            hidden
            onChange={(event) => void onFile(event.target.files?.[0])}
          />
        </div>
      </details>
      {uploadFailed && (
        <p className={styles.error} role="alert">
          {t('settings.youtube.badFile')}
        </p>
      )}
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

/**
 * The extensions page of this browser. Pages may not open it themselves
 * (browsers block links to chrome:// and the like), so it is shown to copy.
 */
export function extensionsPage(
  userAgent = navigator.userAgent,
  brave = 'brave' in navigator,
): { address: string; firefox: boolean } {
  if (/Firefox\//.test(userAgent)) {
    return { address: 'about:debugging#/runtime/this-firefox', firefox: true };
  }
  const scheme = /Edg\//.test(userAgent)
    ? 'edge'
    : /YaBrowser\//.test(userAgent)
      ? 'browser'
      : /OPR\//.test(userAgent)
        ? 'opera'
        : brave
          ? 'brave'
          : 'chrome';
  return { address: `${scheme}://extensions`, firefox: false };
}

function CopyText({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className={styles.address}>
      <code>{text}</code>
      {typeof navigator.clipboard?.writeText === 'function' && (
        <button type="button" className="link-action" onClick={() => void copy()}>
          {copied ? t('settings.youtube.copied') : t('settings.youtube.copy')}
        </button>
      )}
    </span>
  );
}

function ExtensionSteps({ pairing }: { pairing: Pairing }) {
  const t = useT();
  const { installed, recheck } = useExtensionInstalled(pairing.extensionId);
  const page = extensionsPage();
  const server = `${window.location.origin}${basePath}`;
  const link = `chrome-extension://${pairing.extensionId}/pair.html#${new URLSearchParams({
    server,
    code: pairing.code,
  })}`;
  // The unpacked folder is the Chromium build; Firefox needs its own zip.
  const folder = page.firefox ? null : pairing.extensionFolder;
  const firefoxZip = `${apiBase}/extension.zip?browser=firefox`;
  const download = (
    <a href={page.firefox ? firefoxZip : `${apiBase}/extension.zip`} download>
      {t('settings.youtube.download')}
    </a>
  );
  const pair = (
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
  );
  return (
    <div className={styles.form}>
      {folder ? (
        // The installer already unpacked it on this computer: nothing to choose.
        <ol className={styles.steps}>
          <li>
            {t('settings.youtube.openPage')} <CopyText text={page.address} />
          </li>
          <li>
            {t('settings.youtube.pickFolder')} <CopyText text={folder} />
          </li>
          {pair}
        </ol>
      ) : (
        <ol className={styles.steps}>
          <li>
            {download} {t('settings.youtube.unzip')}
          </li>
          <li>
            {t('settings.youtube.openPage')} <CopyText text={page.address} />{' '}
            {t(page.firefox ? 'settings.youtube.firefoxSteps' : 'settings.youtube.chromium')}
          </li>
          {pair}
        </ol>
      )}
      <details className={styles.more}>
        <summary>{t('settings.youtube.moreWays')}</summary>
        <div className={styles.form}>
          <p className={styles.muted}>
            {t('settings.youtube.manual', { server, code: pairing.code })}
          </p>
          {folder && (
            <p className={styles.muted}>
              {download} {t('settings.youtube.elsewhere')}
            </p>
          )}
          {!page.firefox && (
            <p className={styles.muted}>
              <a href={firefoxZip} download>
                {t('settings.youtube.firefoxZip')}
              </a>
              {t('settings.youtube.firefox')}
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
