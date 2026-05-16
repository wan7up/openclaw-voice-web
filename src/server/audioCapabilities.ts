import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export type AudioDiagnostic = {
  path: string;
  mimeType: string;
  bytes: number;
  durationSeconds?: number;
  codec?: string;
  sampleRate?: number;
  channels?: number;
  meanVolumeDb?: number;
  maxVolumeDb?: number;
  decodedSamples?: number;
  probeError?: string;
  volumeError?: string;
};

export class VoiceCapabilityError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
    readonly code = "VOICE_CAPABILITY_ERROR"
  ) {
    super(message);
    this.name = "VoiceCapabilityError";
  }
}

export async function ensureVoiceDir(config: AppConfig, segment?: string): Promise<string> {
  const dir = path.resolve(process.cwd(), config.voiceTempDir, segment ?? "");
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeTempAudioFile(params: {
  config: AppConfig;
  buffer: Buffer;
  mimeType: string;
}): Promise<string> {
  const dir = await ensureVoiceDir(params.config, "inbound");
  const filePath = path.join(dir, `voice-${Date.now()}-${crypto.randomUUID()}.${extensionForMime(params.mimeType)}`);
  await writeFile(filePath, params.buffer);
  return filePath;
}

export async function analyzeAudio(filePath: string, mimeType: string): Promise<AudioDiagnostic> {
  const fileStat = await stat(filePath);
  const diagnostic: AudioDiagnostic = {
    path: filePath,
    mimeType,
    bytes: fileStat.size
  };

  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size,bit_rate",
      "-show_streams",
      "-of",
      "json",
      filePath
    ]);
    const payload = JSON.parse(String(stdout)) as unknown;
    const stream = firstAudioStream(payload);
    if (stream) {
      diagnostic.codec = readString(stream.codec_name);
      diagnostic.sampleRate = readNumber(stream.sample_rate);
      diagnostic.channels = readNumber(stream.channels);
    }
    const format = readRecord(readRecord(payload)?.format);
    diagnostic.durationSeconds = readNumber(format?.duration);
  } catch (error) {
    diagnostic.probeError = error instanceof Error ? error.message : String(error);
  }

  try {
    const { stderr } = await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-nostats",
      "-i",
      filePath,
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-"
    ]);
    const volume = parseVolumeDetect(stderr);
    diagnostic.durationSeconds = diagnostic.durationSeconds ?? volume.durationSeconds;
    diagnostic.meanVolumeDb = volume.meanVolumeDb;
    diagnostic.maxVolumeDb = volume.maxVolumeDb;
    diagnostic.decodedSamples = volume.decodedSamples;
  } catch (error) {
    diagnostic.volumeError = error instanceof Error ? error.message : String(error);
  }

  return diagnostic;
}

export function validateAudioDiagnostic(diagnostic: AudioDiagnostic): void {
  if (diagnostic.bytes < 1024) {
    throw new VoiceCapabilityError("录音文件太小，没有收到有效语音", 422, "AUDIO_TOO_SMALL");
  }
  if (diagnostic.decodedSamples === 0) {
    throw new VoiceCapabilityError("录音无法解码，没有录到有效语音", 422, "AUDIO_EMPTY");
  }
  if (diagnostic.durationSeconds !== undefined && diagnostic.durationSeconds < 0.35) {
    throw new VoiceCapabilityError("录音时间太短，请按住说完整问题后再松开", 422, "AUDIO_TOO_SHORT");
  }
  if (diagnostic.maxVolumeDb !== undefined && diagnostic.maxVolumeDb <= -55) {
    throw new VoiceCapabilityError("录音声音太小或接近静音，请靠近麦克风再试", 422, "AUDIO_TOO_QUIET");
  }
}

export async function transcribeWithOpenClaw(config: AppConfig, filePath: string): Promise<string> {
  await assertAudioProviderConfigured(config);
  const payload = await runJsonCommand(config.openclawCli, [
    "capability",
    "audio",
    "transcribe",
    "--file",
    filePath,
    "--json",
    "--language",
    config.sttLanguage
  ], config.voiceCommandTimeoutMs);
  const transcript = extractTranscript(payload);
  if (!transcript) {
    throw new VoiceCapabilityError("服务器没有识别到语音内容", 422, "NO_TRANSCRIPT");
  }
  return transcript;
}

export async function transcribeWithConfiguredProvider(params: {
  config: AppConfig;
  filePath: string;
  mimeType: string;
}): Promise<string> {
  if (params.config.sttProvider === "openclaw") {
    return transcribeWithOpenClaw(params.config, params.filePath);
  }
  if (params.config.sttProvider === "faster-whisper") {
    return transcribeWithFasterWhisper(params.config, params.filePath);
  }

  const externalConfig = params.config;
  assertExternalSttConfigured(externalConfig);
  if (params.config.sttProvider === "openai-audio") {
    return transcribeWithOpenAiAudio({ ...params, config: externalConfig });
  }
  return transcribeWithOpenAiChatAudio({ ...params, config: externalConfig });
}

async function transcribeWithFasterWhisper(config: AppConfig, filePath: string): Promise<string> {
  const scriptPath = path.resolve(process.cwd(), config.sttWhisperScript);
  const pythonPath = path.resolve(process.cwd(), config.sttWhisperPython);
  const payload = await runJsonCommand(
    pythonPath,
    [
      scriptPath,
      "--file",
      filePath,
      "--model",
      config.sttModel ?? "tiny",
      "--language",
      config.sttLanguage,
      "--device",
      config.sttWhisperDevice,
      "--compute-type",
      config.sttWhisperComputeType,
      "--beam-size",
      String(config.sttWhisperBeamSize)
    ],
    config.voiceCommandTimeoutMs,
    {
      PYTHONIOENCODING: "utf-8"
    }
  );
  return requireTranscript(extractTranscript(payload), "Local Whisper did not return a transcript");
}

export async function synthesizeWithOpenClaw(params: {
  config: AppConfig;
  text: string;
  outputPath: string;
}): Promise<unknown> {
  const args = ["capability", "tts", "convert", "--text", params.text, "--output", params.outputPath, "--json"];
  if (params.config.ttsVoice) {
    args.push("--voice", params.config.ttsVoice);
  }
  if (params.config.ttsModel) {
    args.push("--model", params.config.ttsModel);
  }
  return runJsonCommand(params.config.openclawCli, args, params.config.voiceCommandTimeoutMs);
}

export async function applyTtsSpeed(config: AppConfig, filePath: string): Promise<void> {
  const speed = config.ttsSpeed;
  if (Math.abs(speed - 1) < 0.01) return;

  const outputPath = path.join(path.dirname(filePath), `speed-${Date.now()}-${crypto.randomUUID()}.mp3`);
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        filePath,
        "-filter:a",
        buildAtempoFilter(speed),
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "48k",
        outputPath
      ],
      {
        timeout: config.voiceCommandTimeoutMs,
        maxBuffer: 2 * 1024 * 1024
      }
    );
    await rename(outputPath, filePath);
  } catch (error) {
    await safeUnlink(outputPath);
    throw error;
  }
}

export async function safeUnlink(filePath: string): Promise<void> {
  await unlink(filePath).catch(() => undefined);
}

export function extensionForMime(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

export function mimeForAudioPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".m4a" || extension === ".mp4") return "audio/mp4";
  if (extension === ".ogg") return "audio/ogg";
  return "audio/mpeg";
}

async function assertAudioProviderConfigured(config: AppConfig): Promise<void> {
  const payload = await runJsonCommand(
    config.openclawCli,
    ["capability", "audio", "providers", "--json"],
    config.voiceCommandTimeoutMs
  ).catch((error) => {
    throw new VoiceCapabilityError(
      `无法检查服务器语音识别配置：${error instanceof Error ? error.message : String(error)}`,
      503,
      "STT_PROVIDER_CHECK_FAILED"
    );
  });

  const providers = Array.isArray(payload) ? payload : [];
  const configured = providers.some((provider) => Boolean(readRecord(provider)?.configured));
  if (!configured) {
    throw new VoiceCapabilityError("服务器语音识别未配置，请先在 OpenClaw 配置 audio provider", 503, "STT_NOT_CONFIGURED");
  }
}

function assertExternalSttConfigured(config: AppConfig): asserts config is AppConfig & {
  sttApiBaseUrl: string;
  sttApiKey: string;
} {
  if (!config.sttApiBaseUrl || !config.sttApiKey) {
    throw new VoiceCapabilityError("服务器语音识别未配置，请设置外部 STT API 地址和密钥", 503, "STT_NOT_CONFIGURED");
  }
}

async function transcribeWithOpenAiAudio(params: {
  config: AppConfig & { sttApiBaseUrl: string; sttApiKey: string };
  filePath: string;
  mimeType: string;
}): Promise<string> {
  const form = new FormData();
  const bytes = await readFile(params.filePath);
  const blob = new Blob([bytes], { type: params.mimeType });
  form.append("file", blob, path.basename(params.filePath));
  form.append("model", params.config.sttModel ?? "whisper-1");
  form.append("language", normalizeLanguage(params.config.sttLanguage));

  const payload = await fetchJson(
    `${normalizeBaseUrl(params.config.sttApiBaseUrl)}/audio/transcriptions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.config.sttApiKey}`
      },
      body: form
    },
    params.config.voiceCommandTimeoutMs
  );
  return requireTranscript(extractTranscript(payload), "外部语音识别接口没有返回有效转写文本");
}

async function transcribeWithOpenAiChatAudio(params: {
  config: AppConfig & { sttApiBaseUrl: string; sttApiKey: string };
  filePath: string;
  mimeType: string;
}): Promise<string> {
  const input = await prepareChatAudioInput(params.config, params.filePath, params.mimeType);
  try {
    const audioBytes = await readFile(input.filePath);
    const payload = await fetchJson(
      `${normalizeBaseUrl(params.config.sttApiBaseUrl)}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.config.sttApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: params.config.sttModel ?? "gpt-4o-mini-transcribe",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: params.config.sttPrompt },
                {
                  type: "input_audio",
                  input_audio: {
                    data: audioBytes.toString("base64"),
                    format: input.format
                  }
                }
              ]
            }
          ]
        })
      },
      params.config.voiceCommandTimeoutMs
    );
    return requireTranscript(extractChatCompletionText(payload), "外部 Chat 识别接口没有返回有效转写文本");
  } finally {
    if (input.temporary) {
      void safeUnlink(input.filePath);
    }
  }
}

async function prepareChatAudioInput(
  config: AppConfig,
  filePath: string,
  mimeType: string
): Promise<{ filePath: string; format: "mp3" | "wav"; temporary: boolean }> {
  if (mimeType.includes("mpeg") || path.extname(filePath).toLowerCase() === ".mp3") {
    return { filePath, format: "mp3", temporary: false };
  }
  if (mimeType.includes("wav") || path.extname(filePath).toLowerCase() === ".wav") {
    return { filePath, format: "wav", temporary: false };
  }

  const dir = await ensureVoiceDir(config, "stt");
  const outputPath = path.join(dir, `stt-${Date.now()}-${crypto.randomUUID()}.mp3`);
  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      filePath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "48k",
      outputPath
    ], {
      timeout: config.voiceCommandTimeoutMs,
      maxBuffer: 2 * 1024 * 1024
    });
  } catch (error) {
    throw new VoiceCapabilityError(`音频转码失败：${readExecError(error)}`, 422, "AUDIO_TRANSCODE_FAILED");
  }
  return { filePath: outputPath, format: "mp3", temporary: true };
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs).unref();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const payload = text ? parseJson(text) : null;
    if (!response.ok) {
      const message = extractErrorMessage(payload) || text || `HTTP ${response.status}`;
      throw new VoiceCapabilityError(message, response.status >= 500 ? 502 : response.status, "EXTERNAL_STT_FAILED");
    }
    return payload;
  } catch (error) {
    if (error instanceof VoiceCapabilityError) throw error;
    throw new VoiceCapabilityError(
      error instanceof Error ? error.message : String(error),
      502,
      "EXTERNAL_STT_FAILED"
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractChatCompletionText(payload: unknown): string {
  const choices = readRecord(payload)?.choices;
  if (!Array.isArray(choices)) return extractTranscript(payload);
  return choices
    .map((choice) => {
      const message = readRecord(readRecord(choice)?.message);
      const content = message?.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .map((part) => {
          const record = readRecord(part);
          return typeof part === "string" ? part : typeof record?.text === "string" ? record.text : "";
        })
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function requireTranscript(transcript: string, message: string): string {
  const text = transcript.trim();
  if (!text || /^no audio provided\.?$/i.test(text) || /no audio (was )?provided/i.test(text)) {
    throw new VoiceCapabilityError(message, 422, "NO_TRANSCRIPT");
  }
  return text;
}

function extractErrorMessage(payload: unknown): string {
  const record = readRecord(payload);
  const error = record?.error;
  if (typeof error === "string") return error;
  const errorRecord = readRecord(error);
  if (typeof errorRecord?.message === "string") return errorRecord.message;
  if (typeof record?.message === "string") return record.message;
  return "";
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeLanguage(value: string): string {
  return value.split("-")[0] || value;
}

function buildAtempoFilter(speed: number): string {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    filters.push("atempo=2");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`);
  return filters.join(",");
}

async function runJsonCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv
): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env
    });
    return JSON.parse(String(stdout));
  } catch (error) {
    const details = readExecError(error);
    throw new VoiceCapabilityError(details, 502, "OPENCLAW_CLI_FAILED");
  }
}

function readExecError(error: unknown): string {
  const record = readRecord(error);
  const stderr = typeof record?.stderr === "string" ? record.stderr.trim() : "";
  const stdout = typeof record?.stdout === "string" ? record.stdout.trim() : "";
  const message = error instanceof Error ? error.message : String(error);
  return stderr || stdout || message;
}

function parseVolumeDetect(stderr: string): {
  durationSeconds?: number;
  meanVolumeDb?: number;
  maxVolumeDb?: number;
  decodedSamples?: number;
} {
  const times = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].map((match) => {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    return hours * 3600 + minutes * 60 + seconds;
  });
  const samples = [...stderr.matchAll(/n_samples:\s*(\d+)/g)].map((match) => Number(match[1]));
  const meanVolumes = [...stderr.matchAll(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/g)].map((match) => Number(match[1]));
  const maxVolumes = [...stderr.matchAll(/max_volume:\s*(-?\d+(?:\.\d+)?) dB/g)].map((match) => Number(match[1]));

  return {
    durationSeconds: times.at(-1),
    decodedSamples: samples.at(-1),
    meanVolumeDb: meanVolumes.at(-1),
    maxVolumeDb: maxVolumes.at(-1)
  };
}

function firstAudioStream(payload: unknown): Record<string, unknown> | undefined {
  const streams = readRecord(payload)?.streams;
  if (!Array.isArray(streams)) return undefined;
  return streams.map(readRecord).find((stream) => stream?.codec_type === "audio");
}

function extractTranscript(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  const record = readRecord(payload);
  if (!record) return "";

  for (const key of ["text", "transcript", "content", "result"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  for (const value of Object.values(record)) {
    const nested = extractTranscript(value);
    if (nested) return nested;
  }

  return "";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
