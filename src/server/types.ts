import type { Response } from "express";

export type GatewayStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

export type GatewayFrame =
  | {
      type: "req";
      id: string;
      method: string;
      params: unknown;
    }
  | {
      type: "res";
      id: string;
      ok: boolean;
      payload?: unknown;
      error?: GatewayErrorPayload;
    }
  | {
      type: "event";
      event: string;
      payload?: unknown;
      seq?: number;
      stateVersion?: number;
    };

export type GatewayErrorPayload = {
  code?: string;
  message?: string;
  details?: unknown;
};

export type ChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content: string;
};

export type ChatEvent = {
  runId?: string;
  sessionKey?: string;
  state?: "delta" | "final" | "aborted" | "error" | string;
  seq?: number;
  deltaText?: string;
  replace?: boolean;
  message?: unknown;
  errorMessage?: string;
  errorKind?: string;
  stopReason?: string;
};

export type ClientMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  source: "text" | "voice" | "openclaw" | "system";
  content: string;
  createdAt: string;
  status?: "pending" | "sent" | "streaming" | "done" | "error" | "aborted";
  runId?: string;
};

export type SseClient = {
  id: string;
  sessionKey: string;
  response: Response;
};
