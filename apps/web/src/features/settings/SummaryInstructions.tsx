import { SUMMARY_INSTRUCTIONS_MAX_LENGTH } from '@homescribe/shared';
import { Button, Input } from 'antd';
import { useState } from 'react';
import { useGetSummarySettingsQuery, useSaveSummarySettingsMutation } from '../../api/api';
import { useT } from '../../i18n/useT';
import styles from './Settings.module.css';

/** The user's own additions to the summary prompt (SPEC.md §8). */
export function SummaryInstructions() {
  const t = useT();
  const { data } = useGetSummarySettingsQuery();
  const [save, { isLoading, isSuccess, reset }] = useSaveSummarySettingsMutation();
  // null until edited: the saved text shows as it is.
  const [draft, setDraft] = useState<string | null>(null);

  if (!data) return null;
  const text = draft ?? data.instructions;
  const changed = text.trim() !== data.instructions;
  return (
    <div className={styles.form}>
      <label className={styles.field}>
        {t('settings.summaryInstructions')}
        <Input.TextArea
          value={text}
          onChange={(event) => {
            setDraft(event.target.value);
            reset();
          }}
          rows={4}
          maxLength={SUMMARY_INSTRUCTIONS_MAX_LENGTH}
          placeholder={t('settings.summaryInstructionsExample')}
        />
      </label>
      <div className={styles.buttons}>
        <Button
          loading={isLoading}
          disabled={!changed}
          onClick={() => void save({ instructions: text.trim() }).then(() => setDraft(null))}
        >
          {t('settings.save')}
        </Button>
        {isSuccess && !changed && (
          <span className={styles.muted}>{t('settings.summaryInstructionsSaved')}</span>
        )}
      </div>
    </div>
  );
}
