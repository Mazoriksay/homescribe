import type { AiKind, Discovery } from '@homescribe/shared';
import { Button } from 'antd';
import { useT } from '../../i18n/useT';
import styles from './Settings.module.css';

interface Props {
  kind: AiKind;
  discovery: Discovery;
  selected: { baseUrl: string; model: string };
  onPick: (baseUrl: string, model: string) => void;
}

/** Servers found on this machine, with the models that fit this kind. */
export function DiscoveryList({ kind, discovery, selected, onPick }: Props) {
  const t = useT();

  if (discovery.servers.length === 0) {
    return (
      <div className={styles.notice} role="status">
        <p>{t('settings.foundNone', { list: discovery.probed.join(', ') })}</p>
      </div>
    );
  }

  return (
    <ul className={styles.servers} aria-label={t('settings.found')}>
      {discovery.servers.map((server) => {
        const fitting = server.models.filter((model) => model.kind === kind);
        return (
          <li key={server.baseUrl} className={styles.server}>
            <div className={styles.serverHead}>
              <span className={styles.serverName}>{server.product ?? server.baseUrl}</span>
              <span className={styles.mono}>{server.baseUrl}</span>
            </div>
            {fitting.length === 0 ? (
              <p className={styles.muted}>
                {t('settings.noSuitable', { count: server.models.length })}
              </p>
            ) : (
              <ul className={styles.models}>
                {fitting.map((model) => {
                  const isSelected =
                    selected.baseUrl === server.baseUrl && selected.model === model.id;
                  return (
                    <li key={model.id} className={styles.model}>
                      <span className={styles.modelId} title={model.id}>
                        {model.id}
                      </span>
                      <Button
                        type={isSelected ? 'primary' : 'default'}
                        aria-pressed={isSelected}
                        onClick={() => onPick(server.baseUrl, model.id)}
                      >
                        {t('settings.use')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
