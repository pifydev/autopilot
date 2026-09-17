/**
 * A stub pi host, enough to drive the extension's own wiring in a test.
 *
 * The src/ helpers (decide, summarizeTurn) prove each verdict in isolation; this
 * proves the verdicts are actually *reached* — that an errored agent_end, a
 * blocked token, or a dialog closing on a parked pilot lands where the loop can
 * act on it. That wiring is exactly what a pure-helper test cannot see.
 *
 * `hasUI` defaults to true because arming is interactive-only (a headless run
 * never self-drives). `idle` backs ctx.isIdle(); flip it to model a dialog that
 * closes while a turn is still running.
 */

export interface SentMessage {
  message: { customType?: string; content?: string; display?: boolean };
  options: { triggerTurn?: boolean; deliverAs?: string };
}

export interface StubOptions {
  cwd?: string;
  hasUI?: boolean;
  /** Backs ctx.isIdle(); default true (the agent is settled). */
  idle?: boolean;
  /** When true, sendMessage rejects — models a /reload or busy handle. */
  sendThrows?: boolean;
}

export class StubHost {
  readonly commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
  readonly handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>();
  readonly notices: Array<{ message: string; level: string }> = [];
  readonly sent: SentMessage[] = [];

  idle: boolean;
  private readonly opts: StubOptions;

  constructor(opts: StubOptions = {}) {
    this.opts = opts;
    this.idle = opts.idle ?? true;
  }

  /** The `pi` object handed to the extension factory. */
  get api(): Record<string, unknown> {
    return {
      registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => {
        this.commands.set(name, spec.handler);
      },
      registerTool: () => {},
      on: (event: string, handler: (e: unknown, c: unknown) => Promise<unknown> | unknown) => {
        this.handlers.set(event, handler);
      },
      appendEntry: () => {},
      sendMessage: async (message: SentMessage["message"], options: SentMessage["options"]) => {
        if (this.opts.sendThrows) throw new Error("send failed");
        this.sent.push({ message, options });
      },
    };
  }

  /** The context handed to command handlers and event hooks. */
  get ctx(): Record<string, unknown> {
    return {
      cwd: this.opts.cwd ?? "/repo",
      hasUI: this.opts.hasUI ?? true,
      isIdle: () => this.idle,
      isProjectTrusted: () => true,
      ui: {
        notify: (message: string, level: string) => {
          this.notices.push({ message, level });
        },
        setStatus: () => {},
      },
    };
  }

  async run(command: string, args = ""): Promise<void> {
    const handler = this.commands.get(command);
    if (!handler) throw new Error(`No command /${command} registered. Have: ${[...this.commands.keys()].join(", ")}`);
    await handler(args, this.ctx);
  }

  async fire(event: string, payload: unknown = {}): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler for ${event}`);
    return handler(payload, this.ctx);
  }

  /** The text of the most recent driven nudge, or "" if none was sent. */
  get lastNudge(): string {
    return this.sent.at(-1)?.message.content ?? "";
  }
}
