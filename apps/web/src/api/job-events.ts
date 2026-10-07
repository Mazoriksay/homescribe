import type { Job, Recording } from '@homescribe/shared';

/**
 * Applies a job event to a cached recording. Only the recording's latest job
 * is shown, so an event for an older job is ignored.
 */
export function withJob(recording: Recording, job: Job): Recording {
  if (job.recordingId !== recording.id) return recording;
  const isSameJob = job.id === recording.job.id;
  const isNewer = job.createdAt >= recording.job.createdAt;
  if (!isSameJob && !isNewer) return recording;
  return { ...recording, job };
}
