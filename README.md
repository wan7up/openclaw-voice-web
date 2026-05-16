# OpenClaw Voice Web

本项目是基于想要在车上使用语音跟 agent 对话的需求，所以想到使用车机上的浏览器来实现，故做成了这个样子，有兴趣的朋友自己拿去改着玩。只要车机有浏览器功能就能用啦。需要注意的是：目前版本是随便搞到能用的样子，所以没怎么考虑安全问题的哦。

[中文说明](#中文说明) | [English](#english)

## 中文说明

OpenClaw Voice Web 是一个部署在 OpenClaw 服务器旁边的浏览器语音/文字问答入口。

适合手机浏览器、车机浏览器等场景：

- 可以输入文字提问，也可以录音提问。
- 录音上传到服务器后，由 `faster-whisper` 在服务器本地做语音识别。
- 识别出的文字不会显示给用户，只会作为隐藏文本发给 OpenClaw。
- OpenClaw 返回文字回答，页面正常显示。
- 回答可以手动播放，也可以自动播放。
- 自动播放默认开启，服务端会把回复音频处理为默认 1.35 倍速，避免车机/手机浏览器忽略播放速度设置。

### 前提条件

- 服务器已经安装并配置好 OpenClaw。
- OpenClaw Gateway 在本机可访问，默认地址是 `ws://127.0.0.1:18789`。
- 推荐 Debian/Ubuntu 系统。安装脚本会自动安装 Node.js、ffmpeg、Python venv 和 `faster-whisper`。
- 默认会尝试使用 `sslip.io` 自动配置 HTTPS。服务器需要开放 80/443 端口。

### 一句话安装

在已经安装好 OpenClaw 的服务器上执行：

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh | sudo bash
```

脚本会自动从 GitHub 下载项目，然后执行安装。

默认情况下，安装脚本还会尝试自动配置 HTTPS：

- 自动检测服务器公网 IP。
- 自动生成 `x-x-x-x.sslip.io` 域名。
- 安装 nginx 和 certbot。
- 申请 Let's Encrypt 证书。
- 安装完成时优先输出 `https://...sslip.io/` 访问地址。

如果服务器的 80/443 端口没有开放，HTTPS 申请可能失败；主程序仍会安装成功，并输出 HTTP 地址。

不想自动配置 sslip.io/HTTPS，可以这样安装：

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh \
  | sudo OPENCLAW_ENABLE_SSLIP=0 bash
```

如果你有自己的域名，可以这样安装：

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh \
  | sudo OPENCLAW_PUBLIC_DOMAIN=voice.example.com bash
```

### 安装过程会做什么

- 检查服务器是否已有 OpenClaw CLI。
- 安装系统依赖。
- 如果 Node.js 版本不够，会自动安装 Node.js 24.x。
- 将项目安装到 `/opt/openclaw-voice-web`。
- 安装 npm 依赖并构建前后端。
- 创建 `.venv-whisper`，并安装 `faster-whisper`。
- 生成 `/etc/openclaw-voice-web.env`。
- 生成浏览器访问密码文件。
- 写入并启动 systemd 服务。
- 默认尝试配置 sslip.io HTTPS 访问地址。

安装完成后，终端会输出访问地址和浏览器访问密码。

### 常用配置

主要配置文件：

```bash
/etc/openclaw-voice-web.env
```

常见配置：

```env
PORT=8787
HOST=0.0.0.0
OPENCLAW_GATEWAY_WS_URL=ws://127.0.0.1:18789
OPENCLAW_STT_PROVIDER=faster-whisper
OPENCLAW_STT_MODEL=tiny
OPENCLAW_STT_LANGUAGE=zh-CN
OPENCLAW_ACCESS_PASSWORD_FILE=voice-web.password
```

修改配置后重启：

```bash
sudo systemctl restart openclaw-voice-web.service
```

查看日志：

```bash
sudo journalctl -u openclaw-voice-web.service -f
```

### 访问密码

默认密码文件：

```bash
/opt/openclaw-voice-web/voice-web.password
```

文件第一行就是浏览器访问密码。修改密码：

```bash
sudo nano /opt/openclaw-voice-web/voice-web.password
sudo systemctl restart openclaw-voice-web.service
```

### Whisper 模型选择

默认使用：

```env
OPENCLAW_STT_MODEL=tiny
```

`tiny` 速度快，适合低配服务器先跑通。  
如果识别准确率不够，可以尝试：

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh \
  | sudo OPENCLAW_STT_MODEL=base bash
```

或安装后编辑 `/etc/openclaw-voice-web.env`，把 `OPENCLAW_STT_MODEL=tiny` 改成 `base`，再重启服务。

### 更新

重新执行同一条安装命令即可：

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh | sudo bash
```

已有的 `/etc/openclaw-voice-web.env` 和密码文件会保留。

### 反向代理

Nginx 示例：

```bash
deploy/nginx.example.conf
```

如果自动 sslip.io HTTPS 配置成功，通常不需要再手动配置反向代理。

### 本地目录安装

如果你已经把项目目录下载到了服务器，也可以在项目目录内执行：

```bash
sudo bash scripts/install.sh
```

## English

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
- The installer tries to configure HTTPS with `sslip.io` by default. Ports 80/443 must be open.

## One-Line Install

Run this on the OpenClaw server:

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh | sudo bash
```

By default, the installer also tries to configure HTTPS with `sslip.io`:

- Detects the server public IP.
- Generates an `x-x-x-x.sslip.io` domain.
- Installs nginx and certbot.
- Requests a Let's Encrypt certificate.
- Prints the HTTPS URL when setup succeeds.

If ports 80/443 are blocked, HTTPS setup may fail, but the app still installs and the HTTP URL is printed.

Disable automatic sslip.io HTTPS:

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh \
  | sudo OPENCLAW_ENABLE_SSLIP=0 bash
```

Use your own domain:

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh \
  | sudo OPENCLAW_PUBLIC_DOMAIN=voice.example.com bash
```

Install from a fork:

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh \
  | sudo OPENCLAW_VOICE_WEB_REPO=wan7up/openclaw-voice-web bash
```

Install a specific branch or tag:

```bash
curl -fsSL https://raw.githubusercontent.com/wan7up/openclaw-voice-web/main/scripts/bootstrap.sh \
  | sudo OPENCLAW_VOICE_WEB_REPO=wan7up/openclaw-voice-web OPENCLAW_VOICE_WEB_REF=v0.2.15 bash
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
- Try to configure an sslip.io HTTPS URL by default.

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
- `OPENCLAW_ENABLE_SSLIP=0`: disable automatic sslip.io HTTPS setup.
- `OPENCLAW_PUBLIC_DOMAIN=voice.example.com`: use your own domain for HTTPS.

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

If automatic sslip.io HTTPS succeeds, you usually do not need to configure a reverse proxy manually.

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
