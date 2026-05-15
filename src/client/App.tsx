import {
  Bot,
  Check,
  CircleStop,
  KeyRound,
  LoaderCircle,
  LogIn,
  LogOut,
  Mic,
  MicOff,
  Pause,
  Play,
  RotateCcw,
  Send,
  Square,
  Trash2,
  Volume2,
  VolumeX
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createId } from "./id";
import type { ChatEvent, ClientMessage, GatewayState } from "./types";
import { useSpeech } from "./useSpeech";

const SESSION_STORAGE_KEY = "openclaw-voice-session";
const SESSION_KEY_PREFIX = "agent:main:voice-web:";
const HIDDEN_VOICE_TEXTS_LIMIT = 80;
const mediaKeepaliveTitle = "OpenClaw Voice";

type ReplyAudioState = {
  loading?: boolean;
  url?: string;
  error?: string;
};

export function App() {
  const [sessionKey] = useState(() => readSessionKey());
  const [messages, setMessages] = useState<ClientMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [gateway, setGateway] = useState<GatewayState>({ status: "idle" });
  const [authChecking, setAuthChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceState, setVoiceState] = useState<string>("");
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [replyAudio, setReplyAudio] = useState<Record<string, ReplyAudioState>>({});
  const [lastSpokenId, setLastSpokenId] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const cancelRecordingRef = useRef(false);
  const recordingStartedAtRef = useRef<number | null>(null);
  const mediaKeepaliveRef = useRef<HTMLAudioElement | null>(null);
  const mediaKeepaliveStartedRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const { supported: speechSupported, speakingId, speak, stop, unlock } = useSpeech();

  const connected = gateway.status === "connected";
  const activeAssistant = useMemo(
    () => messages.find((message) => message.role === "assistant" && message.status === "streaming"),
    [messages]
  );

  useEffect(() => {
    void fetch("api/auth/status")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("auth status failed"))))
      .then((payload) => {
        setAuthenticated(Boolean(payload.authenticated));
        setAuthChecking(false);
      })
      .catch(() => {
        setAuthenticated(false);
        setAuthChecking(false);
      });
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const events = new EventSource(`api/events?sessionKey=${encodeURIComponent(sessionKey)}`);

    events.addEventListener("gateway", (event) => {
      setGateway(JSON.parse((event as MessageEvent).data));
    });

    events.addEventListener("chat", (event) => {
      handleChatEvent(JSON.parse((event as MessageEvent).data));
    });

    events.addEventListener("message", (event) => {
      const payload = JSON.parse((event as MessageEvent).data);
      const message = payload.message as ClientMessage | undefined;
      if (message?.role === "assistant" && message.content) {
        upsertMessage(message);
      }
    });

    events.addEventListener("tts", (event) => {
      attachReplyAudio(JSON.parse((event as MessageEvent).data));
    });

    events.addEventListener("error", (event) => {
      if ("data" in event && (event as MessageEvent).data) {
        const payload = JSON.parse((event as MessageEvent).data);
        setError(payload.message || "连接异常");
      }
    });

    return () => events.close();
  }, [authenticated, sessionKey]);

  useEffect(() => {
    if (!authenticated) return;
    void fetch(`api/history?sessionKey=${encodeURIComponent(sessionKey)}`)
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("history failed"))))
      .then((payload) => {
        if (Array.isArray(payload.messages)) {
          setMessages(applyHiddenVoiceTexts(payload.messages, sessionKey));
        }
      })
      .catch(() => {
        setMessages([]);
      });
  }, [authenticated, sessionKey]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  useEffect(() => {
    if (!autoSpeak) return;
    const last = [...messages].reverse().find((message) => message.role === "assistant" && message.status === "done");
    if (last && last.id !== lastSpokenId && last.content.trim()) {
      void speakReply(last).then((started) => {
        if (started) setLastSpokenId(last.id);
      });
    }
  }, [autoSpeak, lastSpokenId, messages, replyAudio, speak]);

  useEffect(() => {
    if (!authenticated) return;

    const start = () => {
      void startMediaKeepalive();
    };

    window.addEventListener("pointerdown", start, { capture: true, passive: true });
    window.addEventListener("touchstart", start, { capture: true, passive: true });
    window.addEventListener("keydown", start, { capture: true });

    return () => {
      window.removeEventListener("pointerdown", start, { capture: true });
      window.removeEventListener("touchstart", start, { capture: true });
      window.removeEventListener("keydown", start, { capture: true });
    };
  }, [authenticated]);

  useEffect(() => {
    const last = [...messages].reverse().find(
      (message) => message.role === "assistant" && message.status === "done" && message.content.trim()
    );
    if (last) {
      void ensureReplyAudio(last);
    }
  }, [messages, replyAudio]);

  useEffect(() => {
    if (!authenticated || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

    const mediaSession = navigator.mediaSession;
    try {
      mediaSession.metadata = new MediaMetadata({
        title: recording ? "正在录音" : mediaKeepaliveTitle,
        artist: "OpenClaw",
        album: "语音问答"
      });
      mediaSession.setActionHandler("nexttrack", () => {
        toggleRecording();
      });
      mediaSession.setActionHandler("play", () => {
        void startMediaKeepalive();
      });
      mediaSession.setActionHandler("pause", () => {
        void startMediaKeepalive();
      });
      mediaSession.setActionHandler("previoustrack", () => {
        void startMediaKeepalive();
      });
    } catch {
      return;
    }

    return () => {
      try {
        mediaSession.setActionHandler("nexttrack", null);
        mediaSession.setActionHandler("play", null);
        mediaSession.setActionHandler("pause", null);
        mediaSession.setActionHandler("previoustrack", null);
      } catch {
        // Some browsers expose mediaSession but reject specific actions.
      }
    };
  }, [authenticated, recording, busy]);

  function handleChatEvent(event: ChatEvent) {
    if (event.state === "delta") {
      const text = event.text ?? event.deltaText ?? "";
      if (!text) return;
      setMessages((current) => mergeAssistantDelta(current, event, text));
      return;
    }

    if (event.state === "final") {
      const text = event.text ?? event.deltaText ?? "";
      setMessages((current) => finalizeAssistant(current, event, text));
      setBusy(false);
      return;
    }

    if (event.state === "aborted") {
      setBusy(false);
      setMessages((current) =>
        current.map((message) =>
          message.role === "assistant" && message.status === "streaming"
            ? { ...message, status: "aborted" }
            : message
        )
      );
      return;
    }

    if (event.state === "error") {
      setBusy(false);
      setError(event.errorMessage || "OpenClaw 回复失败");
    }
  }

  const sendText = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;

    setDraft("");
    await sendTextMessage(message);
  };

  const resetConversation = async () => {
    if (busy || recording) return;
    await sendTextMessage("/reset");
  };

  const clearVisibleHistory = () => {
    stop();
    setMessages([]);
    setReplyAudio({});
    setError("");
    setLastSpokenId(null);
  };

  async function sendTextMessage(message: string) {
    setBusy(true);
    setError("");
    const optimistic: ClientMessage = {
      id: createId("msg"),
      role: "user",
      source: "text",
      content: message,
      createdAt: new Date().toISOString(),
      status: "pending"
    };
    setMessages((current) => [...current, optimistic]);

    try {
      const response = await fetch("api/chat/text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionKey, message })
      });
      if (!response.ok) throw await readApiError(response);
      setMessages((current) =>
        current.map((item) => (item.id === optimistic.id ? { ...item, status: "sent" } : item))
      );
    } catch (sendError) {
      setBusy(false);
      setError(sendError instanceof Error ? sendError.message : String(sendError));
      setMessages((current) =>
        current.map((item) => (item.id === optimistic.id ? { ...item, status: "error" } : item))
      );
    }
  }

  const toggleRecording = () => {
    void startMediaKeepalive();
    if (recording) {
      stopRecording();
      return;
    }
    void startRecording();
  };

  const startRecording = async () => {
    if (recording || busy) return;
    setError("");
    setVoiceState("");
    cancelRecordingRef.current = false;

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("当前浏览器不支持麦克风录制");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = chooseMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunksRef.current = [];
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (dataEvent) => {
        if (dataEvent.data.size > 0) {
          audioChunksRef.current.push(dataEvent.data);
        }
      };
      recorder.onstop = () => {
        const durationMs = Date.now() - (recordingStartedAtRef.current ?? Date.now());
        stopMediaStream();
        setRecording(false);
        recordingStartedAtRef.current = null;
        if (cancelRecordingRef.current || durationMs < 250) {
          setVoiceState("");
          return;
        }
        window.setTimeout(() => {
          const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
          void sendAudio(blob);
        }, 150);
      };

      recorder.start();
      const startedAt = Date.now();
      setRecording(true);
      recordingStartedAtRef.current = startedAt;
      setVoiceState("正在听");
    } catch (micError) {
      setError(micError instanceof Error ? micError.message : "麦克风不可用");
      setRecording(false);
      stopMediaStream();
    }
  };

  const stopRecording = () => {
    if (!recording) return;
    setVoiceState("发送中");
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  };

  const cancelRecording = () => {
    if (!recording) return;
    cancelRecordingRef.current = true;
    mediaRecorderRef.current?.stop();
    setVoiceState("");
  };

  const sendAudio = async (blob: Blob) => {
    const optimistic: ClientMessage = {
      id: createId("msg"),
      role: "user",
      source: "voice",
      content: "",
      createdAt: new Date().toISOString(),
      status: "pending"
    };
    setMessages((current) => [...current, optimistic]);
    setBusy(true);
    setVoiceState("语音已发送");

    const formData = new FormData();
    formData.append("sessionKey", sessionKey);
    formData.append("audio", blob, `voice-${Date.now()}.${extensionForBlob(blob)}`);

    try {
      const response = await fetch("api/chat/audio", {
        method: "POST",
        body: formData
      });
      if (!response.ok) throw await readApiError(response);
      const payload = await response.json().catch(() => undefined);
      if (typeof payload?.hiddenText === "string") {
        rememberHiddenVoiceText(sessionKey, payload.hiddenText);
        setMessages((current) => applyHiddenVoiceTexts(current, sessionKey));
      }
      setMessages((current) =>
        current.map((item) => (item.id === optimistic.id ? { ...item, status: "sent" } : item))
      );
    } catch (sendError) {
      setBusy(false);
      setVoiceState("");
      setError(sendError instanceof Error ? sendError.message : String(sendError));
      setMessages((current) =>
        current.map((item) => (item.id === optimistic.id ? { ...item, status: "error" } : item))
      );
    }
  };

  const abort = async () => {
    stop();
    if (!activeAssistant && !busy) return;
    setBusy(false);
    await fetch("api/chat/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey, runId: activeAssistant?.runId })
    }).catch(() => undefined);
  };

  function stopMediaStream() {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }

  const login = async (event: FormEvent) => {
    event.preventDefault();
    const submitted = password.trim();
    if (!submitted) return;
    setAuthError("");

    try {
      const response = await fetch("api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: submitted })
      });
      if (!response.ok) throw await readApiError(response);
      setPassword("");
      setAuthenticated(true);
    } catch (loginError) {
      setAuthError(loginError instanceof Error ? loginError.message : String(loginError));
    }
  };

  const logout = async () => {
    await fetch("api/auth/logout", { method: "POST" }).catch(() => undefined);
    setAuthenticated(false);
    setMessages([]);
    stop();
  };

  if (authChecking) {
    return <AuthShell busy />;
  }

  if (!authenticated) {
    return (
      <AuthShell
        password={password}
        error={authError}
        onPasswordChange={setPassword}
        onSubmit={login}
      />
    );
  }

  return (
    <main className="app-shell">
      <section className="conversation">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">
              <Bot size={20} />
            </span>
            <div>
              <h1>OpenClaw Voice</h1>
              <p>{gatewayLabel(gateway)}</p>
            </div>
          </div>
          <div className="top-actions">
            <button
              className={`icon-text ${autoSpeak ? "active" : ""}`}
              type="button"
              onClick={() => {
                unlock();
                void startMediaKeepalive();
                setAutoSpeak((value) => !value);
              }}
              disabled={!speechSupported}
              title={speechSupported ? "自动朗读" : "朗读不可用"}
            >
              {autoSpeak ? <Volume2 size={18} /> : <VolumeX size={18} />}
              <span>自动</span>
            </button>
            <button className="icon-button" type="button" onClick={clearVisibleHistory} title="清空页面">
              <Trash2 size={18} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={resetConversation}
              disabled={busy || recording}
              title="重置对话"
            >
              <RotateCcw size={18} />
            </button>
            <button className="icon-button" type="button" onClick={logout} title="退出">
              <LogOut size={18} />
            </button>
          </div>
        </header>

        {error ? <div className="error-strip">{error}</div> : null}

        <div className="message-list">
          {messages.length === 0 ? (
            <div className="empty-state">
              <Bot size={36} />
              <span>可以开始提问</span>
            </div>
          ) : null}
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              speaking={speakingId === message.id}
              speechSupported={speechSupported}
              audio={replyAudio[message.id]}
              onSpeak={() => void speakReply(message)}
              onStop={stop}
            />
          ))}
          {busy && !activeAssistant ? (
            <div className="thinking">
              <LoaderCircle size={16} />
              <span>正在回答</span>
            </div>
          ) : null}
          <div ref={messagesEndRef} />
        </div>

        <form className="composer" onSubmit={sendText}>
          <button
            className={`mic-button ${recording ? "recording" : ""}`}
            type="button"
            disabled={busy && !recording}
            onClick={toggleRecording}
            onContextMenu={(event) => event.preventDefault()}
            title={recording ? "发送语音" : "开始录音"}
          >
            {recording ? <MicOff size={22} /> : <Mic size={22} />}
          </button>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={recording ? voiceState || "正在听" : "输入问题"}
            disabled={recording}
          />
          {recording ? (
            <button className="icon-button danger" type="button" onClick={cancelRecording} title="取消">
              <Square size={18} />
            </button>
          ) : busy ? (
            <button className="icon-button danger" type="button" onClick={abort} title="停止">
              <CircleStop size={19} />
            </button>
          ) : (
            <button className="send-button" type="submit" disabled={!draft.trim()}>
              <Send size={19} />
              <span>发送</span>
            </button>
          )}
        </form>
      </section>
    </main>
  );

  function upsertMessage(message: ClientMessage) {
    setMessages((current) => {
      if (message.role === "assistant" && message.content) {
        const matchingAssistant = findAssistantMatch(current, message);
        if (matchingAssistant >= 0) {
          const next = [...current];
          next[matchingAssistant] = {
            ...next[matchingAssistant],
            ...message,
            id: next[matchingAssistant].id,
            runId: next[matchingAssistant].runId ?? message.runId,
            status: "done"
          };
          return next;
        }
      }

      const existing = current.findIndex((item) => item.id === message.id);
      if (existing >= 0) {
        const next = [...current];
        next[existing] = message;
        return next;
      }
      return [...current, message];
    });
  }

  async function speakReply(message: ClientMessage): Promise<boolean> {
    if (replyAudio[message.id]?.loading) return false;
    const audioUrl = await ensureReplyAudio(message);
    return speak(message.id, message.content, audioUrl);
  }

  function attachReplyAudio(payload: unknown): void {
    const record = readRecord(payload);
    const url = typeof record?.url === "string" ? record.url : "";
    const text = typeof record?.text === "string" ? record.text : "";
    const runId = typeof record?.runId === "string" ? record.runId : "";
    if (!url) return;

    setMessages((current) => {
      const index = findAssistantForAudio(current, { runId, text });
      if (index >= 0) {
        const message = current[index];
        setReplyAudio((items) => ({
          ...items,
          [message.id]: { url }
        }));
      }
      return current;
    });
  }

  async function ensureReplyAudio(message: ClientMessage): Promise<string | undefined> {
    const current = replyAudio[message.id];
    if (current?.url || !message.content.trim()) return current?.url;
    if (current?.loading) return undefined;

    setReplyAudio((items) => ({
      ...items,
      [message.id]: { loading: true }
    }));

    try {
      const response = await fetch("api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message.content })
      });
      if (!response.ok) throw await readApiError(response);
      const payload = await response.json();
      if (typeof payload?.url !== "string") throw new Error("服务器没有返回音频地址");
      setReplyAudio((items) => ({
        ...items,
        [message.id]: { url: payload.url }
      }));
      return payload.url;
    } catch (audioError) {
      setReplyAudio((items) => ({
        ...items,
        [message.id]: {
          error: audioError instanceof Error ? audioError.message : String(audioError)
        }
      }));
      return undefined;
    }
  }

  async function startMediaKeepalive(): Promise<void> {
    if (typeof window === "undefined" || mediaKeepaliveStartedRef.current) return;

    const audio = getMediaKeepaliveAudio();
    try {
      await audio.play();
      mediaKeepaliveStartedRef.current = true;
      if ("mediaSession" in navigator) {
        navigator.mediaSession.playbackState = "playing";
      }
    } catch {
      mediaKeepaliveStartedRef.current = false;
    }
  }

  function getMediaKeepaliveAudio(): HTMLAudioElement {
    if (mediaKeepaliveRef.current) return mediaKeepaliveRef.current;

    const audio = new Audio(createSilentWavDataUrl(30));
    audio.loop = true;
    audio.volume = 0;
    audio.muted = false;
    audio.preload = "auto";
    audio.setAttribute("playsinline", "true");
    mediaKeepaliveRef.current = audio;
    return audio;
  }
}

function createSilentWavDataUrl(durationSeconds: number): string {
  const sampleRate = 8000;
  const bytesPerSample = 2;
  const sampleCount = Math.max(1, Math.floor(sampleRate * durationSeconds));
  const dataSize = sampleCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function findAssistantForAudio(messages: ClientMessage[], payload: { runId?: string; text?: string }): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (payload.runId && message.runId === payload.runId) return index;
    if (payload.text && normalizeTextForMatch(message.content) === normalizeTextForMatch(payload.text)) return index;
  }
  return -1;
}

function findAssistantMatch(messages: ClientMessage[], incoming: ClientMessage): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    if (incoming.runId && message.runId === incoming.runId) return index;
    if (message.content && message.content === incoming.content) return index;
    if (message.status === "streaming") return index;
  }
  return -1;
}

function applyHiddenVoiceTexts(messages: ClientMessage[], sessionKey: string): ClientMessage[] {
  const hiddenTexts = new Set(readHiddenVoiceTexts(sessionKey));
  if (hiddenTexts.size === 0) return messages;

  return messages.map((message) => {
    if (message.role !== "user") return message;
    if (!hiddenTexts.has(normalizeTextForMatch(message.content))) return message;
    return {
      ...message,
      source: "voice",
      content: ""
    };
  });
}

function rememberHiddenVoiceText(sessionKey: string, text: string): void {
  const normalized = normalizeTextForMatch(text);
  if (!normalized) return;
  const current = readHiddenVoiceTexts(sessionKey).filter((item) => item !== normalized);
  current.push(normalized);
  safeStorageSet(hiddenVoiceTextsKey(sessionKey), JSON.stringify(current.slice(-HIDDEN_VOICE_TEXTS_LIMIT)));
}

function readHiddenVoiceTexts(sessionKey: string): string[] {
  const raw = safeStorageGet(hiddenVoiceTextsKey(sessionKey));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function hiddenVoiceTextsKey(sessionKey: string): string {
  return `${SESSION_STORAGE_KEY}:hidden:${sessionKey}`;
}

function normalizeTextForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function AuthShell({
  busy = false,
  password = "",
  error = "",
  onPasswordChange,
  onSubmit
}: {
  busy?: boolean;
  password?: string;
  error?: string;
  onPasswordChange?: (value: string) => void;
  onSubmit?: (event: FormEvent) => void;
}) {
  return (
    <main className="app-shell auth-shell">
      <section className="auth-panel">
        <span className="brand-mark">
          <KeyRound size={20} />
        </span>
        <div>
          <h1>OpenClaw Voice</h1>
          <p>{busy ? "正在检查访问权限" : "请输入访问密码"}</p>
        </div>
        {busy ? (
          <div className="auth-loading">
            <LoaderCircle size={18} />
            <span>请稍候</span>
          </div>
        ) : (
          <form className="auth-form" onSubmit={onSubmit}>
            <input
              autoFocus
              type="password"
              value={password}
              onChange={(event) => onPasswordChange?.(event.target.value)}
              placeholder="访问密码"
            />
            <button className="send-button" type="submit" disabled={!password.trim()}>
              <LogIn size={18} />
              <span>进入</span>
            </button>
          </form>
        )}
        {error ? <div className="error-strip auth-error">{error}</div> : null}
      </section>
    </main>
  );
}

function MessageBubble({
  message,
  speaking,
  speechSupported,
  audio,
  onSpeak,
  onStop
}: {
  message: ClientMessage;
  speaking: boolean;
  speechSupported: boolean;
  audio?: ReplyAudioState;
  onSpeak: () => void;
  onStop: () => void;
}) {
  const isAssistant = message.role === "assistant";
  const isVoice = message.source === "voice";

  return (
    <article className={`message ${message.role} ${message.status ?? ""}`}>
      <div className="message-body">
        {isVoice ? (
          <span className="voice-chip">
            {message.status === "pending" ? <LoaderCircle size={15} /> : <Check size={15} />}
            语音已发送
          </span>
        ) : (
          <p>{message.content}</p>
        )}
      </div>
      {isAssistant && message.content ? (
        <div className="message-actions">
          <button
            className="icon-button tiny"
            type="button"
            disabled={!speechSupported || audio?.loading}
            onClick={speaking ? onStop : onSpeak}
            title={audio?.loading ? "音频生成中" : speaking ? "停止播放" : "播放"}
          >
            {audio?.loading ? <LoaderCircle size={16} /> : speaking ? <Pause size={16} /> : <Play size={16} />}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function mergeAssistantDelta(current: ClientMessage[], event: ChatEvent, text: string): ClientMessage[] {
  const runId = event.runId || "active";
  const index = current.findIndex(
    (message) => message.role === "assistant" && (message.runId === runId || message.status === "streaming")
  );

  if (index < 0) {
    return [
      ...current,
      {
        id: createId("msg"),
        role: "assistant",
        source: "openclaw",
        content: text,
        createdAt: new Date().toISOString(),
        status: "streaming",
        runId
      }
    ];
  }

  const next = [...current];
  const message = next[index];
  next[index] = {
    ...message,
    runId,
    content: event.replace ? text : `${message.content}${text}`,
    status: "streaming"
  };
  return next;
}

function finalizeAssistant(current: ClientMessage[], event: ChatEvent, text: string): ClientMessage[] {
  const runId = event.runId || "active";
  const index = current.findIndex(
    (message) => message.role === "assistant" && (message.runId === runId || message.status === "streaming")
  );

  if (index < 0) {
    if (!text) return current;
    return [
      ...current,
      {
        id: createId("msg"),
        role: "assistant",
        source: "openclaw",
        content: text,
        createdAt: new Date().toISOString(),
        status: "done",
        runId
      }
    ];
  }

  const next = [...current];
  next[index] = {
    ...next[index],
    runId,
    content: text || next[index].content,
    status: "done"
  };
  return next;
}

async function readApiError(response: Response): Promise<Error> {
  try {
    const payload = await response.json();
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : typeof payload?.error?.message === "string"
          ? payload.error.message
          : "请求失败";
    return new Error(message);
  } catch {
    return new Error(`请求失败：${response.status}`);
  }
}

function chooseMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

function extensionForBlob(blob: Blob): string {
  if (blob.type.includes("ogg")) return "ogg";
  if (blob.type.includes("mp4")) return "m4a";
  if (blob.type.includes("wav")) return "wav";
  return "webm";
}

function readSessionKey(): string {
  const existing = safeStorageGet(SESSION_STORAGE_KEY);
  if (existing) {
    const normalized = normalizeSessionKey(existing);
    if (normalized !== existing) {
      safeStorageSet(SESSION_STORAGE_KEY, normalized);
    }
    return normalized;
  }
  const created = `${SESSION_KEY_PREFIX}${createId("session")}`;
  safeStorageSet(SESSION_STORAGE_KEY, created);
  return created;
}

function normalizeSessionKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith(SESSION_KEY_PREFIX)) return trimmed;
  if (trimmed.startsWith("agent:main:")) return trimmed;
  if (trimmed.startsWith("voice-web:")) return `agent:main:${trimmed}`;
  return `${SESSION_KEY_PREFIX}${trimmed}`;
}

function safeStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Session persistence is nice to have; the app can still run without it.
  }
}

function gatewayLabel(gateway: GatewayState): string {
  if (gateway.status === "connected") return "已连接 OpenClaw";
  if (gateway.status === "connecting") return "正在连接";
  if (gateway.status === "error") return gateway.message || "连接异常";
  if (gateway.status === "disconnected") return "连接已断开";
  return "准备中";
}
