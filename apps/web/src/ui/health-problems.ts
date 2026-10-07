import type { HealthChecks } from '@homescribe/shared';
import type { MessageKey } from '../i18n/en';

/** Problems from the server's self-check, as message keys (SPEC.md §7.6). */
export function healthProblems(checks: HealthChecks | null | undefined): MessageKey[] {
  if (!checks) return [];
  const problems: MessageKey[] = [];
  if (checks.ffmpeg === 'missing') problems.push('health.ffmpeg.missing');
  if (checks.stt !== 'ok') problems.push(`health.stt.${checks.stt}`);
  if (checks.llm === 'unreachable' || checks.llm === 'model_missing') {
    problems.push(`health.llm.${checks.llm}`);
  }
  return problems;
}
