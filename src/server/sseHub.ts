import type { Response } from "express";
import type { SseClient } from "./types.js";

export class SseHub {
  private readonly clients = new Map<string, Map<string, SseClient>>();

  add(sessionKey: string, response: Response): () => void {
    const id = crypto.randomUUID();
    const client: SseClient = { id, sessionKey, response };
    const bySession = this.clients.get(sessionKey) ?? new Map<string, SseClient>();
    bySession.set(id, client);
    this.clients.set(sessionKey, bySession);

    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders?.();
    this.sendToClient(client, "ready", { sessionKey });

    const heartbeat = setInterval(() => {
      this.sendToClient(client, "ping", { now: new Date().toISOString() });
    }, 25_000);

    const remove = () => {
      clearInterval(heartbeat);
      const sessionClients = this.clients.get(sessionKey);
      sessionClients?.delete(id);
      if (sessionClients?.size === 0) {
        this.clients.delete(sessionKey);
      }
    };

    response.on("close", remove);
    return remove;
  }

  broadcast(sessionKey: string, event: string, payload: unknown): void {
    const bySession = this.clients.get(sessionKey);
    if (!bySession) return;
    for (const client of bySession.values()) {
      this.sendToClient(client, event, payload);
    }
  }

  broadcastAll(event: string, payload: unknown): void {
    for (const bySession of this.clients.values()) {
      for (const client of bySession.values()) {
        this.sendToClient(client, event, payload);
      }
    }
  }

  private sendToClient(client: SseClient, event: string, payload: unknown): void {
    client.response.write(`event: ${event}\n`);
    client.response.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}
