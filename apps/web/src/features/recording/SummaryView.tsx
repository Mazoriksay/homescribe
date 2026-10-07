import type { Recording } from '@homescribe/shared';
import Markdown from 'react-markdown';
import { useCreateJobMutation, useGetAiSettingsQuery, useGetSummaryQuery } from '../../api/api';
import { useT } from '../../i18n/useT';
import styles from './SummaryView.module.css';

export function SummaryView({ recording }: { recording: Recording }) {
  const t = useT();
  const { job } = recording;
  // The server answers 409 SUMMARY_NOT_READY until one exists; SSE refetches on 'done'.
  const { data: summary } = useGetSummaryQuery(recording.id);
  const { data: settings } = useGetAiSettingsQuery();
  const [createJob, { isLoading }] = useCreateJobMutation();
  const llmOff = settings?.llm.mode === 'off';
  const canRegenerate =
    !llmOff &&
    (job.status === 'done' || job.status === 'failed') &&
    (Boolean(summary) || job.status === 'done');

  return (
    <section className={styles.section} aria-labelledby="summary-heading">
      <div className={styles.head}>
        <h2 id="summary-heading" className={styles.heading}>
          {t('recording.summary')}
        </h2>
        {canRegenerate && (
          <button
            type="button"
            className="link-action"
            disabled={isLoading}
            onClick={() => void createJob({ recordingId: recording.id, kind: 'summarize' })}
          >
            {t('recording.regenerate')}
          </button>
        )}
      </div>

      {!summary && (
        <p className={styles.placeholder}>
          {llmOff ? t('recording.summaryOff') : t('recording.summaryPending')}
        </p>
      )}

      {summary && (
        <>
          {/* Model output: Markdown without raw HTML, links get safe URLs by default. */}
          <div className={styles.markdown}>
            <Markdown skipHtml>{summary.summary}</Markdown>
          </div>
          <h3 className={styles.subheading}>{t('recording.actionItems')}</h3>
          {summary.actionItems.length === 0 ? (
            <p className={styles.placeholder}>{t('recording.noActionItems')}</p>
          ) : (
            <ul className={styles.items}>
              {summary.actionItems.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          )}
          <p className={styles.model}>{t('recording.summaryModel', { model: summary.model })}</p>
        </>
      )}
    </section>
  );
}
