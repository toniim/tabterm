import type { ServerWebSocket } from "bun";
import type { ClientMessage, Entity, ServerMessage } from "../shared/types.ts";
import {
  createGroup,
  createSession,
  deleteSession,
  loadState,
  reorder,
  toggleGroup,
} from "./db.ts";
import { ensure, kill } from "./gotty.ts";

// App-level WS connections (distinct from the per-session GoTTY proxy sockets
// that arrive in v0.2). Mutations are persisted first, then broadcast to all.
const pool = new Set<ServerWebSocket<unknown>>();

function send(ws: ServerWebSocket<unknown>, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  const payload = JSON.stringify(msg);
  for (const ws of pool) ws.send(payload);
}

function setPatch(entity: Entity, data: unknown): ServerMessage {
  return { type: "patch", entity, op: "set", data };
}

export function onOpen(ws: ServerWebSocket<unknown>): void {
  pool.add(ws);
  send(ws, { type: "init", state: loadState() });
}

export function onClose(ws: ServerWebSocket<unknown>): void {
  pool.delete(ws);
}

export function onMessage(_ws: ServerWebSocket<unknown>, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return;
  }

  switch (msg.type) {
    case "group:create": {
      const { group, order } = createGroup(msg.primaryTabId, msg.label, msg.color);
      broadcast(setPatch("group", group));
      broadcast(setPatch("order", { primaryTabId: msg.primaryTabId, order }));
      break;
    }
    case "group:toggle": {
      const group = toggleGroup(msg.groupId);
      if (group) broadcast(setPatch("group", group));
      break;
    }
    case "session:create": {
      const { session, order } = createSession(msg.primaryTabId, msg.groupId, msg.label);
      void ensure(session.id); // spawn the session's GoTTY shell
      broadcast(setPatch("session", session));
      if (order) broadcast(setPatch("order", { primaryTabId: msg.primaryTabId, order }));
      break;
    }
    case "session:delete": {
      const result = deleteSession(msg.sessionId);
      if (!result) break;
      kill(msg.sessionId);
      broadcast({ type: "patch", entity: "session", op: "delete", id: msg.sessionId });
      if (result.order) {
        broadcast(setPatch("order", { primaryTabId: result.primaryTabId, order: result.order }));
      }
      break;
    }
    case "reorder": {
      const order = reorder(msg.primaryTabId, msg.order);
      broadcast(setPatch("order", { primaryTabId: msg.primaryTabId, order }));
      break;
    }
  }
}
