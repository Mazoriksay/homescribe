# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The git tag is the
source of truth for the version.

## [Unreleased]

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
