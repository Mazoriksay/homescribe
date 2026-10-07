// @vitest-environment jsdom
import { API_PREFIX, type AiSettingsPair } from '@homescribe/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryPage } from '../src/features/library/LibraryPage';
import { activeSegmentIndex } from '../src/features/recording/TranscriptView';
import { RecordingPage } from '../src/features/recording/RecordingPage';
import { SettingsPage } from '../src/features/settings/SettingsPage';
import { RECORDING_ID, recording, transcript } from './fixtures';
import { mockApi, renderPage } from './render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settings: AiSettingsPair = {
  stt: {
    kind: 'stt',
    mode: 'local',
    provider: null,
    baseUrl: 'http://localhost:8000',
    model: 'Systran/faster-whisper-large-v3',
    hasApiKey: false,
    source: 'env',
  },
  llm: {
    kind: 'llm',
    mode: 'local',
    provider: null,
    baseUrl: 'http://localhost:11434',
    model: 'llama3.1:8b',
    hasApiKey: false,
    source: 'env',
  },
};

const putBodies = async (fetchMock: ReturnType<typeof mockApi>) =>
  Promise.all(
    fetchMock.mock.calls
      .map(([input]) => input as Request)
      .filter((request) => request.method === 'PUT')
      .map((request) => request.clone().json()),
  );

describe('SettingsPage', () => {
  it('finds local AI servers and saves the picked model', async () => {
    const fetchMock = mockApi([
      { path: `${API_PREFIX}/settings/ai`, body: settings },
      {
        path: `${API_PREFIX}/ai/discovery`,
        body: {
          probed: ['http://localhost:11434', 'http://localhost:1234'],
          servers: [
            {
              baseUrl: 'http://localhost:1234',
              product: 'LM Studio',
              models: [
                { id: 'qwen2.5-7b-instruct', kind: 'llm' },
                { id: 'text-embedding-nomic', kind: null },
              ],
            },
          ],
        },
      },
      { method: 'PUT', path: `${API_PREFIX}/settings/ai/llm`, body: settings.llm },
    ]);
    renderPage(<SettingsPage />);

    const summaries = (await screen.findByRole('heading', { name: 'Summaries' })).closest(
      'section',
    )!;
    fireEvent.click(
      await within(summaries).findByRole('button', { name: 'Find AI on this computer' }),
    );
    expect(await within(summaries).findByText('LM Studio')).toBeTruthy();
    expect(within(summaries).queryByText('text-embedding-nomic')).toBeNull();

    fireEvent.click(within(summaries).getByRole('button', { name: 'Use' }));
    fireEvent.click(within(summaries).getByRole('button', { name: 'Save' }));

    await waitFor(async () =>
      expect(await putBodies(fetchMock)).toEqual([
        {
          mode: 'local',
          provider: null,
          baseUrl: 'http://localhost:1234',
          model: 'qwen2.5-7b-instruct',
          apiKey: null,
        },
      ]),
    );
    expect(await within(summaries).findByText('Saved. New jobs use this choice.')).toBeTruthy();
  });

  it('says where it looked when nothing is running', async () => {
    mockApi([
      { path: `${API_PREFIX}/settings/ai`, body: settings },
      {
        path: `${API_PREFIX}/ai/discovery`,
        body: { probed: ['http://localhost:11434'], servers: [] },
      },
    ]);
    renderPage(<SettingsPage />, { prefs: { locale: 'ru', theme: 'auto' } });
    const stt = (await screen.findByRole('heading', { name: 'Распознавание речи' })).closest(
      'section',
    )!;
    fireEvent.click(
      await within(stt).findByRole('button', { name: 'Найти ИИ на этом компьютере' }),
    );
    expect(
      await within(stt).findByText('ИИ-серверы не найдены. Проверено: http://localhost:11434'),
    ).toBeTruthy();
  });

  it('switches to a cloud preset and sends the key once', async () => {
    const fetchMock = mockApi([
      { path: `${API_PREFIX}/settings/ai`, body: settings },
      { method: 'PUT', path: `${API_PREFIX}/settings/ai/stt`, body: settings.stt },
    ]);
    renderPage(<SettingsPage />);
    const stt = (await screen.findByRole('heading', { name: 'Speech recognition' })).closest(
      'section',
    )!;
    fireEvent.click(await within(stt).findByText('Cloud API'));
    fireEvent.change(within(stt).getByLabelText(/API key/), { target: { value: 'sk-test' } });
    expect(within(stt).getByRole('link', { name: 'Get a key' }).getAttribute('href')).toBe(
      'https://platform.openai.com/api-keys',
    );
    fireEvent.click(within(stt).getByRole('button', { name: 'Save' }));

    await waitFor(async () =>
      expect(await putBodies(fetchMock)).toEqual([
        {
          mode: 'api',
          provider: 'openai',
          baseUrl: 'https://api.openai.com',
          model: 'whisper-1',
          apiKey: 'sk-test',
        },
      ]),
    );
  });

  it('offers no "off" switch for speech recognition', async () => {
    mockApi([{ path: `${API_PREFIX}/settings/ai`, body: settings }]);
    renderPage(<SettingsPage />);
    const stt = (await screen.findByRole('heading', { name: 'Speech recognition' })).closest(
      'section',
    )!;
    const llm = screen.getByRole('heading', { name: 'Summaries' }).closest('section')!;
    expect(await within(llm).findByText('Off')).toBeTruthy();
    expect(within(stt).queryByText('Off')).toBeNull();
  });
});

describe('RecordingPage, stage 2', () => {
  const recordingPath = `${API_PREFIX}/recordings/${RECORDING_ID}`;
  const page = { path: `/recordings/${RECORDING_ID}`, pattern: '/recordings/:id' };

  it('renders the summary as Markdown without raw HTML, and action items', async () => {
    mockApi([
      { path: recordingPath, body: recording() },
      { path: `${recordingPath}/transcript`, body: transcript() },
      {
        path: `${recordingPath}/summary`,
        body: {
          recordingId: RECORDING_ID,
          summary: 'We **agreed** on the plan.\n\n<img src=x onerror=alert(1)>',
          actionItems: ['Ann: send the notes'],
          model: 'llama3.1:8b',
          createdAt: '2026-01-01T10:05:00.000Z',
        },
      },
      { path: `${API_PREFIX}/settings/ai`, body: settings },
    ]);
    const { container } = renderPage(<RecordingPage />, page);
    expect(await screen.findByText('agreed')).toBeTruthy();
    expect(screen.getByText('agreed').tagName).toBe('STRONG');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('Ann: send the notes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Summarize again' })).toBeTruthy();
  });

  it('seeks the player when a timestamp is tapped', async () => {
    mockApi([
      { path: recordingPath, body: recording() },
      { path: `${recordingPath}/transcript`, body: transcript() },
      { path: `${API_PREFIX}/settings/ai`, body: settings },
    ]);
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    renderPage(<RecordingPage />, page);
    fireEvent.click(await screen.findByRole('button', { name: 'Play from 1:02:05' }));
    const audio = document.querySelector('audio')!;
    expect(audio.getAttribute('src')).toBe(`${recordingPath}/media`);
    expect(audio.currentTime).toBe(3725);
    expect(play).toHaveBeenCalled();
  });

  it('renames the recording', async () => {
    const fetchMock = mockApi([
      { path: recordingPath, body: recording() },
      { method: 'PATCH', path: recordingPath, body: recording({ title: 'Retro' }) },
      { path: `${API_PREFIX}/settings/ai`, body: settings },
    ]);
    renderPage(<RecordingPage />, page);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Retro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls
        .map(([r]) => r as Request)
        .find((r) => r.method === 'PATCH');
      expect(patch).toBeTruthy();
    });
  });
});

describe('LibraryPage search', () => {
  it('shows highlighted matches that link to the moment in the recording', async () => {
    mockApi([
      {
        path: `${API_PREFIX}/search`,
        body: {
          data: [
            {
              recording: recording(),
              snippet: [
                { text: 'The ', match: false },
                { text: 'budget', match: true },
                { text: ' is approved.', match: false },
              ],
              segment: { index: 1, start: 65 },
            },
          ],
          pagination: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
        },
      },
    ]);
    renderPage(<LibraryPage />, { path: '/?q=budget' });
    const mark = await screen.findByText('budget');
    expect(mark.tagName).toBe('MARK');
    expect(screen.getByText('at 1:05')).toBeTruthy();
    expect(mark.closest('a')?.getAttribute('href')).toBe(`/recordings/${RECORDING_ID}?t=65`);
  });
});

describe('activeSegmentIndex', () => {
  const segments = [0, 5, 10].map((start, index) => ({ index, start, end: start + 5, text: '' }));
  it('finds the segment that is playing', () => {
    expect(activeSegmentIndex(segments, 0)).toBe(0);
    expect(activeSegmentIndex(segments, 7)).toBe(1);
    expect(activeSegmentIndex(segments, 99)).toBe(2);
    expect(activeSegmentIndex([], 3)).toBe(-1);
  });
});
