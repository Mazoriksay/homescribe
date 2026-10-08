// @vitest-environment jsdom
import { API_PREFIX, type AiSettingsPair } from '@homescribe/shared';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LibraryPage } from '../src/features/library/LibraryPage';
import { activeSegmentIndex } from '../src/features/recording/TranscriptView';
import { RecordingPage } from '../src/features/recording/RecordingPage';
import { SettingsPage } from '../src/features/settings/SettingsPage';
import { job, RECORDING_ID, recording, transcript } from './fixtures';
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

  it('frees video memory and says when it cannot', async () => {
    const loaded = {
      busy: false,
      stt: {
        state: 'ok',
        server: 'speaches',
        loaded: [{ model: 'Systran/faster-whisper-large-v3', vramBytes: null }],
      },
      llm: { state: 'unsupported', server: null, loaded: [] },
    };
    const fetchMock = mockApi([
      { path: `${API_PREFIX}/settings/ai`, body: settings },
      { path: `${API_PREFIX}/ai/memory`, body: loaded },
      {
        method: 'POST',
        path: `${API_PREFIX}/ai/unload`,
        body: { ...loaded, stt: { ...loaded.stt, loaded: [] }, failed: [] },
      },
    ]);
    renderPage(<SettingsPage />);
    const section = (await screen.findByRole('heading', { name: 'Video memory' })).closest(
      'section',
    )!;
    expect(within(section).getByText('Systran/faster-whisper-large-v3')).toBeTruthy();
    expect(within(section).getByText('this server cannot unload models on request')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Free video memory' }));
    expect(await within(section).findByText('Models are unloaded.')).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([r]) => (r as Request).url.endsWith('/api/v1/ai/unload')),
    ).toBe(true);
  });

  it('keeps the button off while a recording is being processed', async () => {
    mockApi([
      { path: `${API_PREFIX}/settings/ai`, body: settings },
      {
        path: `${API_PREFIX}/ai/memory`,
        body: {
          busy: true,
          stt: { state: 'ok', server: 'speaches', loaded: [{ model: 'w', vramBytes: null }] },
          llm: { state: 'ok', server: 'ollama', loaded: [{ model: 'q', vramBytes: 4.7e9 }] },
        },
      },
    ]);
    renderPage(<SettingsPage />);
    expect(await screen.findByText('q · 4.7 GB')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Free video memory' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen.getByText('A recording is being processed. Wait for it or cancel it first.'),
    ).toBeTruthy();
  });

  it('connects the extension with a one-time code and takes a cookies.txt', async () => {
    const fetchMock = mockApi([
      { path: `${API_PREFIX}/settings/ai`, body: settings },
      {
        path: `${API_PREFIX}/cookies`,
        body: {
          status: 'expired',
          source: 'extension',
          updatedAt: '2026-01-01T10:00:00.000Z',
          checkedAt: null,
          paired: true,
        },
      },
      {
        method: 'POST',
        path: `${API_PREFIX}/cookies/pairing`,
        body: {
          code: 'ABCD-EFGH',
          expiresAt: '2026-01-01T10:10:00.000Z',
          extensionId: 'fladogegofoeopddbkeonljdjgpbblgi',
        },
      },
      {
        method: 'PUT',
        path: `${API_PREFIX}/cookies/file`,
        status: 400,
        body: { error: { code: 'VALIDATION_ERROR', message: 'x' } },
      },
    ]);
    renderPage(<SettingsPage />);
    const section = (await screen.findByRole('heading', { name: 'YouTube' })).closest('section')!;
    expect(
      await within(section).findByText(
        'No longer valid. Update them in the extension or upload a new file.',
      ),
    ).toBeTruthy();

    // The settings probe the extension's icon; first it is missing, then installed.
    let installed = false;
    vi.stubGlobal(
      'Image',
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(url: string) {
          expect(url).toMatch(/^chrome-extension:\/\/fladogegofoeopddbkeonljdjgpbblgi\/icon\.png/);
          queueMicrotask(() => (installed ? this.onload?.() : this.onerror?.()));
        }
      },
    );
    fireEvent.click(within(section).getByRole('button', { name: 'Connect the extension' }));
    expect(
      await within(section).findByText(/The extension is not installed in this browser yet/),
    ).toBeTruthy();
    expect(within(section).queryByRole('link', { name: 'Connect this browser' })).toBeNull();
    installed = true;
    fireEvent.click(within(section).getByRole('button', { name: 'Check again' }));
    const link = await within(section).findByRole('link', { name: 'Connect this browser' });
    expect(link.getAttribute('href')).toMatch(
      /^chrome-extension:\/\/fladogegofoeopddbkeonljdjgpbblgi\/pair\.html#server=http%3A%2F%2F.+&code=ABCD-EFGH$/,
    );
    expect(
      within(section).getByRole('link', { name: 'Download the extension' }).getAttribute('href'),
    ).toBe('/api/v1/extension.zip');

    const input = section.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['nothing'], 'cookies.txt')] } });
    expect(
      await within(section).findByText(
        'No YouTube cookies in that file. Export them for youtube.com in Netscape format.',
      ),
    ).toBeTruthy();
    const put = fetchMock.mock.calls
      .map(([r]) => r as Request)
      .find((r) => r.method === 'PUT' && r.url.endsWith('/cookies/file'));
    expect(put?.headers.get('content-type')).toBe('text/plain');
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

  it('offers to connect YouTube when a link needs signing in', async () => {
    mockApi([
      {
        path: recordingPath,
        body: recording({
          sourceUrl: 'https://www.youtube.com/watch?v=x',
          job: job({
            status: 'failed',
            error: { code: 'DOWNLOAD_BLOCKED', message: 'Sign in to confirm' },
          }),
        }),
      },
      { path: `${recordingPath}/transcript`, status: 409, body: {} },
      { path: `${API_PREFIX}/settings/ai`, body: settings },
    ]);
    renderPage(<RecordingPage />, page);
    const link = await screen.findByRole('link', { name: 'Connect YouTube' });
    expect(link.getAttribute('href')).toBe('/settings#youtube');
    expect(screen.getByText('or download the video yourself and upload the file.')).toBeTruthy();
  });

  it('shows a cancelled job as cancelled, not failed', async () => {
    mockApi([
      {
        path: recordingPath,
        body: recording({
          job: job({ status: 'failed', error: { code: 'CANCELLED', message: 'Cancelled' } }),
        }),
      },
      { path: `${recordingPath}/transcript`, status: 409, body: {} },
      { path: `${API_PREFIX}/settings/ai`, body: settings },
    ]);
    const { container } = renderPage(<RecordingPage />, page);
    expect(await screen.findByText('Processing was cancelled.')).toBeTruthy();
    expect(container.querySelector('[data-status="cancelled"]')?.textContent).toBe('Cancelled');
  });

  it('does not offer a failed summary again once summaries are off', async () => {
    mockApi([
      {
        path: recordingPath,
        body: recording({
          job: job({
            status: 'failed',
            error: { code: 'LLM_UNAVAILABLE', message: 'Cannot reach http://ollama:11434' },
          }),
        }),
      },
      { path: `${recordingPath}/transcript`, body: transcript() },
      {
        path: `${API_PREFIX}/settings/ai`,
        body: { ...settings, llm: { ...settings.llm, mode: 'off' } },
      },
    ]);
    renderPage(<RecordingPage />, page);
    expect(await screen.findByText('Summaries are turned off in the settings.')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Summarize again' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
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

describe('LibraryPage link import', () => {
  it('sends the link and opens the new recording', async () => {
    const fetchMock = mockApi([
      {
        path: `${API_PREFIX}/recordings`,
        body: { data: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } },
      },
      {
        method: 'POST',
        path: `${API_PREFIX}/recordings/from-url`,
        status: 201,
        body: recording({ sourceUrl: 'https://www.youtube.com/watch?v=x' }),
      },
    ]);
    renderPage(<LibraryPage />);
    fireEvent.change(await screen.findByLabelText('Or paste a link to a video or audio'), {
      target: { value: ' https://www.youtube.com/watch?v=x ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Transcribe' }));
    await waitFor(async () => {
      const post = fetchMock.mock.calls.map(([r]) => r as Request).find((r) => r.method === 'POST');
      expect(await post?.clone().json()).toEqual({ url: 'https://www.youtube.com/watch?v=x' });
    });
  });

  it('explains a refused link', async () => {
    mockApi([
      {
        path: `${API_PREFIX}/recordings`,
        body: { data: [], pagination: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } },
      },
      {
        method: 'POST',
        path: `${API_PREFIX}/recordings/from-url`,
        status: 400,
        body: { error: { code: 'URL_NOT_ALLOWED', message: 'no' } },
      },
    ]);
    renderPage(<LibraryPage />, { prefs: { locale: 'ru', theme: 'auto' } });
    fireEvent.change(await screen.findByLabelText('Или вставьте ссылку на видео или аудио'), {
      target: { value: 'http://nas.lan/a.mp4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Расшифровать' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('локальную сеть');
  });
});
