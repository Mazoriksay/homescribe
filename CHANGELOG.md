# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The git tag is the
source of truth for the version.

## [Unreleased]

### Added

- Transcription shows an estimated progress bar instead of an endless one,
  based on how fast the same model was on earlier recordings (from the
  second recording on).
- Links from sites that ask to sign in (YouTube's "confirm you're not a
  bot") end with a clear `DOWNLOAD_BLOCKED` error, and browser cookies in
  `cookies.txt` in the data folder (`YTDLP_COOKIES_FILE`) are passed to
  yt-dlp.
- Processing can be cancelled: a "Cancel" button (tap twice) on the recording
  page and `POST /api/v1/jobs/:id/cancel`. The job ends as `CANCELLED` and can
  be retried.
- `STT_VAD_FILTER` (on by default): a local speaches server is asked to skip
  silence, which stops Whisper from repeating one phrase on long recordings.
- The installer asks what to download before pulling anything: speech
  recognition on the GPU, the CPU or not on this computer, the Whisper model
  (`large-v3`, `large-v3-turbo`, `medium`, `small`) and the local summary
  model (`qwen2.5:7b`, `llama3.1:8b`, `qwen2.5:3b` or none), with sizes and a
  summary to confirm. New options `--stt-model`/`--llm-model`
  (`-SttModel`/`-LlmModel` on Windows). Each option shows how much video
  memory (or RAM) it uses, and the summary adds up both models and warns when
  that is more than the GPU has.
- The installer recognises models that are already downloaded (and
  unfinished downloads it can continue), shows download progress for the
  speech and summary models, removes image versions an update replaced, and
  offers to delete models that are no longer used.

### Changed

- speaches images are pinned (`0.8.1-cuda`, `0.8.3-cpu`; override with
  `SPEACHES_CUDA_IMAGE`/`SPEACHES_CPU_IMAGE`) instead of following `latest`,
  and log at `info` instead of `debug`. Health checks are no longer written
  to Homescribe's request log.

### Fixed

- "Find AI on this computer" finds Ollama running on the Docker host. Each
  host is looked up once, IPv4 first, so an unresolvable name such as a
  stopped `ollama` service no longer makes the other probes time out.
- Search treats «ё» and «е» as the same letter (the index is rebuilt once
  on start).
- An empty upload is refused with `400` instead of becoming a failed job.
- A malformed link is reported once instead of twice.
- Error details from ffprobe or yt-dlp are folded under «Details», without
  memory addresses.
- Settings controls are at least 44 px tall on phones.
- The transcript language is shown by name («русский» instead of `ru`), the
  recording title is in the browser tab, and copying the transcript puts
  each segment on its own line.
- Links from search results use a rounded start time, and the summary is no
  longer requested while summaries are off.
- Long recordings no longer lose their second half to Whisper repeating one
  phrase. Recordings over 75 s are transcribed in chunks of about a minute,
  cut in pauses, so a loop cannot run to the end; a chunk that loops is asked
  again at a higher temperature; whatever still loops is cut to one copy and
  shown on the recording page as a stretch where speech was not recognized.
  Segments past the end of the recording are dropped or trimmed. Progress
  during transcription now counts finished chunks.
- The speech model is now actually downloaded: the installer asks the speech
  server for it (`POST /v1/models/{id}`) instead of relying on
  `PRELOAD_MODELS`, which the image ignored, so it no longer waits forever.
- The installer waits until the speech model has finished downloading.
  speaches lists a model as soon as its first files arrive, so the installer
  used to report "done" while the download was still running.
- GPU speech recognition uses speaches' `0.8.1-cuda` image (what
  `latest-cuda` points to) instead of the older CUDA 12.6 build, for newer
  GPUs such as the RTX 50 series.
- The Windows installer no longer stops right after installing Docker
  Desktop; it starts Docker Desktop and waits for it.

## [0.3.0] - 2026-10-07

### Added

- Summaries and action items from a local or cloud LLM, created after every
  transcription and regenerated on demand; long transcripts are summarized in
  parts.
- Settings page to choose the speech-to-text and summary backends: find AI
  servers running on this computer (Ollama, LM Studio, speaches, vLLM,
  llama.cpp, LocalAI, Jan) and pick a model, or use a cloud API (OpenAI, Groq,
  OpenRouter or any OpenAI-compatible address) with an API key. Summaries can
  be turned off.
- Full-text search over titles, transcripts and summaries with highlighted
  matches that open the recording at the right moment.
- Audio and video player on the recording page; the transcript follows
  playback and tapping a timestamp seeks.
- Rename recordings.
- One-command installer for Linux, macOS (`install.sh`) and Windows
  (`install.ps1`): installs Docker and the NVIDIA Container Toolkit if you
  agree, picks GPU or CPU, optionally sets up Ollama, finds a free port, and
  waits until everything works. Re-running it updates.
- Ready-made multi-arch Docker image published to GitHub Container Registry,
  and CI on every pull request.
- Transcribe a link: paste a YouTube (or other video site) link or a direct
  media link; the audio is downloaded with yt-dlp and processed like an
  upload. Links into the local network are refused by default.
- Docker image with ffmpeg and a Compose file that runs Homescribe with
  speech-to-text (GPU or CPU) and optionally Ollama, restarting with the
  machine.
- `BASE_PATH` to serve everything under a path such as `/homescribe`, so a
  home hub can show it from its own address behind one proxy.
- Self-check: missing ffmpeg or unreachable AI servers are logged, reported in
  `GET /api/v1/health` and shown as a notice in the UI.
- When embedded, the page tells the parent when it is ready and where it
  navigated (`postMessage`).
- README: Docker setup, putting Homescribe into a hub, and HTTPS through
  Tailscale or Let's Encrypt without a private certificate authority.

- Upload audio or video files from the web UI; they are converted with ffmpeg
  and transcribed by any OpenAI-compatible speech-to-text server.
- Library of recordings with live job progress, and a recording page with a
  timestamped transcript and retry for failed jobs.
- HTTP API under `/api/v1` with a single error shape and Server-Sent Events
  for job progress.
- Access limited to the networks in `ALLOWED_NETWORKS`.
- English and Russian UI, light, dark and automatic themes (in Settings).
- The UI can be embedded in another app's iframe: allow the embedding origin
  with `FRAME_ANCESTORS` and pass `?lang=` / `?theme=` in the iframe URL.

### Changed

- New look that matches Home Hub: warm gray with one rust accent, serif page
  titles, hairline-separated rows instead of cards, Auto / Day / Night theme
  set before the first paint, a side rail on desktop and a tab bar on phones.
  Inside another app's frame the app hides its own chrome. Explanatory hints
  were removed from the pages.

[Unreleased]: https://github.com/Mazoriksay/homescribe/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Mazoriksay/homescribe/releases/tag/v0.3.0
