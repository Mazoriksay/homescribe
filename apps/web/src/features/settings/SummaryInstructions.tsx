import { SUMMARY_INSTRUCTIONS_MAX_LENGTH } from '@homescribe/shared';
import { Button, Input } from 'antd';
import { useId, useState } from 'react';
import { useGetSummarySettingsQuery, useSaveSummarySettingsMutation } from '../../api/api';
import { useT } from '../../i18n/useT';
import styles from './Settings.module.css';

/** The user's own additions to the summary prompt (SPEC.md §8). */
export function SummaryInstructions() {
  const t = useT();
  const id = useId();
  const { data } = useGetSummarySettingsQuery();
  const [save, { isLoading, isSuccess, reset }] = useSaveSummarySettingsMutation();
  // null until edited: the saved text shows as it is.
  const [draft, setDraft] = useState<string | null>(null);

  if (!data) return null;
  const text = draft ?? data.instructions;
  const changed = text.trim() !== data.instructions;
  return (
    <div className={styles.sub}>
      <h3 className={styles.subheading}>
        <label htmlFor={`${id}-text`}>{t('settings.summaryInstructions')}</label>
      </h3>
      <Input.TextArea
        id={`${id}-text`}
        value={text}
        onChange={(event) => {
          setDraft(event.target.value);
          reset();
        }}
        autoSize={{ minRows: 3, maxRows: 10 }}
        maxLength={SUMMARY_INSTRUCTIONS_MAX_LENGTH}
        placeholder={t('settings.summaryInstructionsExample')}
      />
      {changed && (
        <div className={styles.actions}>
          <Button
            type="primary"
            loading={isLoading}
            onClick={() => void save({ instructions: text.trim() }).then(() => setDraft(null))}
          >
            {t('settings.save')}
          </Button>
          <button type="button" className="link-action" onClick={() => setDraft(null)}>
            {t('settings.cancel')}
          </button>
        </div>
      )}
      {isSuccess && !changed && (
        <p className={styles.ok} role="status">
          {t('settings.summaryInstructionsSaved')}
        </p>
      )}
    </div>
  );
}
