# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The git tag is the
source of truth for the version.

## [Unreleased]

### Added

- Upload audio or video files from the web UI; they are converted with ffmpeg
  and transcribed by any OpenAI-compatible speech-to-text server.
- Library of recordings with live job progress, and a recording page with a
  timestamped transcript and retry for failed jobs.
- HTTP API under `/api/v1` with a single error shape and Server-Sent Events
  for job progress.
- Access limited to the networks in `ALLOWED_NETWORKS`.
- English and Russian UI, light, dark and automatic themes.
- The UI can be embedded in another app's iframe: allow the embedding origin
  with `FRAME_ANCESTORS` and pass `?lang=` / `?theme=` in the iframe URL.
