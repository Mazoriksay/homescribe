import { Button, InputNumber, Select } from 'antd';
import { useId, useState } from 'react';
import {
  useGetAiMemoryQuery,
  useGetLlmContextQuery,
  useSetLlmContextMutation,
} from '../../api/api';
import { useLocale, useT } from '../../i18n/useT';
import styles from './Settings.module.css';

const short = (tokens: number) => (tokens % 1024 === 0 ? `${tokens / 1024}k` : String(tokens));
const OLLAMA = 'ollama';
const CUSTOM = 'custom';

/** Settings → Summaries → Context window, for a local Ollama (SPEC.md §7.5). */
export function ContextWindow() {
  const t = useT();
  const id = useId();
  const locale = useLocale();
  const { data } = useGetLlmContextQuery();
  const { data: memory } = useGetAiMemoryQuery();
  const [save, { isLoading, isError }] = useSetLlmContextMutation();
  // The number field shows only when asked for, or when the saved value is not a preset.
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState<number | null>(null);

  if (!data?.supported) return null;
  const number = (n: number) => n.toLocaleString(locale);
  const isPreset = data.value === null || data.presets.includes(data.value);
  const showCustom = customOpen || !isPreset;
  const selected = showCustom ? CUSTOM : data.value === null ? OLLAMA : String(data.value);

  // Ollama keeps in video memory less than the whole model: the rest runs on the CPU.
  const spill = memory?.llm.loaded.find(
    ({ vramBytes, sizeBytes }) => vramBytes && sizeBytes && sizeBytes > vramBytes * 1.02,
  );
  const onCpu =
    spill?.vramBytes && spill.sizeBytes
      ? Math.round((1 - spill.vramBytes / spill.sizeBytes) * 100)
      : null;

  const choose = (value: string) => {
    if (value === CUSTOM) {
      setCustomOpen(true);
      setCustom(data.value);
      return;
    }
    setCustomOpen(false);
    void save(value === OLLAMA ? null : Number(value));
  };

  return (
    <div className={styles.sub}>
      <h3 className={styles.subheading}>
        <label htmlFor={`${id}-size`}>{t('settings.context.title')}</label>
      </h3>
      <Select
        id={`${id}-size`}
        className={styles.select}
        value={selected}
        loading={isLoading}
        onChange={choose}
        options={[
          {
            value: OLLAMA,
            label: data.loaded
              ? t('settings.context.ollamaNow', { size: short(data.loaded) })
              : t('settings.context.ollama'),
          },
          ...data.presets.map((size) => ({ value: String(size), label: short(size) })),
          { value: CUSTOM, label: t('settings.context.customOption') },
        ]}
      />
      {showCustom && (
        <div className={styles.field}>
          <label htmlFor={`${id}-tokens`}>
            {t('settings.context.custom', {
              min: number(data.min),
              max: data.max ? number(data.max) : '—',
            })}
          </label>
          <div className={styles.buttons}>
            <InputNumber<number>
              id={`${id}-tokens`}
              min={data.min}
              max={data.max ?? undefined}
              step={1024}
              value={custom ?? data.value}
              onChange={(value) => setCustom(value)}
            />
            <Button
              disabled={custom === null || custom === data.value}
              loading={isLoading}
              onClick={() => custom !== null && void save(custom)}
            >
              {t('settings.context.apply')}
            </Button>
          </div>
        </div>
      )}
      <p className={styles.muted}>
        {t('settings.context.chunks', { chunk: number(data.chunkChars) })}
      </p>
      {isError && (
        <p className={styles.error} role="alert">
          {t('settings.context.invalid', {
            min: number(data.min),
            max: data.max ? number(data.max) : '—',
          })}
        </p>
      )}
      {onCpu !== null && (
        <p className={styles.error} role="status">
          {t('settings.context.onCpu', { percent: onCpu })}
        </p>
      )}
    </div>
  );
}
