import type { BackendMemory } from '@homescribe/shared';
import { Button } from 'antd';
import { useGetAiMemoryQuery, useUnloadAiMutation } from '../../api/api';
import { useT } from '../../i18n/useT';
import styles from './Settings.module.css';

/** "Free video memory": unloads the local models now instead of after ~5 minutes. */
export function MemorySection() {
  const t = useT();
  // Models unload by themselves after a while; keep the list current while the page is open.
  const { data } = useGetAiMemoryQuery(undefined, { pollingInterval: 10_000 });
  const [unload, { data: result, isLoading }] = useUnloadAiMutation();

  const local = (b: BackendMemory) => b.state !== 'remote' && b.state !== 'off';
  // Cloud APIs and summaries turned off hold nothing on this machine.
  if (!data || (!local(data.stt) && !local(data.llm))) return null;

  // Only servers that unload on request count; speaches does it by itself.
  const unloadable = [data.stt, data.llm].filter((b) => b.state === 'ok');
  const loaded = unloadable.reduce((n, b) => n + b.loaded.length, 0);
  const describe = (b: BackendMemory) => {
    if (b.state === 'unsupported') return t('settings.memory.unsupported');
    if (b.state === 'unreachable') return t('settings.memory.unreachable');
    if (b.loaded.length === 0) return t('settings.memory.unloaded');
    const models = b.loaded
      .map(({ model, vramBytes }) =>
        vramBytes
          ? `${model} · ${t('settings.memory.size', { gb: (vramBytes / 1e9).toFixed(1) })}`
          : model,
      )
      .join(', ');
    return b.state === 'auto' ? `${models} · ${t('settings.memory.auto')}` : models;
  };

  return (
    <section className={styles.section} aria-labelledby="settings-memory">
      <h2 id="settings-memory" className={styles.heading}>
        {t('settings.memory.title')}
      </h2>
      <dl className={styles.current}>
        {(['stt', 'llm'] as const)
          .filter((kind) => local(data[kind]))
          .map((kind) => (
            <div key={kind}>
              <dt className={styles.source}>{t(`settings.${kind}.title`)}</dt>
              <dd>{describe(data[kind])}</dd>
            </div>
          ))}
      </dl>
      {unloadable.length > 0 && (
        <div>
          <Button
            loading={isLoading}
            disabled={data.busy || loaded === 0}
            onClick={() => void unload()}
          >
            {t('settings.memory.free')}
          </Button>
        </div>
      )}
      {unloadable.length > 0 && data.busy && (
        <p className={styles.muted}>{t('settings.memory.busy')}</p>
      )}
      {unloadable.length > 0 && !data.busy && loaded === 0 && (
        <p className={styles.muted}>{t('settings.memory.empty')}</p>
      )}
      {result && result.failed.length > 0 && (
        <p className={styles.muted} role="alert">
          {t('settings.memory.failed', { models: result.failed.join(', ') })}
        </p>
      )}
    </section>
  );
}
