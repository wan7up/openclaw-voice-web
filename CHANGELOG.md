# Changelog

## 0.2.15 - 2026-05-15

- Added default best-effort sslip.io HTTPS setup to the one-command installer.
- The installer now detects the public IP, generates an sslip.io domain, installs nginx/certbot, and prints the HTTPS URL when certificate setup succeeds.
- Added installer options to disable sslip.io or use a custom public domain.

## 0.2.14 - 2026-05-15

- Added full Chinese installation and operation instructions to README.

## 0.2.13 - 2026-05-15

- Published GitHub install defaults for `wan7up/openclaw-voice-web`.
- Updated one-line install documentation to use the public GitHub repository.

## 0.2.12 - 2026-05-15

- Added `scripts/bootstrap.sh` for one-line GitHub installs.
- Updated README with curl-to-bash GitHub install and update commands.

## 0.2.11 - 2026-05-15

- Reworked `scripts/install.sh` into a one-command server installer for machines that already have OpenClaw installed.
- The installer now installs OS dependencies, Node.js when needed, ffmpeg, Python venv, `faster-whisper`, env config, browser password file, and systemd service.
- Rewrote README deployment instructions for first-time install, updates, password changes, and service logs.

## 0.2.10 - 2026-05-15

- Fixed the app shell to the viewport and kept the composer visible at the bottom while messages scroll internally.
- Turned automatic reply playback on by default.
- Added a silent looping media-session keepalive after user interaction so supported car media controls keep routing `nexttrack` to voice input.

## 0.2.9 - 2026-05-15

- Added a Media Session `nexttrack` handler that toggles voice recording, so supported car/browser media next buttons can start or send voice input.

## 0.2.8 - 2026-05-15

- Set reply audio playback to 1.2x by default.
- Clean Markdown and punctuation noise before server-side TTS generation so symbols are not read aloud.

## 0.2.7 - 2026-05-15

- Changed voice input from push-to-talk to tap-to-record and tap-to-send.
- Removed the browser speech recognition fast path from the client recording flow.

## 0.2.6 - 2026-05-15

- Disabled browser-side speech recognition for push-to-talk.
- Made all recorded voice input upload to the server-side `faster-whisper` STT path, including mobile browsers.

## 0.2.5 - 2026-05-15

- Added local `faster-whisper` server-side speech recognition for browsers without Web Speech API support.
- Added `scripts/faster_whisper_transcribe.py` and `OPENCLAW_STT_PROVIDER=faster-whisper` configuration.
- Kept voice transcripts hidden in the UI while sending recognized text into the same OpenClaw session.

## 0.2.4 - 2026-05-15

- Added configurable server-side STT providers: OpenClaw CLI, OpenAI-compatible audio transcription, and OpenAI-compatible chat audio input.
- Made reply playback reuse one hidden audio element and wait for real playback before showing the pause state.
- Added a user-gesture audio unlock when enabling auto-read.
- Marked as the current stable browser playback version after automatic reply playback verification.

## 0.2.3 - 2026-05-15

- Hid the native audio controls from assistant replies while keeping HTML audio playback under the hood.
- Kept the simple play/pause button UI and show generation progress inside the button only.
- Set reply audio playback volume to maximum by default.
- Fixed auto-read so it waits until audio playback actually starts before marking a reply as spoken.

## 0.2.2 - 2026-05-15

- Restored eager reply-audio generation after assistant replies.
- Added server-side TTS prewarming from OpenClaw final reply events, reducing client-side trigger delay.
- Kept cached TTS de-duplication so frontend and server prewarm share the same generated MP3.

## 0.2.1 - 2026-05-15

- Changed reply audio to lazy generation unless auto-read is enabled, so text answers appear without waiting on TTS.
- Replaced the header refresh button with a visible-history clear action.
- Added a reset button that sends `/reset` to the current OpenClaw conversation.

## 0.2.0 - 2026-05-15

- Stabilized the first car-browser usable build.
- Added password-protected browser entry for OpenClaw voice and text Q&A.
- Fixed stable browser sessions and duplicate assistant-message handling.
- Added server-side TTS playback with generated MP3 files and native audio controls for car browsers.
- Added server-side audio upload diagnostics and OpenClaw STT handoff path.
- Added short-lived TTS caching and cache cleanup to avoid unbounded audio-file storage.

## 0.1.0 - 2026-05-14

- Initial React and Express sidecar implementation for OpenClaw browser Q&A.
