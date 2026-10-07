import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import {
  API_PREFIX,
  type CreateJobBody,
  type Job,
  type Recording,
  type RecordingPage,
  type Transcript,
} from '@homescribe/shared';

export const api = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({ baseUrl: API_PREFIX }),
  tagTypes: ['Recording', 'RecordingList', 'Transcript'],
  endpoints: (build) => ({
    listRecordings: build.query<RecordingPage, { page: number; pageSize: number }>({
      query: ({ page, pageSize }) => ({ url: '/recordings', params: { page, pageSize } }),
      providesTags: (result) => [
        'RecordingList',
        ...(result?.data.map((r) => ({ type: 'Recording' as const, id: r.id })) ?? []),
      ],
    }),
    getRecording: build.query<Recording, string>({
      query: (id) => `/recordings/${id}`,
      providesTags: (_result, _error, id) => [{ type: 'Recording', id }],
    }),
    getTranscript: build.query<Transcript, string>({
      query: (id) => `/recordings/${id}/transcript`,
      providesTags: (_result, _error, id) => [{ type: 'Transcript', id }],
    }),
    deleteRecording: build.mutation<void, string>({
      query: (id) => ({ url: `/recordings/${id}`, method: 'DELETE' }),
      invalidatesTags: (_result, _error, id) => ['RecordingList', { type: 'Recording', id }],
    }),
    createJob: build.mutation<Job, { recordingId: string } & CreateJobBody>({
      query: ({ recordingId, kind }) => ({
        url: `/recordings/${recordingId}/jobs`,
        method: 'POST',
        body: { kind },
      }),
      invalidatesTags: (_result, _error, { recordingId }) => [
        { type: 'Recording', id: recordingId },
      ],
    }),
  }),
});

export const {
  useListRecordingsQuery,
  useGetRecordingQuery,
  useGetTranscriptQuery,
  useDeleteRecordingMutation,
  useCreateJobMutation,
} = api;

/** Error code from an RTK Query error, using the API's single error shape. */
export function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'status' in error) {
    const { status, data } = error as { status: unknown; data?: unknown };
    if (status === 'FETCH_ERROR') return 'NETWORK';
    const code = (data as { error?: { code?: unknown } } | undefined)?.error?.code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}
