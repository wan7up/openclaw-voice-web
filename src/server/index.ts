import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import {
  VoiceCapabilityError,
  analyzeAudio,
  ensureVoiceDir,
  mimeForAudioPath,
  safeUnlink,
  synthesizeWithOpenClaw,
  transcribeWithConfiguredProvider,
  validateAudioDiagnostic,
  writeTempAudioFile
} from "./audioCapabilities.js";
import { loadConfig } from "./config.js";
import { OpenClawGateway, unwrapUserMessageFromOpenClaw } from "./openclawGateway.js";
import { SseHub } from "./sseHub.js";
import type { ChatEvent, ClientMessage } from "./types.js";

const config = loadConfig();
const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.audioMaxBytes,
    files: 1
  }
});
const hub = new SseHub();
const gateway = new OpenClawGateway(config);
const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const ttsFiles = new Map<string, { filePath: string; mimeType: string; createdAt: number }>();
const pendingTtsFiles = new Map<string, Promise<TtsAudioResult>>();
const hiddenServerVoiceTexts = new Map<string, Set<string>>();
let lastTtsCleanupAt = 0;

type TtsAudioResult = {
  id: string;
  url: string;
  mimeType: string;
  cached: boolean;
};

app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

gateway.on("status", (payload) => {
  hub.broadcastAll("gateway", payload);
});

gateway.on("chat", (payload) => {
  if (payload.sessionKey) {
    const normalized = normalizeChatEvent(payload);
    broadcastSession(payload.sessionKey, "chat", normalized);
    if (normalized.state === "final" && normalized.text?.trim()) {
      void warmReplyAudio(payload.sessionKey, normalized).catch((error) => {
        console.warn(JSON.stringify({ event: "tts-warm-error", error: serializeError(error) }));
      });
    }
  }
});

gateway.on("rawEvent", ({ event, payload }) => {
  const sessionKey = extractSessionKey(payload);
  if (!sessionKey) return;

  if (event === "session.message") {
    broadcastSession(sessionKey, "message", normalizeMessageEvent(payload));
  } else if (event !== "chat") {
    broadcastSession(sessionKey, "gateway-event", { event, payload });
  }
});

app.get("/api/auth/status", (_request, response) => {
  const password = readAccessPassword();
  response.json({
    configured: Boolean(password),
    authenticated: Boolean(password && isAuthenticated(_request))
  });
});

app.post("/api/auth/login", (request, response) => {
  const password = readAccessPassword();
  if (!password) {
    response.status(503).json({ error: "Access password is not configured" });
    return;
  }

  const submitted = typeof request.body?.password === "string" ? request.body.password : "";
  if (!safeEqual(submitted, password)) {
    response.status(401).json({ error: "密码不正确" });
    return;
  }

  setAuthCookie(response, password);
  response.json({ ok: true });
});

app.post("/api/auth/logout", (_request, response) => {
  response.setHeader("Set-Cookie", buildExpiredAuthCookie());
  response.json({ ok: true });
});

app.use("/api", requireAuth);

app.get("/api/health", async (_request, response) => {
  try {
    await gateway.ensureConnected();
    let gatewayHealth: unknown = null;
    try {
      gatewayHealth = await gateway.health();
    } catch {
      gatewayHealth = null;
    }

    response.json({
      ok: true,
      gateway: gateway.getStatus(),
      gatewayHealth,
      audioMaxBytes: config.audioMaxBytes
    });
  } catch (error) {
    response.status(503).json({
      ok: false,
      gateway: gateway.getStatus(),
      error: serializeError(error)
    });
  }
});

app.get("/api/events", async (request, response) => {
  const sessionKey = readSessionKey(request.query.sessionKey);
  if (!sessionKey) {
    response.status(400).json({ error: "sessionKey is required" });
    return;
  }

  const remove = hub.add(sessionKey, response);
  try {
    await gateway.ensureConnected();
    hub.broadcast(sessionKey, "gateway", gateway.getStatus());
    void gateway.subscribeMessages(sessionKey).catch((error) => {
      broadcastSession(sessionKey, "error", {
        message: `无法订阅会话消息：${error instanceof Error ? error.message : String(error)}`
      });
    });
  } catch (error) {
    hub.broadcast(sessionKey, "error", {
      message: error instanceof Error ? error.message : String(error)
    });
  }

  request.on("close", remove);
});

app.get("/api/history", async (request, response) => {
  const sessionKey = readSessionKey(request.query.sessionKey);
  if (!sessionKey) {
    response.status(400).json({ error: "sessionKey is required" });
    return;
  }

  try {
    const payload = await gateway.history(sessionKey);
    response.json({
      messages: normalizeHistory(payload)
    });
  } catch (error) {
    response.status(502).json({ error: serializeError(error) });
  }
});

app.post("/api/chat/text", async (request, response) => {
  const sessionKey = readSessionKey(request.body?.sessionKey);
  const message = typeof request.body?.message === "string" ? request.body.message.trim() : "";

  if (!sessionKey || !message) {
    response.status(400).json({ error: "sessionKey and message are required" });
    return;
  }

  try {
    const result = await gateway.sendText({ sessionKey, message });
    response.json({ ok: true, result });
  } catch (error) {
    response.status(502).json({ error: serializeError(error) });
  }
});

app.post("/api/chat/audio", upload.single("audio"), async (request, response) => {
  const sessionKey = readSessionKey(request.body?.sessionKey);
  const file = request.file;

  if (!sessionKey || !file) {
    response.status(400).json({ error: "sessionKey and audio are required" });
    return;
  }

  const mimeType = normalizeAudioMime(file.mimetype);
  let filePath: string | undefined;
  try {
    filePath = await writeTempAudioFile({ config, buffer: file.buffer, mimeType });
    const diagnostic = await analyzeAudio(filePath, mimeType);
    console.info(
      JSON.stringify({
        event: "voice-upload",
        sessionKey,
        userAgent: request.headers["user-agent"] ?? "",
        originalMimeType: file.mimetype,
        mimeType,
        originalName: file.originalname,
        diagnostic
      })
    );

    validateAudioDiagnostic(diagnostic);
    const transcript = await transcribeWithConfiguredProvider({ config, filePath, mimeType });
    console.info(
      JSON.stringify({
        event: "voice-transcribed",
        sessionKey,
        provider: config.sttProvider,
        transcriptChars: transcript.length
      })
    );
    rememberServerVoiceText(sessionKey, transcript);
    const result = await gateway.sendText({ sessionKey, message: transcript });
    response.json({ ok: true, result, hiddenText: transcript });
  } catch (error) {
    const status = error instanceof VoiceCapabilityError ? error.statusCode : 502;
    console.warn(
      JSON.stringify({
        event: "voice-upload-error",
        sessionKey,
        userAgent: request.headers["user-agent"] ?? "",
        mimeType,
        error: serializeError(error)
      })
    );
    response.status(status).json({ error: serializeError(error) });
  } finally {
    if (filePath) {
      void safeUnlink(filePath);
    }
  }
});

app.post("/api/tts", async (request, response) => {
  const text = typeof request.body?.text === "string" ? request.body.text.trim() : "";
  if (!text) {
    response.status(400).json({ error: "text is required" });
    return;
  }
  if (text.length > 5_000) {
    response.status(400).json({ error: "回复太长，暂时无法生成语音" });
    return;
  }

  void cleanupExpiredTtsFilesThrottled();
  try {
    const result = await createOrGetTtsAudio(text);
    response.json({ ok: true, ...result });
  } catch (error) {
    console.warn(JSON.stringify({ event: "tts-error", error: serializeError(error) }));
    response.status(error instanceof VoiceCapabilityError ? error.statusCode : 502).json({ error: serializeError(error) });
  }
});

app.get("/api/tts/:id", (request, response) => {
  const id = request.params.id;
  const record = ttsFiles.get(id);
  if (!record || !existsSync(record.filePath)) {
    response.status(404).json({ error: "audio not found" });
    return;
  }

  response.type(record.mimeType);
  response.setHeader("Cache-Control", "private, max-age=1800");
  response.sendFile(record.filePath, { dotfiles: "allow" }, (error) => {
    if (!error) return;
    console.warn(JSON.stringify({ event: "tts-send-error", id, error: serializeError(error) }));
    if (!response.headersSent) {
      response.status(404).json({ error: "audio not found" });
    }
  });
});

app.post("/api/chat/abort", async (request, response) => {
  const sessionKey = readSessionKey(request.body?.sessionKey);
  const runId = typeof request.body?.runId === "string" ? request.body.runId : undefined;

  if (!sessionKey) {
    response.status(400).json({ error: "sessionKey is required" });
    return;
  }

  try {
    const result = await gateway.abort(sessionKey, runId);
    response.json({ ok: true, result });
  } catch (error) {
    response.status(502).json({ error: serializeError(error) });
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir = resolveClientDir(__dirname);
app.use(express.static(clientDir));
app.get(/.*/, (_request, response) => {
  const indexPath = path.join(clientDir, "index.html");
  if (!existsSync(indexPath)) {
    response.status(500).type("text/plain").send(`Client build not found: ${indexPath}`);
    return;
  }
  response.sendFile(indexPath);
});

app.listen(config.port, config.host, () => {
  console.log(`openclaw-voice-web listening on http://${config.host}:${config.port}`);
  void cleanupExpiredTtsFiles();
  void gateway.ensureConnected().catch((error) => {
    console.warn(`OpenClaw Gateway not connected yet: ${error instanceof Error ? error.message : String(error)}`);
  });
});

function readSessionKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 180) return undefined;
  return normalizeSessionKey(trimmed);
}

function normalizeSessionKey(sessionKey: string): string {
  if (sessionKey.startsWith("agent:main:")) return sessionKey;
  if (sessionKey.startsWith("voice-web:")) return `agent:main:${sessionKey}`;
  return `agent:main:voice-web:${sessionKey}`;
}

function normalizeAudioMime(mimeType: string | undefined): string {
  if (!mimeType) return "audio/webm";
  const [type] = mimeType.split(";");
  return type || "audio/webm";
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

function normalizeHistory(payload: unknown): ClientMessage[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(readRecord(payload)?.messages)
      ? (readRecord(payload)?.messages as unknown[])
      : Array.isArray(readRecord(payload)?.items)
        ? (readRecord(payload)?.items as unknown[])
        : [];

  return rows.map((row) => normalizeMessage(row)).filter(Boolean) as ClientMessage[];
}

function normalizeMessageEvent(payload: unknown): { message?: ClientMessage; raw: unknown } {
  const record = readRecord(payload);
  const rawMessage = record?.message ?? payload;
  const sessionKey = extractSessionKey(payload);
  return {
    message: normalizeMessage(rawMessage, sessionKey),
    raw: payload
  };
}

function normalizeChatEvent(event: ChatEvent): ChatEvent & { text?: string } {
  return {
    ...event,
    text: event.deltaText ?? extractText(event.message)
  };
}

function normalizeMessage(raw: unknown, sessionKey?: string): ClientMessage | undefined {
  const record = readRecord(raw);
  if (!record) return undefined;

  const role = normalizeRole(record.role ?? record.author ?? record.type);
  const text = unwrapUserMessageFromOpenClaw(extractText(record) || "");
  const hasAudio = hasAudioAttachment(record);
  const hiddenServerVoice = role === "user" && sessionKey ? isHiddenServerVoiceText(sessionKey, text) : false;

  return {
    id: String(record.id ?? record.messageId ?? record.runId ?? crypto.randomUUID()),
    role,
    source:
      role === "user" && (hasAudio || hiddenServerVoice)
        ? "voice"
        : role === "system"
          ? "system"
          : role === "user"
            ? "text"
            : "openclaw",
    content: role === "user" && (hasAudio || hiddenServerVoice) ? "" : text,
    createdAt: normalizeTimestamp(record.createdAt ?? record.ts ?? record.timestamp),
    status: "done",
    runId: typeof record.runId === "string" ? record.runId : undefined
  };
}

function normalizeRole(value: unknown): ClientMessage["role"] {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("assistant") || text.includes("agent")) return "assistant";
  if (text.includes("system")) return "system";
  return "user";
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  const record = readRecord(value);
  if (!record) return "";

  for (const key of ["content", "text", "message", "body", "visibleText", "displayText"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const partRecord = readRecord(part);
        return typeof part === "string" ? part : typeof partRecord?.text === "string" ? partRecord.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function hasAudioAttachment(record: Record<string, unknown>): boolean {
  const attachments = record.attachments;
  if (!Array.isArray(attachments)) return false;
  return attachments.some((attachment) => {
    const item = readRecord(attachment);
    return typeof item?.mimeType === "string" && item.mimeType.startsWith("audio/");
  });
}

function extractSessionKey(payload: unknown): string | undefined {
  const record = readRecord(payload);
  if (!record) return undefined;
  if (typeof record.sessionKey === "string") return record.sessionKey;
  const message = readRecord(record.message);
  if (typeof message?.sessionKey === "string") return message.sessionKey;
  return undefined;
}

function broadcastSession(sessionKey: string, event: string, payload: unknown): void {
  for (const key of sessionKeyAliases(sessionKey)) {
    hub.broadcast(key, event, payload);
  }
}

function sessionKeyAliases(sessionKey: string): string[] {
  const aliases = new Set<string>([sessionKey]);
  const agentPrefix = "agent:main:";

  if (sessionKey.startsWith(agentPrefix)) {
    aliases.add(sessionKey.slice(agentPrefix.length));
  } else {
    aliases.add(`${agentPrefix}${sessionKey}`);
  }

  return [...aliases];
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  return new Date().toISOString();
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Error", message: String(error) };
}

function rememberServerVoiceText(sessionKey: string, text: string): void {
  const normalized = normalizeTextForMatch(text);
  if (!normalized) return;
  const current = hiddenServerVoiceTexts.get(sessionKey) ?? new Set<string>();
  current.add(normalized);
  hiddenServerVoiceTexts.set(sessionKey, current);
}

function isHiddenServerVoiceText(sessionKey: string, text: string): boolean {
  const normalized = normalizeTextForMatch(text);
  return Boolean(normalized && hiddenServerVoiceTexts.get(sessionKey)?.has(normalized));
}

function normalizeTextForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function scheduleTempAudioCleanup(id: string, filePath: string): void {
  setTimeout(() => {
    const record = ttsFiles.get(id);
    if (record?.filePath === filePath) {
      ttsFiles.delete(id);
    }
    void safeUnlink(filePath);
  }, config.ttsCacheTtlMs).unref();
}

async function warmReplyAudio(sessionKey: string, event: ChatEvent & { text?: string }): Promise<void> {
  const text = event.text?.trim();
  if (!text || text.length > 5_000) return;

  const startedAt = Date.now();
  const result = await createOrGetTtsAudio(text);
  console.info(
    JSON.stringify({
      event: "tts-warmed",
      sessionKey,
      runId: event.runId,
      cached: result.cached,
      latencyMs: Date.now() - startedAt
    })
  );
  broadcastSession(sessionKey, "tts", {
    runId: event.runId,
    text,
    ...result
  });
}

async function createOrGetTtsAudio(text: string): Promise<TtsAudioResult> {
  const speechText = prepareTtsSpeechText(text);
  if (!speechText) {
    throw new VoiceCapabilityError("回复内容无法生成语音", 422, "TTS_TEXT_EMPTY");
  }

  const id = createTtsCacheId(speechText);
  const pending = pendingTtsFiles.get(id);
  if (pending) return pending;

  const promise = createOrGetTtsAudioUncached(id, speechText).finally(() => {
    pendingTtsFiles.delete(id);
  });
  pendingTtsFiles.set(id, promise);
  return promise;
}

async function createOrGetTtsAudioUncached(id: string, text: string): Promise<TtsAudioResult> {
  const dir = await ensureVoiceDir(config, "tts");
  const filePath = path.join(dir, `${id}.mp3`);
  const cached = await readFreshTtsFile(id, filePath);
  if (cached) {
    return { id, url: `/api/tts/${id}`, mimeType: cached.mimeType, cached: true };
  }

  await synthesizeWithOpenClaw({ config, text, outputPath: filePath });
  if (!existsSync(filePath)) {
    throw new Error("OpenClaw TTS did not create an audio file");
  }
  const mimeType = mimeForAudioPath(filePath);
  ttsFiles.set(id, { filePath, mimeType, createdAt: Date.now() });
  scheduleTempAudioCleanup(id, filePath);
  return { id, url: `/api/tts/${id}`, mimeType, cached: false };
}

function createTtsCacheId(text: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ text, voice: config.ttsVoice ?? "", model: config.ttsModel ?? "" }))
    .digest("hex")
    .slice(0, 32);
  return `tts-${hash}`;
}

function prepareTtsSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/gm, " ")
    .replace(/[*_~#`]+/g, "")
    .replace(/[()[\]{}<>（）［］【】《》「」『』]/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\s*\|\s*/g, "，")
    .replace(/\s+/g, " ")
    .trim();
}

async function readFreshTtsFile(id: string, filePath: string): Promise<{ mimeType: string } | undefined> {
  const existing = ttsFiles.get(id);
  const fileStat = await stat(filePath).catch(() => undefined);
  if (!fileStat || Date.now() - fileStat.mtimeMs > config.ttsCacheTtlMs) {
    ttsFiles.delete(id);
    if (fileStat) {
      void safeUnlink(filePath);
    }
    return undefined;
  }

  const mimeType = existing?.mimeType ?? mimeForAudioPath(filePath);
  ttsFiles.set(id, { filePath, mimeType, createdAt: existing?.createdAt ?? fileStat.mtimeMs });
  return { mimeType };
}

async function cleanupExpiredTtsFilesThrottled(): Promise<void> {
  const now = Date.now();
  if (now - lastTtsCleanupAt < 60_000) return;
  lastTtsCleanupAt = now;
  await cleanupExpiredTtsFiles();
}

async function cleanupExpiredTtsFiles(): Promise<void> {
  const dir = await ensureVoiceDir(config, "tts");
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mp3"))
      .map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        const fileStat = await stat(filePath).catch(() => undefined);
        if (!fileStat || now - fileStat.mtimeMs <= config.ttsCacheTtlMs) return;
        const id = path.basename(entry.name, ".mp3");
        ttsFiles.delete(id);
        await safeUnlink(filePath);
      })
  );
}

function resolveClientDir(serverDir: string): string {
  const candidates = [
    path.resolve(serverDir, "../client"),
    path.resolve(serverDir, "../../dist/client"),
    path.resolve(process.cwd(), "dist/client"),
    path.resolve(process.cwd(), "client")
  ];

  return candidates.find((candidate) => existsSync(path.join(candidate, "index.html"))) ?? candidates[0];
}

function requireAuth(request: Request, response: Response, next: NextFunction): void {
  const password = readAccessPassword();
  if (!password) {
    response.status(503).json({
      error: "Access password is not configured",
      passwordFile: config.accessPasswordFile
    });
    return;
  }

  if (!isAuthenticated(request, password)) {
    response.status(401).json({ error: "Authentication required" });
    return;
  }

  next();
}

function isAuthenticated(request: Request, password = readAccessPassword()): boolean {
  if (!password) return false;
  const token = readCookie(request.headers.cookie, config.authCookieName);
  if (!token) return false;

  const [expiresText, signature] = token.split(".");
  const expires = Number(expiresText);
  if (!Number.isFinite(expires) || Date.now() > expires) return false;
  const expected = signAuthToken(expiresText, password);
  return safeEqual(signature ?? "", expected);
}

function readAccessPassword(): string | undefined {
  try {
    const raw = readFileSync(path.resolve(process.cwd(), config.accessPasswordFile), "utf8");
    const firstLine = raw.split(/\r?\n/).find((line) => {
      const trimmed = line.trim();
      return trimmed && !trimmed.startsWith("#");
    });
    return firstLine?.trim();
  } catch {
    return undefined;
  }
}

function setAuthCookie(response: Response, password: string): void {
  const expires = String(Date.now() + AUTH_MAX_AGE_SECONDS * 1000);
  response.setHeader(
    "Set-Cookie",
    `${config.authCookieName}=${expires}.${signAuthToken(expires, password)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${AUTH_MAX_AGE_SECONDS}`
  );
}

function buildExpiredAuthCookie(): string {
  return `${config.authCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function signAuthToken(expires: string, password: string): string {
  return crypto.createHmac("sha256", password).update(expires).digest("base64url");
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return rawValue.join("=");
    }
  }
  return undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}
