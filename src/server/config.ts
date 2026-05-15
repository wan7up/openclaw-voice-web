import "dotenv/config";

export type AppConfig = {
  host: string;
  port: number;
  gatewayWsUrl: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  deviceIdentityPath: string;
  sessionPrefix: string;
  audioMaxBytes: number;
  requestTimeoutMs: number;
  chatTimeoutMs: number;
  historyLimit: number;
  accessPasswordFile: string;
  authCookieName: string;
  openclawCli: string;
  voiceTempDir: string;
  voiceCommandTimeoutMs: number;
  ttsCacheTtlMs: number;
  sttLanguage: string;
  sttProvider: "openclaw" | "openai-audio" | "openai-chat-audio" | "faster-whisper";
  sttApiBaseUrl?: string;
  sttApiKey?: string;
  sttModel?: string;
  sttPrompt: string;
  sttWhisperPython: string;
  sttWhisperScript: string;
  sttWhisperDevice: string;
  sttWhisperComputeType: string;
  sttWhisperBeamSize: number;
  ttsVoice?: string;
  ttsModel?: string;
};

function readNumber(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a number >= ${min}`);
  }
  return value;
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim().length > 0 ? raw.trim() : fallback;
}

function readOptionalString(name: string): string | undefined {
  const raw = process.env[name];
  const value = raw?.trim();
  return value ? value : undefined;
}

export function loadConfig(): AppConfig {
  const audioMaxMb = readNumber("OPENCLAW_AUDIO_MAX_MB", 20, 1);
  const sttProvider = readSttProvider();

  return {
    host: readString("HOST", "0.0.0.0"),
    port: readNumber("PORT", 8787, 1),
    gatewayWsUrl: readString("OPENCLAW_GATEWAY_WS_URL", "ws://127.0.0.1:18789"),
    gatewayToken: readOptionalString("OPENCLAW_GATEWAY_TOKEN"),
    gatewayPassword: readOptionalString("OPENCLAW_GATEWAY_PASSWORD"),
    deviceIdentityPath: readString("OPENCLAW_DEVICE_IDENTITY_PATH", ".openclaw-device.json"),
    sessionPrefix: readString("OPENCLAW_SESSION_PREFIX", "voice-web"),
    audioMaxBytes: Math.floor(audioMaxMb * 1024 * 1024),
    requestTimeoutMs: readNumber("OPENCLAW_REQUEST_TIMEOUT_MS", 15_000, 1),
    chatTimeoutMs: readNumber("OPENCLAW_CHAT_TIMEOUT_MS", 0, 0),
    historyLimit: readNumber("OPENCLAW_HISTORY_LIMIT", 80, 1),
    accessPasswordFile: readString("OPENCLAW_ACCESS_PASSWORD_FILE", "voice-web.password"),
    authCookieName: readString("OPENCLAW_AUTH_COOKIE_NAME", "openclaw_voice_auth"),
    openclawCli: readString("OPENCLAW_CLI", "openclaw"),
    voiceTempDir: readString("OPENCLAW_VOICE_TMP_DIR", "voice-web-cache"),
    voiceCommandTimeoutMs: readNumber("OPENCLAW_VOICE_COMMAND_TIMEOUT_MS", 120_000, 1_000),
    ttsCacheTtlMs: readNumber("OPENCLAW_TTS_CACHE_TTL_SECONDS", 30 * 60, 60) * 1000,
    sttLanguage: readString("OPENCLAW_STT_LANGUAGE", "zh-CN"),
    sttProvider,
    sttApiBaseUrl: readOptionalString("OPENCLAW_STT_API_BASE_URL"),
    sttApiKey: readOptionalString("OPENCLAW_STT_API_KEY"),
    sttModel: readOptionalString("OPENCLAW_STT_MODEL"),
    sttPrompt: readString("OPENCLAW_STT_PROMPT", "Transcribe this audio. Return only the transcript."),
    sttWhisperPython: readString("OPENCLAW_STT_WHISPER_PYTHON", ".venv-whisper/bin/python"),
    sttWhisperScript: readString("OPENCLAW_STT_WHISPER_SCRIPT", "scripts/faster_whisper_transcribe.py"),
    sttWhisperDevice: readString("OPENCLAW_STT_WHISPER_DEVICE", "cpu"),
    sttWhisperComputeType: readString("OPENCLAW_STT_WHISPER_COMPUTE_TYPE", "int8"),
    sttWhisperBeamSize: readNumber("OPENCLAW_STT_WHISPER_BEAM_SIZE", 1, 1),
    ttsVoice: readOptionalString("OPENCLAW_TTS_VOICE"),
    ttsModel: readOptionalString("OPENCLAW_TTS_MODEL")
  };
}

function readSttProvider(): AppConfig["sttProvider"] {
  const raw = readString("OPENCLAW_STT_PROVIDER", "openclaw");
  if (raw === "openclaw" || raw === "openai-audio" || raw === "openai-chat-audio" || raw === "faster-whisper") {
    return raw;
  }
  throw new Error("OPENCLAW_STT_PROVIDER must be openclaw, openai-audio, openai-chat-audio, or faster-whisper");
}
