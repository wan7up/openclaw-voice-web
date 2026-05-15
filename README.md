# OpenClaw Voice Web

OpenClaw Voice Web is a browser voice and text Q&A entrypoint that runs next to an existing OpenClaw server.

It is designed for mobile and car browsers:

- Ask with text or recorded voice.
- Transcribe voice on the server with `faster-whisper`.
- Send the hidden transcript into the same OpenClaw session.
- Show OpenClaw's text reply in the browser.
- Play replies with server-generated audio.
- Keep voice transcripts hidden in the UI; users only see "语音已发送".

## Requirements

- OpenClaw is already installed and configured on the server.
- OpenClaw Gateway is reachable from the same machine, usually at `ws://127.0.0.1:18789`.
- Debian/Ubuntu server. The installer handles Node.js, ffmpeg, Python venv, and `faster-whisper`.
- HTTPS or a trusted intranet origin is recommended because browsers often require a secure context for microphone access.

## One-Line Install

Run this on the OpenClaw server:

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh | sudo bash
```

Install from a fork:

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh \
  | sudo OPENCLAW_VOICE_WEB_REPO=wan7up/openclaw-voice-web bash
```

Install a specific branch or tag:

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh \
  | sudo OPENCLAW_VOICE_WEB_REPO=wan7up/openclaw-voice-web OPENCLAW_VOICE_WEB_REF=v0.2.13 bash
```

The bootstrap script downloads the GitHub tarball and runs `scripts/install.sh`.

## Local Directory Install

If you already have the project directory on the server:

```bash
sudo bash scripts/install.sh
```

The installer will:

- Check that the OpenClaw CLI exists.
- Install OS dependencies.
- Install Node.js 24.x if the current Node version is too old.
- Copy the project to `/opt/openclaw-voice-web`.
- Install npm dependencies and build the app.
- Create `.venv-whisper` and install `faster-whisper`.
- Generate `/etc/openclaw-voice-web.env`.
- Generate a browser access password file.
- Install and start the systemd service.

The terminal prints the URL and generated browser password after installation.

## Installer Options

Environment variables can override defaults:

```bash
APP_DIR=/opt/openclaw-voice-web \
ENV_FILE=/etc/openclaw-voice-web.env \
OPENCLAW_STT_MODEL=tiny \
sudo -E bash scripts/install.sh
```

Common options:

- `APP_DIR`: install directory, default `/opt/openclaw-voice-web`.
- `ENV_FILE`: env file, default `/etc/openclaw-voice-web.env`.
- `SERVICE_NAME`: systemd service name, default `openclaw-voice-web`.
- `SERVICE_USER`: service user, default `root`. If OpenClaw runs under another user, set this to that user.
- `OPENCLAW_STT_MODEL`: Whisper model, default `tiny`. Try `base` for better accuracy.
- `INSTALL_WHISPER=0`: skip installing `faster-whisper`.

## Configuration

Main config file:

```bash
/etc/openclaw-voice-web.env
```

Important defaults:

```env
PORT=8787
HOST=0.0.0.0
OPENCLAW_GATEWAY_WS_URL=ws://127.0.0.1:18789
OPENCLAW_STT_PROVIDER=faster-whisper
OPENCLAW_STT_MODEL=tiny
OPENCLAW_STT_LANGUAGE=zh-CN
OPENCLAW_ACCESS_PASSWORD_FILE=voice-web.password
```

Restart after editing config:

```bash
sudo systemctl restart openclaw-voice-web.service
```

View logs:

```bash
sudo journalctl -u openclaw-voice-web.service -f
```

## Browser Password

Default password file:

```bash
/opt/openclaw-voice-web/voice-web.password
```

The first non-comment line is the browser access password. To change it:

```bash
sudo nano /opt/openclaw-voice-web/voice-web.password
sudo systemctl restart openclaw-voice-web.service
```

## Reverse Proxy

Nginx example:

```bash
deploy/nginx.example.conf
```

Use HTTPS for public access whenever possible.

## Update

For GitHub installs, run the same bootstrap command again:

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh | sudo bash
```

For local directory installs, run:

```bash
sudo bash scripts/install.sh
```

Existing `/etc/openclaw-voice-web.env` and the password file are preserved.

## Development

```bash
npm install
npm run dev
```

Production build:

```bash
npm ci
npm run build
npm run start
```
