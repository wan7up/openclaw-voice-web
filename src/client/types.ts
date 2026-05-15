export type Role = "user" | "assistant" | "system";
export type MessageSource = "text" | "voice" | "openclaw" | "system";
export type MessageStatus = "pending" | "sent" | "streaming" | "done" | "error" | "aborted";

export type ClientMessage = {
  id: string;
  role: Role;
  source: MessageSource;
  content: string;
  createdAt: string;
  status?: MessageStatus;
  runId?: string;
};

export type GatewayState = {
  status: "idle" | "connecting" | "connected" | "disconnected" | "error";
  message?: string;
  connectedAt?: string;
};

export type ChatEvent = {
  runId?: string;
  sessionKey?: string;
  state?: string;
  seq?: number;
  deltaText?: string;
  text?: string;
  replace?: boolean;
  message?: unknown;
  errorMessage?: string;
  errorKind?: string;
  stopReason?: string;
};
