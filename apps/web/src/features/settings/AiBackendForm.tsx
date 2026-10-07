import { aiPresets, type AiKind, type AiMode, type AiSettings } from '@homescribe/shared';
import { AutoComplete, Button, Input, Segmented, Select } from 'antd';
import { useId, useState } from 'react';
import {
  errorCode,
  errorText,
  useLazyDiscoverAiQuery,
  useListModelsMutation,
  useResetAiSettingsMutation,
  useUpdateAiSettingsMutation,
} from '../../api/api';
import { errorMessageKey, useT } from '../../i18n/useT';
import { DiscoveryList } from './DiscoveryList';
import styles from './Settings.module.css';

const CUSTOM = 'custom';

interface FormState {
  mode: AiMode;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

function initialState(settings: AiSettings): FormState {
  return {
    mode: settings.mode,
    provider: settings.provider ?? CUSTOM,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: '',
  };
}

/** Choose where one AI backend runs: found locally, a cloud API, or off (LLM only). */
export function AiBackendForm({ settings }: { settings: AiSettings }) {
  const t = useT();
  const id = useId();
  const kind: AiKind = settings.kind;
  const [form, setForm] = useState(() => initialState(settings));
  const [discover, discovery] = useLazyDiscoverAiQuery();
  const [listModels, models] = useListModelsMutation();
  const [save, saving] = useUpdateAiSettingsMutation();
  const [reset, resetting] = useResetAiSettingsMutation();
  const [savedOk, setSavedOk] = useState(false);

  const presets = aiPresets.filter((preset) => preset.models[kind]);
  const preset = presets.find((p) => p.id === form.provider);
  const keyIsSaved = settings.hasApiKey && form.baseUrl === settings.baseUrl;
  const update = (change: Partial<FormState>) => {
    setSavedOk(false);
    setForm((current) => ({ ...current, ...change }));
  };

  const modes: { label: string; value: AiMode }[] = [
    { label: t('settings.mode.local'), value: 'local' },
    { label: t('settings.mode.api'), value: 'api' },
    ...(kind === 'llm' ? [{ label: t('settings.mode.off'), value: 'off' as const }] : []),
  ];

  const choosePreset = (value: string) => {
    const next = presets.find((p) => p.id === value);
    update({
      provider: value,
      ...(next && { baseUrl: next.baseUrl, model: next.models[kind] ?? '' }),
    });
  };

  const loadModels = () =>
    void listModels({
      baseUrl: form.baseUrl,
      ...(form.apiKey ? { apiKey: form.apiKey } : { useSavedKeyFor: kind }),
    });

  const onSave = async () => {
    const result = await save({
      kind,
      mode: form.mode,
      provider: form.mode === 'api' && form.provider !== CUSTOM ? form.provider : null,
      ...(form.mode !== 'off' && { baseUrl: form.baseUrl, model: form.model.trim() }),
      ...(form.mode === 'api' && form.apiKey ? { apiKey: form.apiKey } : {}),
      ...(form.mode === 'local' && { apiKey: null }),
    });
    if (!result.error) {
      setSavedOk(true);
      setForm((current) => ({ ...current, apiKey: '' }));
    }
  };

  const onReset = async () => {
    const result = await reset(kind);
    if (result.data) setForm(initialState(result.data));
  };

  const modelOptions = (models.data?.models ?? [])
    .filter((model) => model.kind === kind || model.kind === null)
    .map((model) => ({ value: model.id }));
  const error = saving.error ?? models.error;

  return (
    <div className={styles.form}>
      <p className={styles.current}>
        {settings.mode === 'off'
          ? t('settings.currentOff')
          : t('settings.current', { model: settings.model, url: settings.baseUrl })}
        <span className={styles.source}>{t(`settings.source.${settings.source}`)}</span>
      </p>

      <Segmented<AiMode>
        block
        value={form.mode}
        options={modes}
        onChange={(mode) =>
          update(
            mode === 'api' && form.mode !== 'api' && presets[0]
              ? {
                  mode,
                  provider: presets[0].id,
                  baseUrl: presets[0].baseUrl,
                  model: presets[0].models[kind] ?? '',
                }
              : { mode },
          )
        }
      />

      {form.mode === 'off' && <p className={styles.muted}>{t('settings.offBody')}</p>}

      {form.mode === 'local' && (
        <>
          <Button onClick={() => void discover()} loading={discovery.isFetching}>
            {discovery.isFetching ? t('settings.finding') : t('settings.find')}
          </Button>
          {discovery.data && !discovery.isFetching && (
            <DiscoveryList
              kind={kind}
              discovery={discovery.data}
              selected={form}
              onPick={(baseUrl, model) => update({ baseUrl, model })}
            />
          )}
        </>
      )}

      {form.mode === 'api' && (
        <>
          <label className={styles.field} htmlFor={`${id}-provider`}>
            <span>{t('settings.provider')}</span>
            <Select
              id={`${id}-provider`}
              value={form.provider}
              onChange={choosePreset}
              options={[
                ...presets.map((p) => ({ value: p.id, label: p.name })),
                { value: CUSTOM, label: t('settings.provider.custom') },
              ]}
            />
          </label>
          <label className={styles.field} htmlFor={`${id}-key`}>
            <span>
              {t('settings.apiKey')}
              {preset && (
                <a className={styles.keyLink} href={preset.keyUrl} target="_blank" rel="noreferrer">
                  {t('settings.getKey')}
                </a>
              )}
            </span>
            <Input.Password
              id={`${id}-key`}
              value={form.apiKey}
              autoComplete="off"
              placeholder={keyIsSaved ? t('settings.apiKeySaved') : undefined}
              onChange={(event) => update({ apiKey: event.target.value })}
            />
            <small className={styles.muted}>{t('settings.keyNote')}</small>
          </label>
        </>
      )}

      {form.mode !== 'off' && (
        <>
          {(form.mode === 'local' || form.provider === CUSTOM) && (
            <label className={styles.field} htmlFor={`${id}-url`}>
              <span>{t('settings.address')}</span>
              <Input
                id={`${id}-url`}
                value={form.baseUrl}
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t('settings.addressHint')}
                onChange={(event) => update({ baseUrl: event.target.value.trim() })}
              />
            </label>
          )}
          <div className={styles.field}>
            <label htmlFor={`${id}-model`}>{t('settings.model')}</label>
            <div className={styles.modelRow}>
              <AutoComplete
                id={`${id}-model`}
                className={styles.grow}
                value={form.model}
                options={modelOptions}
                onChange={(model: string) => update({ model })}
                filterOption={(input, option) =>
                  option?.value.toLowerCase().includes(input.toLowerCase()) ?? false
                }
              />
              <Button onClick={loadModels} loading={models.isLoading} disabled={!form.baseUrl}>
                {t('settings.loadModels')}
              </Button>
            </div>
            {models.data && (
              <small className={styles.muted}>
                {t('settings.modelsLoaded', { count: modelOptions.length })}
              </small>
            )}
          </div>
        </>
      )}

      {form.mode === 'api' && <p className={styles.muted}>{t('settings.cloudNote')}</p>}

      {error && (
        <p className={styles.error} role="alert">
          {t(errorMessageKey(errorCode(error)))}
          {errorText(error) && <span className={styles.errorDetail}>{errorText(error)}</span>}
        </p>
      )}
      {savedOk && (
        <p className={styles.ok} role="status">
          {t('settings.saved')}
        </p>
      )}

      <div className={styles.actions}>
        <Button
          type="primary"
          loading={saving.isLoading}
          disabled={form.mode !== 'off' && (!form.baseUrl || !form.model.trim())}
          onClick={() => void onSave()}
        >
          {t('settings.save')}
        </Button>
        {settings.source === 'saved' && (
          <Button loading={resetting.isLoading} onClick={() => void onReset()}>
            {t('settings.reset')}
          </Button>
        )}
      </div>
    </div>
  );
}
