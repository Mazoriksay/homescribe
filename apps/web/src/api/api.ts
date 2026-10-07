import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { apiBase } from '../app/base';
import {
  type AiKind,
  type AiSettings,
  type AiSettingsPair,
  type CreateFromUrlBody,
  type CreateJobBody,
  type Discovery,
  type Health,
  type Job,
  type ListModelsBody,
  type ModelList,
  type Recording,
  type RecordingPage,
  type SearchPage,
  type Summary,
  type Transcript,
  type UpdateAiSettingsBody,
} from '@homescribe/shared';

export const api = createApi({
  reducerPath: 'api',
  // Absolute URL: works the same in the browser, inside an embedding page and in tests.
  baseQuery: fetchBaseQuery({ baseUrl: new URL(apiBase, window.location.origin).href }),
  tagTypes: [
    'Recording',
    'RecordingList',
    'Transcript',
    'Summary',
    'Search',
    'AiSettings',
    'Health',
  ],
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
    getHealth: build.query<Health, void>({
      query: () => '/health',
      providesTags: ['Health'],
    }),
    getSummary: build.query<Summary, string>({
      query: (id) => `/recordings/${id}/summary`,
      providesTags: (_result, _error, id) => [{ type: 'Summary', id }],
    }),
    renameRecording: build.mutation<Recording, { id: string; title: string }>({
      query: ({ id, title }) => ({ url: `/recordings/${id}`, method: 'PATCH', body: { title } }),
      invalidatesTags: (_result, _error, { id }) => [
        'RecordingList',
        'Search',
        { type: 'Recording', id },
      ],
    }),
    search: build.query<SearchPage, { q: string; page: number }>({
      query: ({ q, page }) => ({ url: '/search', params: { q, page, pageSize: 20 } }),
      providesTags: ['Search'],
    }),
    getAiSettings: build.query<AiSettingsPair, void>({
      query: () => '/settings/ai',
      providesTags: ['AiSettings'],
    }),
    updateAiSettings: build.mutation<AiSettings, { kind: AiKind } & UpdateAiSettingsBody>({
      query: ({ kind, ...body }) => ({ url: `/settings/ai/${kind}`, method: 'PUT', body }),
      invalidatesTags: ['AiSettings', 'Health'],
    }),
    resetAiSettings: build.mutation<AiSettings, AiKind>({
      query: (kind) => ({ url: `/settings/ai/${kind}`, method: 'DELETE' }),
      invalidatesTags: ['AiSettings', 'Health'],
    }),
    discoverAi: build.query<Discovery, void>({
      query: () => '/ai/discovery',
      keepUnusedDataFor: 300,
    }),
    listModels: build.mutation<ModelList, ListModelsBody>({
      query: (body) => ({ url: '/ai/models', method: 'POST', body }),
    }),
    createFromUrl: build.mutation<Recording, CreateFromUrlBody>({
      query: (body) => ({ url: '/recordings/from-url', method: 'POST', body }),
      invalidatesTags: ['RecordingList'],
    }),
    deleteRecording: build.mutation<void, string>({
      query: (id) => ({ url: `/recordings/${id}`, method: 'DELETE' }),
      invalidatesTags: (_result, _error, id) => [
        'RecordingList',
        'Search',
        { type: 'Recording', id },
      ],
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
  useGetHealthQuery,
  useGetSummaryQuery,
  useRenameRecordingMutation,
  useSearchQuery,
  useGetAiSettingsQuery,
  useUpdateAiSettingsMutation,
  useResetAiSettingsMutation,
  useLazyDiscoverAiQuery,
  useListModelsMutation,
  useCreateFromUrlMutation,
  useDeleteRecordingMutation,
  useCreateJobMutation,
} = api;

/** Human-readable message the server sent with an error, if any. */
export function errorText(error: unknown): string | null {
  const message = (error as { data?: { error?: { message?: unknown } } } | undefined)?.data?.error
    ?.message;
  return typeof message === 'string' ? message : null;
}

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
