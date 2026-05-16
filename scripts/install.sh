#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/openclaw-voice-web}"
ENV_FILE="${ENV_FILE:-/etc/openclaw-voice-web.env}"
SERVICE_NAME="${SERVICE_NAME:-openclaw-voice-web}"
SERVICE_USER="${SERVICE_USER:-root}"
SERVICE_GROUP="${SERVICE_GROUP:-$SERVICE_USER}"
INSTALL_WHISPER="${INSTALL_WHISPER:-1}"
OPENCLAW_STT_MODEL="${OPENCLAW_STT_MODEL:-tiny}"
OPENCLAW_STT_PROVIDER="${OPENCLAW_STT_PROVIDER:-faster-whisper}"
OPENCLAW_ENABLE_SSLIP="${OPENCLAW_ENABLE_SSLIP:-1}"
OPENCLAW_PUBLIC_DOMAIN="${OPENCLAW_PUBLIC_DOMAIN:-}"

log() {
  printf '\033[1;34m[openclaw-voice-web]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[openclaw-voice-web]\033[0m %s\n' "$*" >&2
  exit 1
}

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "$@"
  fi
  fail "Please run as root, or install sudo first."
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$SOURCE_DIR/package.json" ] || [ ! -f "$SOURCE_DIR/src/server/index.ts" ]; then
  fail "Run this script from an extracted openclaw-voice-web project directory."
fi

if ! command -v openclaw >/dev/null 2>&1; then
  fail "OpenClaw CLI was not found. Install OpenClaw on this server first."
fi

apt_install() {
  if ! command -v apt-get >/dev/null 2>&1; then
    fail "This installer currently supports Debian/Ubuntu systems with apt-get."
  fi

  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y "$@"
}

node_is_supported() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [maj,min]=process.versions.node.split(".").map(Number); process.exit(maj > 20 || (maj === 20 && min >= 19) ? 0 : 1)'
}

install_node_if_needed() {
  if node_is_supported && command -v npm >/dev/null 2>&1; then
    return
  fi

  log "Installing Node.js 24.x"
  apt_install ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs

  node_is_supported || fail "Node.js >= 20.19 is required."
  command -v npm >/dev/null 2>&1 || fail "npm is required."
}

ensure_service_user() {
  if [ "$SERVICE_USER" = "root" ]; then
    return
  fi

  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
}

set_env_default() {
  local key="$1"
  local value="$2"

  if grep -qE "^${key}=" "$ENV_FILE"; then
    local current
    current="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-)"
    if [ -n "$current" ]; then
      return
    fi
    sed -i "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    return
  fi

  printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
}

read_env_value() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

resolve_app_path() {
  local value="$1"
  if [ -z "$value" ]; then
    return
  fi
  if [[ "$value" = /* ]]; then
    printf '%s\n' "$value"
  else
    printf '%s/%s\n' "$APP_DIR" "$value"
  fi
}

detect_public_ip() {
  local ip
  ip="$(curl -fsSL --max-time 8 https://api.ipify.org 2>/dev/null || true)"
  if printf '%s' "$ip" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
    printf '%s\n' "$ip"
    return
  fi

  ip="$(curl -fsSL --max-time 8 https://ifconfig.me/ip 2>/dev/null || true)"
  if printf '%s' "$ip" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
    printf '%s\n' "$ip"
  fi
}

domain_from_sslip() {
  local ip="$1"
  printf '%s.sslip.io\n' "${ip//./-}"
}

write_nginx_site() {
  local domain="$1"
  local port="$2"
  local site_path="/etc/nginx/sites-available/${SERVICE_NAME}.conf"
  cat >"$site_path" <<EOF
server {
  listen 80;
  listen [::]:80;
  server_name ${domain};

  client_max_body_size 25m;

  location / {
    proxy_pass http://127.0.0.1:${port};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
  }
}
EOF
  ln -sf "$site_path" "/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"
}

setup_sslip_https() {
  local port="$1"
  local domain="$OPENCLAW_PUBLIC_DOMAIN"
  local public_ip=""

  if [ "$OPENCLAW_ENABLE_SSLIP" != "1" ] && [ -z "$domain" ]; then
    return
  fi

  if [ -z "$domain" ]; then
    public_ip="$(detect_public_ip)"
    if [ -z "$public_ip" ]; then
      log "Could not detect public IP; skipping sslip.io HTTPS setup."
      return
    fi
    domain="$(domain_from_sslip "$public_ip")"
  fi

  log "Configuring HTTPS for https://${domain}"
  apt_install nginx certbot python3-certbot-nginx
  write_nginx_site "$domain" "$port"

  if ! nginx -t; then
    log "nginx config test failed; skipping HTTPS setup."
    return
  fi
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl reload nginx 2>/dev/null || systemctl restart nginx

  if certbot --nginx -d "$domain" --non-interactive --agree-tos --register-unsafely-without-email --redirect; then
    HTTPS_URL="https://${domain}/"
    log "HTTPS enabled: ${HTTPS_URL}"
  else
    log "Certificate request failed. Check that ports 80/443 are open and ${domain} resolves to this server."
    HTTP_PROXY_URL="http://${domain}/"
  fi
}

log "Installing OS dependencies"
apt_install ca-certificates curl ffmpeg openssl python3 python3-venv rsync
install_node_if_needed
ensure_service_user

log "Copying application to $APP_DIR"
mkdir -p "$APP_DIR"
if [ "$SOURCE_DIR" != "$APP_DIR" ]; then
  rsync -a --delete \
    --exclude node_modules \
    --exclude dist \
    --exclude .git \
    --exclude .env \
    --exclude .env.local \
    --exclude .venv-whisper \
    --exclude voice-web-cache \
    --exclude .voice-web-cache \
    "$SOURCE_DIR/" "$APP_DIR/"
fi

log "Installing Node dependencies and building"
cd "$APP_DIR"
npm ci
npm run build

if [ "$INSTALL_WHISPER" = "1" ]; then
  log "Installing faster-whisper into $APP_DIR/.venv-whisper"
  if [ ! -x "$APP_DIR/.venv-whisper/bin/python" ]; then
    python3 -m venv "$APP_DIR/.venv-whisper"
  fi
  "$APP_DIR/.venv-whisper/bin/python" -m pip install --upgrade pip
  "$APP_DIR/.venv-whisper/bin/python" -m pip install --upgrade faster-whisper
fi

log "Writing configuration"
if [ ! -f "$ENV_FILE" ]; then
  cp "$APP_DIR/.env.example" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
fi

set_env_default HOST "0.0.0.0"
set_env_default PORT "8787"
set_env_default OPENCLAW_GATEWAY_WS_URL "ws://127.0.0.1:18789"
set_env_default OPENCLAW_CLI "$(command -v openclaw)"
set_env_default OPENCLAW_VOICE_COMMAND_TIMEOUT_MS "120000"
set_env_default OPENCLAW_TTS_SPEED "1.35"
set_env_default OPENCLAW_STT_PROVIDER "$OPENCLAW_STT_PROVIDER"
set_env_default OPENCLAW_STT_MODEL "$OPENCLAW_STT_MODEL"
set_env_default OPENCLAW_STT_LANGUAGE "zh-CN"
set_env_default OPENCLAW_STT_WHISPER_PYTHON ".venv-whisper/bin/python"
set_env_default OPENCLAW_STT_WHISPER_SCRIPT "scripts/faster_whisper_transcribe.py"
set_env_default OPENCLAW_STT_WHISPER_DEVICE "cpu"
set_env_default OPENCLAW_STT_WHISPER_COMPUTE_TYPE "int8"
set_env_default OPENCLAW_STT_WHISPER_BEAM_SIZE "1"
set_env_default OPENCLAW_ACCESS_PASSWORD_FILE "voice-web.password"

access_password_file="$(resolve_app_path "$(read_env_value OPENCLAW_ACCESS_PASSWORD_FILE)")"
generated_password=""
if [ -n "$access_password_file" ] && [ ! -f "$access_password_file" ]; then
  generated_password="$(openssl rand -base64 18 2>/dev/null || date +%s%N)"
  umask 077
  printf '%s\n' "$generated_password" >"$access_password_file"
  umask 022
fi

if [ "$SERVICE_USER" != "root" ]; then
  chown -R "$SERVICE_USER:$SERVICE_GROUP" "$APP_DIR"
fi

node_path="$(command -v node)"
cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=OpenClaw Voice Web
After=network-online.target openclaw-gateway.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${node_path} ${APP_DIR}/dist/server/index.js
Restart=always
RestartSec=3
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

log "Starting systemd service"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service"
systemctl restart "${SERVICE_NAME}.service"
systemctl is-active --quiet "${SERVICE_NAME}.service"

port="$(read_env_value PORT)"
host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
HTTPS_URL=""
HTTP_PROXY_URL=""

setup_sslip_https "${port:-8787}"

log "Installed successfully."
printf 'Service: %s.service\n' "$SERVICE_NAME"
printf 'App dir: %s\n' "$APP_DIR"
printf 'Config: %s\n' "$ENV_FILE"
if [ -n "$HTTPS_URL" ]; then
  printf 'URL: %s\n' "$HTTPS_URL"
elif [ -n "$HTTP_PROXY_URL" ]; then
  printf 'URL: %s\n' "$HTTP_PROXY_URL"
fi
if [ -n "$host_ip" ]; then
  printf 'URL: http://%s:%s/\n' "$host_ip" "${port:-8787}"
else
  printf 'URL: http://SERVER_IP:%s/\n' "${port:-8787}"
fi
if [ -n "$generated_password" ]; then
  printf 'Generated browser password: %s\n' "$generated_password"
  printf 'Password file: %s\n' "$access_password_file"
fi
