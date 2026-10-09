import { Button, InputNumber } from 'antd';
import { useState } from 'react';
import { useGetLlmContextQuery, useSetLlmContextMutation } from '../../api/api';
import { useLocale, useT } from '../../i18n/useT';
import styles from './Settings.module.css';

const short = (tokens: number) => (tokens % 1024 === 0 ? `${tokens / 1024}k` : String(tokens));

/** Settings → Summaries → Context window, for a local Ollama (SPEC.md §7.5). */
export function ContextWindow() {
  const t = useT();
  const locale = useLocale();
  const { data } = useGetLlmContextQuery();
  const [save, { isLoading, isError }] = useSetLlmContextMutation();
  const [custom, setCustom] = useState<number | null>(null);

  if (!data?.supported) return null;
  const number = (n: number) => n.toLocaleString(locale);
  const max = data.max ?? undefined;
  return (
    <div className={styles.form}>
      <div className={styles.field}>
        <span>{t('settings.context.title')}</span>
        <div className={styles.buttons} role="group" aria-label={t('settings.context.title')}>
          <Button
            type={data.value === null ? 'primary' : 'default'}
            aria-pressed={data.value === null}
            loading={isLoading && data.value !== null}
            onClick={() => void save(null)}
          >
            {data.loaded
              ? t('settings.context.ollamaNow', { size: short(data.loaded) })
              : t('settings.context.ollama')}
          </Button>
          {data.presets.map((size) => (
            <Button
              key={size}
              type={data.value === size ? 'primary' : 'default'}
              aria-pressed={data.value === size}
              onClick={() => void save(size)}
            >
              {short(size)}
            </Button>
          ))}
        </div>
      </div>
      <div className={styles.buttons}>
        <InputNumber<number>
          aria-label={t('settings.context.custom')}
          placeholder={t('settings.context.custom')}
          min={data.min}
          max={max}
          step={1024}
          value={custom}
          onChange={(value) => setCustom(value)}
        />
        <Button disabled={custom === null} onClick={() => custom !== null && void save(custom)}>
          {t('settings.context.apply')}
        </Button>
      </div>
      <p className={styles.muted}>
        {t('settings.context.limits', {
          min: number(data.min),
          max: data.max ? number(data.max) : '—',
          chunk: number(data.chunkChars),
        })}
      </p>
      {isError && (
        <p className={styles.muted} role="alert">
          {t('settings.context.invalid', {
            min: number(data.min),
            max: data.max ? number(data.max) : '—',
          })}
        </p>
      )}
    </div>
  );
}
