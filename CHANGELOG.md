# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The git tag is the
source of truth for the version.

## [Unreleased]

### Changed

- Speech recognition on an NVIDIA GPU runs speaches in batched mode and
  sends it 10-minute parts instead of 1-minute ones: 10 minutes of audio in
  about 11 s on an RTX 5070 Ti. The installer and "Update Homescribe" turn it
  on for GPU installs (`STT_BATCHED=true`); other speech servers keep
  1-minute parts.
- "Update Homescribe" (`homescribe update`) also downloads the current
  `compose.yaml` and control script, so fixes in them (such as the faster
  speech recognition image) reach existing installs without running the
  installer again. A `compose.yaml` Docker cannot read is not used.
- Speech recognition on an NVIDIA GPU runs on speaches 0.8.3 (CUDA 12.9)
  instead of 0.8.1 (CUDA 12.6). On RTX 50 cards it is about three times
  faster (a 22-minute recording: 2.5 minutes instead of 7).
  With an NVIDIA driver older than CUDA 12.9 the installer picks the same
  speaches release built on CUDA 12.6 or 12.4, so it still starts.

## [0.3.2] - 2026-10-09

### Added

- Context window for summaries with Ollama (Settings → Summaries): "As in
  Ollama" or 4k–256k presets and a typed size, limited to 2048 … the model's
  own maximum. The size goes with each request through Ollama's own chat API
  (`num_ctx`), and the part size follows the window (about 4000 characters
  for 4096 tokens, 16 000 for 16k) unless `LLM_CHUNK_CHARS` is set. Without a
  chosen size the window Ollama reports for the loaded model is used. The
  video memory section says when part of the model runs on the CPU.
- "Check for updates" in Settings: compares this version with GitHub (only
  when pressed) and, when there is a newer one, says how many changes and
  to run "Update Homescribe". The image records its commit for that
  (`HOMESCRIBE_COMMIT`); `UPDATE_REPO` sets the repository or turns it off.
- Your own instructions for summaries (Settings → Summaries, up to 2000
  characters), added to every summary request: length, focus, style.
- YouTube sign-in without hand-made files: when a link fails with "Sign in to
  confirm you're not a bot", the recording page offers "Connect YouTube".
  Settings → YouTube pairs a browser extension (Chrome, Edge, Yandex Browser,
  Opera, Brave; Firefox as a temporary add-on) with a one-time code; it keeps
  the server's youtube.com cookies fresh. A `cookies.txt` can be uploaded
  instead. The server checks the cookies, shows whether they work, and
  retries links blocked in the last 24 hours once they do. Stale cookies give
  their own error, `DOWNLOAD_COOKIES_EXPIRED`; `/health` reports `cookies`.
  The setup steps show this browser's extensions page (`chrome://extensions`,
  `edge://extensions`, …) with a Copy button, since pages may not open it.
  The installer and `start`/`update` unpack the extension into
  `browser-extension` in the install folder, and the settings show that
  folder with Copy to paste into "Load unpacked" (`EXTENSION_FOLDER`), so
  there is no zip to unpack or folder to look for on that computer.
- "Free video memory" in the settings: shows which models the local speaches
  and Ollama hold and unloads them at once instead of after about 5 minutes
  (`GET /api/v1/ai/memory`, `POST /api/v1/ai/unload`). Servers without that
  API, such as LM Studio, are named as such.
- Start and stop without Docker commands: the installer leaves
  `Start Homescribe.cmd`, `Stop Homescribe.cmd`, `Homescribe status.cmd` and
  `Update Homescribe.cmd` (Windows, plus optional Start menu shortcuts) or
  `./homescribe start | stop | status | update` (Linux, macOS) in the install
  folder. Stopping frees all memory and keeps the data.
- The installer asks whether Homescribe starts with the computer
  (`--autostart`, `-Autostart`); the answer is kept in `HOMESCRIBE_RESTART`.

### Changed

- Settings are easier to read: each AI backend shows its model and where it
  runs, and opens its form only on "Change" (with "Cancel"); the context
  window is one list with "Custom…" and warns there when the model spills
  to the CPU; "Save" for your instructions appears only after an edit;
  YouTube keeps cookies.txt and the other ways folded, and asks before
  deleting cookies; mono type is left for model names only; Updates moved
  last. Muted text and placeholders have readable contrast, and the chosen
  segment stands out in the dark theme.
- New installs no longer start with the computer unless you say so.

### Fixed

- Detailed summaries of recordings longer than one part no longer fail with
  `LLM_CONTEXT_EXCEEDED` or take ages: notes on parts stay compact and only
  the final summary is written in detail, so each request fits a 4096-token
  window with reasoning; if the detailed final reply still does not fit, a
  brief one is asked for instead of failing.
- Summaries are detailed by default: a longer overview, key points with
  their specifics and a conclusion. "To do" (was "Action items") shows only
  when there is something to do, instead of "No action items" under every
  lecture or video.
- Long recordings no longer fail with "cut off even for 4037 characters"
  while merging part summaries: a merge the window cuts off is split.
- An Ollama with no models yet (it answers `data: null`) is no longer hidden
  from "Find AI on this computer" and no longer reported as unreachable; it
  is listed with how to download a model.
- The installer says why the summary model did not download instead of
  "run the installer again": a VPN or DNS filter that answers with private
  addresses (Ollama's "resolves to non-public"), an unknown model name or no
  connection; the final summary repeats that summaries will not work yet.
  When Settings keep a different summary server, the installer says so and
  how to switch ("Back to defaults").
- Summary errors say what to do. A model that keeps answering in the wrong
  format fails with `LLM_BAD_REPLY` and suggests regenerating or another
  model; an overloaded or rate-limited server (HTTP 429/503) is tried again
  twice, after `Retry-After` when given, then fails with `LLM_BUSY` and
  suggests trying later.
- Summaries of long recordings with a local model (Ollama's default window
  of 4096 tokens, a reasoning model such as `gemma4`) no longer fail with
  "The model did not return the requested JSON". Parts are 4000 characters
  instead of 12 000 (`LLM_CHUNK_CHARS`), so reasoning and the reply fit; a
  reply the window cut off (`finish_reason: "length"`) halves that part
  instead of asking again; part summaries are merged in rounds that each fit
  the window. When even small parts are cut off the job fails with
  `LLM_CONTEXT_EXCEEDED` and says what to change.
- Summaries no longer fail when the summary model only just fits the GPU
  ("llama-server process has terminated … CUDA error"). Whisper now leaves
  video memory 30 s after use (`STT_MODEL_TTL`, passed to speaches as
  `WHISPER__TTL`) instead of 5 minutes. With "Take turns on the GPU" (Settings
  → Video memory; the installer turns it on when the chosen models do not fit,
  `AI_TAKE_TURNS`), a job waits for Whisper to leave before the summary and
  unloads the Ollama model after it; cloud APIs are never touched. A model
  that fails to load is tried once more after that wait; if it fails again
  the job says so as `LLM_OUT_OF_MEMORY`, with the server's text under
  Details. The transcript is kept either way.
- Settings → Video memory no longer calls an idle Ollama "speaches".
- Chrome no longer lists "'background.scripts' requires manifest version of 2
  or lower" for the extension: the zip and the unpacked folder keep only
  what Chrome understands, and Firefox gets its own zip
  (`extension.zip?browser=firefox`).
- The settings say to paste the extension's folder into the "Folder" field
  of the "Load unpacked" dialog; pasted into its address bar, Chrome got the
  `_locales` folder inside and reported a missing manifest.
- The extension zip unpacks with Windows Explorer: its files carried no valid
  date, which only 7-Zip and similar tools accepted.
- "Free video memory" no longer breaks speech recognition: speaches 0.8.1
  stopped taking work after being asked to unload, so it is left to unload by
  itself after 5 idle minutes (shown as such); the button now unloads Ollama.
- "Connect this browser" appears only once the extension is installed in that
  browser; before, it led to Chrome's "blocked" page.
- Cookies from the extension are checked within a minute instead of staying
  "not checked yet" for up to 10 minutes; resending the same cookies keeps
  their status.
- Subtitle credits Whisper invents over silence ("Продолжение следует",
  "Субтитры создавал …", "Thanks for watching", …) are left out of transcripts.
- "Start Homescribe" says when speech recognition is still starting.

## [0.3.1] - 2026-10-08

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
  and log at `info` instead of `debug`, without their Gradio UI (which
  called gradio.app on start). Health checks are no longer written
  to Homescribe's request log.

### Fixed

- A cancelled job is shown as "Cancelled", not as an error; a recording whose
  summary failed before summaries were turned off is shown as ready; the
  summary section no longer flashes the wrong text while settings load.
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

[Unreleased]: https://github.com/Mazoriksay/homescribe/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/Mazoriksay/homescribe/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Mazoriksay/homescribe/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Mazoriksay/homescribe/releases/tag/v0.3.0
