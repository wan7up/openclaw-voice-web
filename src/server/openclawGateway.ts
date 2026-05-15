import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { AppConfig } from "./config.js";
import {
  buildDeviceAuthPayload,
  loadOrCreateDeviceIdentity,
  saveDeviceIdentity,
  signDevicePayload,
  type DeviceIdentity
} from "./deviceIdentity.js";
import type { ChatAttachment, ChatEvent, GatewayErrorPayload, GatewayFrame, GatewayStatus } from "./types.js";

const USER_MESSAGE_PREFIX =
  "[OpenClaw Voice Web]\n" +
  "The browser user's actual question is below. Answer only that question. " +
  "Do not mention, quote, summarize, or react to OpenClaw/Gateway/Sender/Client/untrusted metadata.\n\n" +
  "User question:\n";
const USER_MESSAGE_SUFFIX = "\n\n[End of user question. Reply directly to the user.]";

export function wrapUserMessageForOpenClaw(message: string): string {
  return `${USER_MESSAGE_PREFIX}${message}${USER_MESSAGE_SUFFIX}`;
}

export function unwrapUserMessageFromOpenClaw(message: string): string {
  if (!message.startsWith(USER_MESSAGE_PREFIX) || !message.endsWith(USER_MESSAGE_SUFFIX)) {
    return message;
  }
  return message.slice(USER_MESSAGE_PREFIX.length, -USER_MESSAGE_SUFFIX.length);
}

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type GatewayEvents = {
  status: [payload: { status: GatewayStatus; message?: string; connectedAt?: string }];
  chat: [payload: ChatEvent];
  rawEvent: [payload: { event: string; payload: unknown }];
};

export interface OpenClawGateway {
  on<K extends keyof GatewayEvents>(event: K, listener: (...args: GatewayEvents[K]) => void): this;
  emit<K extends keyof GatewayEvents>(event: K, ...args: GatewayEvents[K]): boolean;
}

export class OpenClawGateway extends EventEmitter {
  private ws?: WebSocket;
  private status: GatewayStatus = "idle";
  private connectedAt?: string;
  private requestSeq = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private connecting?: Promise<void>;
  private connectSent = false;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly deviceIdentityPromise: Promise<DeviceIdentity>;

  constructor(private readonly config: AppConfig) {
    super();
    this.deviceIdentityPromise = loadOrCreateDeviceIdentity(config.deviceIdentityPath);
  }

  getStatus(): { status: GatewayStatus; connectedAt?: string; url: string } {
    return {
      status: this.status,
      connectedAt: this.connectedAt,
      url: this.config.gatewayWsUrl
    };
  }

  async health(): Promise<unknown> {
    return this.rpc("health", {});
  }

  async history(sessionKey: string): Promise<unknown> {
    return this.rpc("chat.history", {
      sessionKey,
      limit: this.config.historyLimit,
      maxChars: 250_000
    });
  }

  async subscribeMessages(sessionKey: string): Promise<unknown> {
    return this.rpc("sessions.messages.subscribe", { key: sessionKey });
  }

  async sendText(params: { sessionKey: string; message: string }): Promise<unknown> {
    return this.rpc("chat.send", {
      sessionKey: params.sessionKey,
      message: wrapUserMessageForOpenClaw(params.message),
      attachments: [],
      timeoutMs: this.config.chatTimeoutMs,
      idempotencyKey: crypto.randomUUID()
    });
  }

  async sendAudio(params: {
    sessionKey: string;
    audio: Buffer;
    mimeType: string;
    fileName: string;
  }): Promise<unknown> {
    const attachment: ChatAttachment = {
      type: "audio",
      mimeType: params.mimeType,
      fileName: params.fileName,
      content: params.audio.toString("base64")
    };

    return this.rpc("chat.send", {
      sessionKey: params.sessionKey,
      message: "",
      attachments: [attachment],
      timeoutMs: this.config.chatTimeoutMs,
      idempotencyKey: crypto.randomUUID()
    });
  }

  async abort(sessionKey: string, runId?: string): Promise<unknown> {
    return this.rpc("chat.abort", {
      sessionKey,
      ...(runId ? { runId } : {})
    });
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    await this.ensureConnected();

    const id = `${Date.now()}-${++this.requestSeq}`;
    const frame: GatewayFrame = {
      type: "req",
      id,
      method,
      params
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OpenClaw RPC timeout: ${method}`));
      }, this.config.requestTimeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });

    this.send(frame);
    return promise;
  }

  async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.status === "connected") {
      return;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = new Promise<void>((resolve, reject) => {
      this.setStatus("connecting");
      this.connectSent = false;
      const ws = new WebSocket(this.config.gatewayWsUrl, {
        handshakeTimeout: this.config.requestTimeoutMs
      });
      this.ws = ws;

      const fail = (error: Error) => {
        this.connecting = undefined;
        this.setStatus("error", error.message);
        reject(error);
      };

      const connectTimeout = setTimeout(() => {
        fail(new Error("OpenClaw Gateway connect timeout"));
        ws.close();
      }, this.config.requestTimeoutMs);

      const maybeSendConnect = (challenge?: unknown) => {
        if (this.connectSent || ws.readyState !== WebSocket.OPEN) return;
        this.connectSent = true;

        const connectId = `connect-${Date.now()}-${++this.requestSeq}`;
        const timer = setTimeout(() => {
          this.pending.delete(connectId);
          fail(new Error("OpenClaw Gateway handshake timeout"));
          ws.close();
        }, this.config.requestTimeoutMs);

        this.pending.set(connectId, {
          method: "connect",
          timer,
          resolve: (payload) => {
            clearTimeout(connectTimeout);
            this.connecting = undefined;
            this.connectedAt = new Date().toISOString();
            this.setStatus("connected", undefined, this.connectedAt);
            void this.storeDeviceToken(payload).catch((error) => {
              this.emit("rawEvent", {
                event: "device-token-store-error",
                payload: { message: error instanceof Error ? error.message : String(error) }
              });
            });
            resolve();
            this.emit("rawEvent", { event: "hello-ok", payload });
          },
          reject: (error) => {
            clearTimeout(connectTimeout);
            fail(error);
          }
        });

        void this.buildConnectParams(challenge)
          .then((params) => {
            this.send({
              type: "req",
              id: connectId,
              method: "connect",
              params
            });
          })
          .catch((error) => {
            const pending = this.pending.get(connectId);
            if (pending) {
              clearTimeout(pending.timer);
              this.pending.delete(connectId);
            }
            fail(error instanceof Error ? error : new Error(String(error)));
          });
      };

      ws.on("open", () => {
        this.emit("rawEvent", { event: "socket-open", payload: { url: this.config.gatewayWsUrl } });
      });

      ws.on("message", (data) => {
        try {
          const frame = JSON.parse(data.toString()) as GatewayFrame;
          if (frame.type === "event" && frame.event === "connect.challenge") {
            maybeSendConnect(frame.payload);
            return;
          }
          this.handleFrame(frame);
        } catch (error) {
          this.emit("rawEvent", {
            event: "parse-error",
            payload: { message: error instanceof Error ? error.message : String(error) }
          });
        }
      });

      ws.on("close", () => {
        clearTimeout(connectTimeout);
        this.rejectPending(new Error("OpenClaw Gateway connection closed"));
        this.ws = undefined;
        this.connecting = undefined;
        this.connectedAt = undefined;
        this.setStatus("disconnected");
        this.scheduleReconnect();
      });

      ws.on("error", (error) => {
        clearTimeout(connectTimeout);
        if (this.connecting) {
          fail(error);
        } else {
          this.setStatus("error", error.message);
        }
      });
    });

    return this.connecting;
  }

  private async buildConnectParams(challenge?: unknown): Promise<Record<string, unknown>> {
    const auth: Record<string, string> = {};
    if (this.config.gatewayToken) {
      auth.token = this.config.gatewayToken;
    }
    if (this.config.gatewayPassword) {
      auth.password = this.config.gatewayPassword;
    }
    const identity = await this.deviceIdentityPromise;
    if (!auth.token && !auth.password && identity.deviceToken) {
      auth.token = identity.deviceToken;
    }
    if (identity.deviceToken) {
      auth.deviceToken = identity.deviceToken;
    }

    const client = {
      id: "gateway-client",
      version: "0.1.0",
      platform: "node",
      deviceFamily: "server",
      mode: "backend"
    };
    const role = "operator";
    const scopes = ["operator.read", "operator.write"];
    const signedAtMs = Date.now();
    const nonce = readChallengeNonce(challenge);
    const signaturePayload = buildDeviceAuthPayload({
      deviceId: identity.deviceId,
      clientId: client.id,
      clientMode: client.mode,
      role,
      scopes,
      signedAtMs,
      token: auth.token ?? null,
      nonce
    });
    const signature = await signDevicePayload(identity.privateKey, signaturePayload);

    return {
      minProtocol: 3,
      maxProtocol: 4,
      client,
      role,
      scopes,
      caps: [],
      commands: [],
      permissions: {},
      device: {
        id: identity.deviceId,
        publicKey: identity.publicKey,
        signature,
        signedAt: signedAtMs,
        nonce
      },
      ...(Object.keys(auth).length > 0 ? { auth } : {}),
      locale: "zh-CN",
      userAgent: "openclaw-voice-web/0.1.0"
    };
  }

  private async storeDeviceToken(payload: unknown): Promise<void> {
    const record = readRecord(payload);
    const auth = readRecord(record?.auth);
    const token = typeof auth?.deviceToken === "string" ? auth.deviceToken : undefined;
    if (!token) return;
    const identity = await this.deviceIdentityPromise;
    if (identity.deviceToken === token) return;
    identity.deviceToken = token;
    await saveDeviceIdentity(this.config.deviceIdentityPath, identity);
  }

  private handleFrame(frame: GatewayFrame): void {
    if (frame.type === "res") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;

      clearTimeout(pending.timer);
      this.pending.delete(frame.id);

      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        pending.reject(this.gatewayErrorToError(frame.error, pending.method));
      }
      return;
    }

    if (frame.type === "event") {
      if (this.isChatEvent(frame.payload)) {
        this.emit("chat", frame.payload);
      }
      this.emit("rawEvent", { event: frame.event, payload: frame.payload });
    }
  }

  private isChatEvent(payload: unknown): payload is ChatEvent {
    return (
      typeof payload === "object" &&
      payload !== null &&
      "sessionKey" in payload &&
      "state" in payload
    );
  }

  private gatewayErrorToError(error: GatewayErrorPayload | undefined, method: string): Error {
    const message = error?.message || error?.code || `OpenClaw RPC failed: ${method}`;
    const err = new Error(message);
    err.name = error?.code || "OpenClawGatewayError";
    return err;
  }

  private send(frame: GatewayFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("OpenClaw Gateway is not connected");
    }
    this.ws.send(JSON.stringify(frame));
  }

  private setStatus(status: GatewayStatus, message?: string, connectedAt?: string): void {
    this.status = status;
    this.emit("status", { status, message, connectedAt });
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.ensureConnected().catch(() => {
        this.scheduleReconnect();
      });
    }, 2_000);
  }
}

function readChallengeNonce(challenge: unknown): string {
  const record = readRecord(challenge);
  return typeof record?.nonce === "string" ? record.nonce : "";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
