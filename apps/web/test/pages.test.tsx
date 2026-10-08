// @vitest-environment jsdom
import { API_PREFIX } from '@homescribe/shared';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryPage } from '../src/features/library/LibraryPage';
import { RecordingPage } from '../src/features/recording/RecordingPage';
import { job, RECORDING_ID, recording, transcript } from './fixtures';
import { mockApi, renderPage } from './render';

const recordingPath = `${API_PREFIX}/recordings/${RECORDING_ID}`;
const page = { path: `/recordings/${RECORDING_ID}`, pattern: '/recordings/:id' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LibraryPage', () => {
  it('shows the empty state when there are no recordings', async () => {
    mockApi([
      {
        path: `${API_PREFIX}/recordings`,
        body: { data: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } },
      },
    ]);
    renderPage(<LibraryPage />);
    expect(await screen.findByText('No recordings yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose files' })).toBeTruthy();
  });

  it('lists recordings with status as text, in Russian', async () => {
    mockApi([
      {
        path: `${API_PREFIX}/recordings`,
        body: {
          data: [recording()],
          pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
        },
      },
    ]);
    renderPage(<LibraryPage />, { prefs: { locale: 'ru', theme: 'dark' } });
    expect(await screen.findByText('Weekly planning')).toBeTruthy();
    expect(screen.getByText('Готово')).toBeTruthy();
    expect(screen.getByText('1 запись')).toBeTruthy();
  });
});

describe('RecordingPage', () => {
  it('renders the transcript with timestamps', async () => {
    mockApi([
      { path: recordingPath, body: recording() },
      { path: `${recordingPath}/transcript`, body: transcript() },
    ]);
    renderPage(<RecordingPage />, page);
    expect(await screen.findByText('Let us start.')).toBeTruthy();
    expect(screen.getByText('0:00')).toBeTruthy();
    expect(screen.getByText('1:02:05')).toBeTruthy();
  });

  it('explains a failed job and retries it', async () => {
    const failed = recording({
      durationSeconds: null,
      job: job({
        status: 'failed',
        error: { code: 'MEDIA_UNREADABLE', message: 'ffprobe exited with code 1' },
      }),
    });
    const fetchMock = mockApi([
      { path: recordingPath, body: failed },
      {
        path: `${recordingPath}/transcript`,
        status: 409,
        body: { error: { code: 'TRANSCRIPT_NOT_READY', message: 'not ready' } },
      },
      {
        method: 'POST',
        path: `${recordingPath}/jobs`,
        status: 202,
        body: job({ status: 'queued' }),
      },
    ]);
    renderPage(<RecordingPage />, page);

    expect(await screen.findByText('The file could not be read as audio or video.')).toBeTruthy();
    expect(screen.getByText('The transcript appears here when processing is done.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Process again' }));
    await waitFor(() => {
      const posted = fetchMock.mock.calls
        .map(([input]) => input as Request)
        .find((request) => request.method === 'POST');
      expect(posted?.url).toContain(`${recordingPath}/jobs`);
    });
  });

  it('says so when the recording does not exist', async () => {
    mockApi([]);
    renderPage(<RecordingPage />, page);
    expect(await screen.findByText('This recording does not exist or was deleted.')).toBeTruthy();
  });

  it('asks for a second tap before deleting', async () => {
    const fetchMock = mockApi([
      { path: recordingPath, body: recording() },
      { path: `${recordingPath}/transcript`, body: transcript() },
      { method: 'DELETE', path: recordingPath, status: 204 },
    ]);
    renderPage(<RecordingPage />, page);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(fetchMock.mock.calls.some(([r]) => (r as Request).method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Tap again to delete' }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([r]) => (r as Request).method === 'DELETE')).toBe(true),
    );
  });

  it('says where speech could not be recognized', async () => {
    mockApi([
      { path: recordingPath, body: recording() },
      {
        path: `${recordingPath}/transcript`,
        body: transcript({ gaps: [{ start: 91, end: 120 }] }),
      },
    ]);
    renderPage(<RecordingPage />, page);
    expect(await screen.findByText('Speech here could not be recognized: 1:31–2:00.')).toBeTruthy();
  });
});
