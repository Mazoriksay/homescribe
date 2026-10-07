import { Button, Input } from 'antd';
import { useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { errorCode, useCreateFromUrlMutation } from '../../api/api';
import { errorMessageKey, useT } from '../../i18n/useT';
import styles from './UploadZone.module.css';

/** Paste a link (YouTube and other sites, or a media file) to transcribe it (SPEC.md §7.7). */
export function LinkImport() {
  const t = useT();
  const id = useId();
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [createFromUrl, { isLoading, error, reset }] = useCreateFromUrlMutation();

  const submit = async () => {
    const link = url.trim();
    if (!link) return;
    const result = await createFromUrl({ url: link });
    if (result.data) {
      setUrl('');
      void navigate(`/recordings/${result.data.id}`);
    }
  };

  return (
    <form
      className={styles.link}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={`${id}-url`} className={styles.linkLabel}>
        {t('library.link.label')}
      </label>
      <div className={styles.linkRow}>
        <Input
          id={`${id}-url`}
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          size="large"
          value={url}
          placeholder={t('library.link.placeholder')}
          status={error ? 'error' : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            reset();
            setUrl(event.target.value);
          }}
        />
        <Button
          type="primary"
          size="large"
          htmlType="submit"
          loading={isLoading}
          disabled={!url.trim()}
        >
          {t('library.link.submit')}
        </Button>
      </div>
      {error && (
        <p className={styles.error} role="alert" id={`${id}-error`}>
          {t(errorMessageKey(errorCode(error)))}
        </p>
      )}
    </form>
  );
}
