import { VerdictRecord } from "@nailed-it/protocol";
import { routePartykitRequest, Server, type Connection, type WSMessage } from "partyserver";
import { handleExportRequest } from "./export";
import type { InternalState } from "./game/types";
import { isValidRoomCode } from "./room-code";
import {
  createSession,
  disconnectEveryone,
  handleClose,
  handleMessage,
  type Outbound,
  type Session,
  type SessionDeps,
  type SessionStep,
} from "./session";

const STATE_KEY = "state";
const TOKENS_KEY = "tokens";
const VERDICT_PREFIX = "verdict:";

const verdictKey = (sequence: number): string => `${VERDICT_PREFIX}${String(sequence).padStart(6, "0")}`;

const liveDeps: SessionDeps = {
  newPlayerId: () => crypto.randomUUID(),
  newToken: () => crypto.randomUUID(),
  random: () => Math.random(),
  now: () => new Date().toISOString(),
};

const POLICY_VIOLATION = 1008;
const UNSUPPORTED_DATA = 1003;

export class Room extends Server {
  private session: Session | undefined;

  async onStart(): Promise<void> {
    const stored = await this.ctx.storage.get<InternalState>(STATE_KEY);
    const tokens = await this.ctx.storage.get<[string, string][]>(TOKENS_KEY);
    this.session = createSession(this.name, stored ? disconnectEveryone(stored) : undefined, new Map(tokens ?? []));
  }

  onConnect(connection: Connection): void {
    if (!isValidRoomCode(this.name)) connection.close(POLICY_VIOLATION, "Invalid room code");
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== "string") {
      connection.close(UNSUPPORTED_DATA, "Only JSON text messages are accepted");
      return;
    }
    await this.commit(handleMessage(this.requireSession(), connection.id, message, liveDeps));
  }

  async onClose(connection: Connection): Promise<void> {
    await this.commit(handleClose(this.requireSession(), connection.id));
  }

  async onRequest(request: Request): Promise<Response> {
    return handleExportRequest(request, this.env.EXPORT_KEY, () => this.loadVerdicts());
  }

  private requireSession(): Session {
    if (!this.session) throw new Error(`Room ${this.name} received traffic before onStart completed`);
    return this.session;
  }

  private async commit(step: SessionStep): Promise<void> {
    const changed = step.session.state !== this.session?.state;
    const tokensChanged = step.session.tokenByPlayer !== this.session?.tokenByPlayer;
    this.session = step.session;
    for (const outbound of step.outbound) this.deliver(outbound);
    const writes: Promise<void>[] = step.outbound.flatMap((o) =>
      o.kind === "persist_verdict" ? [this.ctx.storage.put(verdictKey(o.sequence), o.record)] : [],
    );
    if (changed) writes.push(this.ctx.storage.put(STATE_KEY, step.session.state));
    if (tokensChanged) writes.push(this.ctx.storage.put(TOKENS_KEY, [...step.session.tokenByPlayer]));
    await Promise.all(writes);
  }

  private deliver(outbound: Outbound): void {
    if (outbound.kind !== "send") return;
    this.getConnection(outbound.connectionId)?.send(JSON.stringify(outbound.message));
  }

  private async loadVerdicts(): Promise<VerdictRecord[]> {
    const stored = await this.ctx.storage.list({ prefix: VERDICT_PREFIX });
    return [...stored.values()].map((value) => VerdictRecord.parse(value));
  }
}

const rejectInvalidRoom = (_request: Request, lobby: { name: string }): Response | undefined =>
  isValidRoomCode(lobby.name) ? undefined : new Response("Room code must be 4 uppercase letters", { status: 400 });

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const routed = await routePartykitRequest(request, env, {
      onBeforeConnect: rejectInvalidRoom,
      onBeforeRequest: rejectInvalidRoom,
    });
    return routed ?? new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
