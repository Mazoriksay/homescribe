import type { AiKind } from '@homescribe/shared';
import { Button, Segmented } from 'antd';
import { useGetAiSettingsQuery } from '../../api/api';
import { useAppDispatch, useAppSelector } from '../../app/hooks';
import { setLocale, setTheme } from '../../app/prefs';
import type { Locale } from '../../i18n/format';
import { useT } from '../../i18n/useT';
import type { ThemePreference } from '../../theme/theme';
import { AiBackendForm } from './AiBackendForm';
import styles from './Settings.module.css';

export function SettingsPage() {
  const t = useT();
  const dispatch = useAppDispatch();
  const { locale, theme } = useAppSelector((state) => state.prefs);
  const { data, isError, refetch } = useGetAiSettingsQuery();

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{t('settings.title')}</h1>

      {(['stt', 'llm'] as AiKind[]).map((kind) => (
        <section key={kind} className={styles.section} aria-labelledby={`settings-${kind}`}>
          <h2 id={`settings-${kind}`} className={styles.heading}>
            {t(`settings.${kind}.title`)}
          </h2>
          <p className={styles.muted}>{t(`settings.${kind}.body`)}</p>
          {data && <AiBackendForm settings={data[kind]} />}
          {isError && <Button onClick={() => void refetch()}>{t('library.retry')}</Button>}
        </section>
      ))}

      <section className={styles.section} aria-labelledby="settings-appearance">
        <h2 id="settings-appearance" className={styles.heading}>
          {t('settings.appearance')}
        </h2>
        <div className={styles.field}>
          <span>{t('settings.language')}</span>
          <Segmented<Locale>
            value={locale}
            onChange={(value) => dispatch(setLocale(value))}
            options={[
              { label: 'English', value: 'en' },
              { label: 'Русский', value: 'ru' },
            ]}
          />
        </div>
        <div className={styles.field}>
          <span>{t('settings.theme')}</span>
          <Segmented<ThemePreference>
            value={theme}
            onChange={(value) => dispatch(setTheme(value))}
            options={[
              { label: t('theme.auto'), value: 'auto' },
              { label: t('theme.light'), value: 'light' },
              { label: t('theme.dark'), value: 'dark' },
            ]}
          />
        </div>
      </section>
    </div>
  );
}
