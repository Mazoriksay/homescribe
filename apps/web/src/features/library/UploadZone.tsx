import { Button } from 'antd';
import { useRef, useState, type DragEvent } from 'react';
import { errorMessageKey, useT } from '../../i18n/useT';
import { ProgressBar } from '../../ui/ProgressBar';
import { LinkImport } from './LinkImport';
import styles from './UploadZone.module.css';
import { useUploads } from './useUploads';

export function UploadZone() {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { items, add, dismiss } = useUploads();

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    add(event.dataTransfer.files);
  };

  return (
    <section aria-label={t('library.upload.choose')}>
      <div
        className={styles.zone}
        data-dragging={dragging || undefined}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p className={styles.drop}>{t('library.upload.drop')}</p>
        <span className={styles.or}>{t('library.upload.or')}</span>
        <Button type="primary" size="large" onClick={() => input.current?.click()}>
          {t('library.upload.choose')}
        </Button>
        <input
          ref={input}
          type="file"
          accept="audio/*,video/*"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) add(event.target.files);
            event.target.value = '';
          }}
        />
      </div>

      <LinkImport />

      {items.length > 0 && (
        <ul className={styles.uploads}>
          {items.map((item) => (
            <li key={item.key} className={styles.upload}>
              <div className={styles.uploadRow}>
                <span className={styles.name} title={item.name}>
                  {item.name}
                </span>
                {item.error ? (
                  <button type="button" className="link-action" onClick={() => dismiss(item.key)}>
                    {t('library.upload.dismiss')}
                  </button>
                ) : (
                  <span className={styles.percent}>
                    {t('library.upload.uploading', { percent: Math.round(item.progress * 100) })}
                  </span>
                )}
              </div>
              {item.error ? (
                <p className={styles.error} role="alert">
                  {t('library.upload.failed')}: {t(errorMessageKey(item.error))}
                </p>
              ) : (
                <ProgressBar value={item.progress} label={item.name} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
