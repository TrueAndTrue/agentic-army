/**
 * The chat session — one long-lived commanding process, many turns.
 *
 * ```
 * ☆ YOU (a terminal)
 *  │  types
 *  ▼
 * ◆ COL·COMMANDER   claude, duplex, TodoWrite only, one persistent session
 *  │  asks for an objective
 *  ▼
 * (a human keystroke)
 *  │
 *  ▼
 * ◇ CPT·ENGINEER ──▶ ◇ CPT·INSPECTOR   the same gate `army campaign` runs
 *  │
 *  └─ capped result ──▶ back into the commander's context as ONE JSON envelope
 * ```
 *
 * Pipes only. The commander is `claude -p --input-format stream-json` exactly as every other
 * soldier is, so there is no PTY anywhere in this path and Windows stays a target.
 *
 * ## The one property this file owns
 *
 * **A dispatch proposal survives only out of a turn whose authority is the human's.**
 *
 * `runTurn` is the only function that ever holds both a parsed directive and a turn, and it
 * DELETES the directive — does not merely decline to return it — when the turn it answered
 * carried session authority. So `dispatchResultTurn` does not return a proposal because there is
 * no proposal in the object it returns, rather than because its declared type omits one. A cast
 * cannot recover a value that was never put there.
 *
 * Its scope, stated plainly: this stops a subordinate's report from being answered with a
 * dispatch. It does NOT stop a model from being talked into proposing something silly on a human
 * turn — nothing at this layer can, which is why the objective is printed and confirmed by a
 * keystroke one layer up in `src/command/chat.ts`.
 *
 * **The same sentence, with `scoutProposal` substituted, is also true.** Phase 1 lets the
 * commander ask for a `CPT·SCOUT`, which is a second thing a reply can request and therefore a
 * second thing this gate has to hold for. Both are deleted on the same branch of the same
 * function, and both are absent from the object `dispatchResultTurn` and `scoutFindingTurn`
 * return. The recce half is the one worth watching: a scout is sent precisely because nobody knows
 * enough to dispatch, so the turn on which its finding arrives is the turn a model most wants to
 * start work on — and the human has not typed anything since they approved a question.
 *
 * ## Interrupt
 *
 * Claude's interrupt is a stdin control message, not a signal. The soldier survives it and
 * answers the next turn, which is what makes Ctrl-C mean "stop this answer" rather than "end this
 * conversation". `interrupt()` is a no-op when nothing is in flight, deliberately: an interrupt
 * with no turn running is acknowledged by the CLI with a bare receipt and no result, and asking
 * for one anyway is how a stale flag ends up misfiling the NEXT clean turn.
 */

import type {
  CloseResult,
  HarnessAdapter,
  Soldier,
  SoldierEvent,
  SoldierSpec,
  SoldierStatus,
} from '../contracts/harness.ts';

import type {
  DispatchOutcomeFacts,
  DispatchRequest,
  ScoutOutcomeFacts,
  ScoutRequest,
  TurnKind,
} from './protocol.ts';
import {
  TURN_AUTHORITY,
  parseDispatchDirective,
  parseScoutDirective,
  renderDispatchDeclined,
  renderDispatchResult,
  renderHumanTurn,
  renderScoutDeclined,
  renderScoutFinding,
  renderStandingOrdersTurn,
} from './protocol.ts';

export interface ChatSessionDeps {
  adapter: HarnessAdapter;
  spec: SoldierSpec;
  /**
   * Assistant text, as it arrives. This is the live half of the duplex — it is called from the
   * stream pump, not after the turn, so a slow answer appears a sentence at a time.
   */
  onText?: (chunk: string) => void;
  /** Every normalised event. The caller tees this to `stream.jsonl`. */
  onEvent?: (event: SoldierEvent) => void;
  /**
   * The commander's stream ended and this process never asked it to — the child died, or closed
   * its own stdout. NOT fired for a `close()` this session initiated, because a deliberate
   * shutdown is not news. Fired after any pending turn has been settled, so a caller reacting to
   * it observes the turn's error result, not a still-busy session. Exceptions are swallowed for
   * the same reason `onEvent`'s are: the pump must reach its end whatever a listener does.
   *
   * This callback is why a chat no longer sits at a live prompt over a dead commander: without
   * it, a child that exited while the loop was parked on `nextLine` had no way to wake anyone —
   * the field report was a session that looked healthy until the next input went nowhere.
   */
  onEnded?: () => void;
}

/** What one turn produced. There is no `dispatch` field here, and that absence is deliberate. */
export interface TurnResult {
  kind: TurnKind;
  text: string;
  status: SoldierStatus;
  /** True when this process asked the soldier to stop mid-turn. */
  interrupted: boolean;
  /** SESSION-CUMULATIVE on claude — the last reported value, never a sum. */
  costUsd: number | null;
  /**
   * Dispatch blocks that were seen and not honoured, each with why. Populated for a malformed
   * request, for two requests in one reply, and — the interesting one — for a well-formed request
   * that arrived in answer to something other than a human.
   */
  refusals: string[];
  /** Adapter-level errors, for an archive that stays readable when nothing else survived. */
  errors: string[];
}

/** A human turn, which is the only kind that can carry a proposal out. */
export interface HumanTurnResult extends TurnResult {
  proposal: DispatchRequest | null;
  /**
   * A recce the commander asked for, on the same terms as `proposal`.
   *
   * Deleted, not merely undeclared, on every turn whose authority is not the human's — see
   * `runTurn`. A scout reads the repository and the network, and "the report I just read asked me
   * to go and look at something" is precisely the route the authority gate exists to close.
   */
  scoutProposal: ScoutRequest | null;
}

interface PendingTurn {
  chunks: string[];
  errors: string[];
  interrupted: boolean;
  settle: (value: { status: SoldierStatus; costUsd: number | null }) => void;
}

export class ChatSession {
  readonly spec: SoldierSpec;

  private readonly deps: ChatSessionDeps;
  private soldier: Soldier | null = null;
  private pump: Promise<void> | null = null;
  private pending: PendingTurn | null = null;
  private lastCostUsd: number | null = null;
  private streamEnded = false;
  private closeResult: CloseResult | null = null;
  private turnCount = 0;
  /** Set the moment `close()` is asked for, so the pump can tell a shutdown from a death. */
  private closing = false;
  /**
   * The most recent adapter-level error, kept even when NO turn is pending. The per-turn `errors`
   * array cannot hold the one that matters most here: a child that dies while the session is idle
   * emits its `claude exited with code N` synthetic with no turn to attach it to, and dropping it
   * left the death diagnosis with nothing to say.
   */
  private lastErrorMessage: string | null = null;

  constructor(deps: ChatSessionDeps) {
    this.deps = deps;
    this.spec = deps.spec;
  }

  /** True while a turn is in flight — what `interrupt()` and the Ctrl-C handler key off. */
  get busy(): boolean {
    return this.pending !== null;
  }

  get turns(): number {
    return this.turnCount;
  }

  get costUsd(): number | null {
    return this.lastCostUsd;
  }

  /** True once the commander's stream is over — no further turn can ever run. */
  get ended(): boolean {
    return this.streamEnded || this.closeResult !== null;
  }

  /** The last adapter error, for the caller's one-line account of a commander that died. */
  get lastError(): string | null {
    return this.lastErrorMessage;
  }

  async open(): Promise<void> {
    if (this.soldier !== null) throw new Error('this chat session is already open');
    const soldier = await this.deps.adapter.spawn(this.spec);
    this.soldier = soldier;
    this.pump = (async (): Promise<void> => {
      for await (const event of soldier.stream()) {
        // An archive write that throws must never kill a live conversation: the session is the
        // expensive thing and the index is rebuildable from the file this is trying to write.
        try {
          this.deps.onEvent?.(event);
        } catch {
          /* the archive said no; the turn continues */
        }
        this.consume(event);
      }
      this.streamEnded = true;
      // A soldier that died mid-turn must not leave a caller parked forever.
      this.settle('error');
      // After the settle, so the listener sees a session that is ended AND idle. Only for a death:
      // a stream that ended because `close()` asked it to is the caller's own doing.
      if (!this.closing) {
        try {
          this.deps.onEnded?.();
        } catch {
          /* a listener's throw must not turn the pump's end into an unhandled rejection */
        }
      }
    })();
  }

  private consume(event: SoldierEvent): void {
    const turn = this.pending;
    if (event.type === 'assistant_text') {
      if (turn !== null) turn.chunks.push(event.text);
      this.deps.onText?.(event.text);
      return;
    }
    if (event.type === 'error') {
      this.lastErrorMessage = event.message;
      if (turn !== null) turn.errors.push(event.message);
      return;
    }
    if (event.type === 'result') {
      if (event.costUsd !== undefined) this.lastCostUsd = event.costUsd;
      this.settle(event.status);
    }
  }

  private settle(status: SoldierStatus): void {
    const turn = this.pending;
    if (turn === null) return;
    this.pending = null;
    turn.settle({ status, costUsd: this.lastCostUsd });
  }

  /**
   * Push one turn and wait for its `result`.
   *
   * ## THE GATE
   *
   * This is the only place a parsed directive and a turn exist in the same scope, and the
   * directive does not leave it unless `TURN_AUTHORITY[kind]` is `'human'`. `proposal` is set to
   * `null` — the value is discarded, not hidden behind a narrower return type — so a well-formed
   * dispatch block written in answer to a subordinate's report is unreachable rather than
   * unmentioned. The refusal is recorded, because a mechanism nobody can see fire is a mechanism
   * nobody maintains.
   */
  private async runTurn(
    payload: string,
    kind: TurnKind,
  ): Promise<
    TurnResult & { proposal: DispatchRequest | null; scoutProposal: ScoutRequest | null }
  > {
    const soldier = this.soldier;
    if (soldier === null) throw new Error('this chat session has not been opened');
    if (this.streamEnded || this.closeResult !== null) {
      throw new Error('this chat session has ended; its commander is no longer running');
    }
    if (this.pending !== null) throw new Error('a turn is already in flight');

    this.turnCount += 1;
    const turn: PendingTurn = {
      chunks: [],
      errors: [],
      interrupted: false,
      settle: () => {
        /* replaced below */
      },
    };
    const settled = new Promise<{ status: SoldierStatus; costUsd: number | null }>((resolve) => {
      turn.settle = resolve;
    });
    this.pending = turn;

    try {
      await soldier.send(payload);
    } catch (error) {
      this.pending = null;
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind,
        text: '',
        status: 'error',
        interrupted: false,
        costUsd: this.lastCostUsd,
        refusals: [],
        errors: [`send failed: ${message}`],
        proposal: null,
        scoutProposal: null,
      };
    }

    const outcome = await settled;
    const text = turn.chunks.join('');
    const refusals: string[] = [];
    let proposal: DispatchRequest | null = null;
    let scoutProposal: ScoutRequest | null = null;

    const parsed = parseDispatchDirective(text);
    if (parsed.ok) {
      if (TURN_AUTHORITY[kind] === 'human') {
        proposal = parsed.request;
      } else {
        // `JSON.stringify` is not a neutraliser and was being used as one. It escapes C0 — so the
        // ESC that starts a CSI sequence does come out as `` — and leaves U+009B (the C1
        // form of CSI, which a terminal obeys on its own) and U+202E (a bidi override, which
        // reverses the rendered order of everything after it) exactly as they were. The quoting
        // here is for readability; `parseDispatchDirective` is what makes the string safe.
        refusals.push(
          `a dispatch block was written in answer to a \`${kind}\` turn and was DROPPED. New ` +
            'intent comes from the Commander typing, never from a report a subordinate wrote. ' +
            `The objective it named was: ${JSON.stringify(parsed.request.objective.slice(0, 160))}`,
        );
      }
    } else if (parsed.reason !== 'no dispatch was requested') {
      refusals.push(parsed.reason);
    }

    // THE SAME GATE, over the second directive. Written out rather than folded into a loop over
    // two parsers: the refusal sentences differ, the values are differently typed, and a gate
    // whose two halves are one generic call is a gate somebody can widen by editing the generic.
    const scouted = parseScoutDirective(text);
    if (scouted.ok) {
      if (TURN_AUTHORITY[kind] === 'human') {
        scoutProposal = scouted.request;
      } else {
        // Neutralised by `parseScoutDirective`, not by the `JSON.stringify` below — see the
        // dispatch half above for what that call does and does not escape.
        refusals.push(
          `a recce block was written in answer to a \`${kind}\` turn and was DROPPED. A scout is ` +
            'raised because the Commander asked for one, never because a report suggested it. ' +
            `The question it named was: ${JSON.stringify(scouted.request.question.slice(0, 160))}`,
        );
      }
    } else if (scouted.reason !== 'no recce was requested') {
      refusals.push(scouted.reason);
    }

    return {
      kind,
      text,
      status: outcome.status,
      interrupted: turn.interrupted,
      costUsd: outcome.costUsd,
      refusals,
      errors: turn.errors,
      proposal,
      scoutProposal,
    };
  }

  /** The opening turn. Carries session authority, so its reply cannot dispatch. */
  async openingTurn(orders: string): Promise<TurnResult> {
    const { proposal: _dropped, scoutProposal: _alsoDropped, ...turn } = await this.runTurn(
      renderStandingOrdersTurn(orders),
      'standing-orders',
    );
    return turn;
  }

  /** A turn the human typed. The only kind that can produce a proposal. */
  async humanTurn(text: string): Promise<HumanTurnResult> {
    return this.runTurn(renderHumanTurn(text), 'human');
  }

  /**
   * Hand a finished dispatch back to the commander.
   *
   * Takes `DispatchOutcomeFacts`, which is a whitelist — see `protocol.ts`. There is no overload
   * that accepts a campaign result, so the classification of what crosses happens once, in a type,
   * rather than at every call site.
   */
  async dispatchResultTurn(facts: DispatchOutcomeFacts): Promise<TurnResult> {
    const { proposal: _dropped, scoutProposal: _alsoDropped, ...turn } = await this.runTurn(
      renderDispatchResult(facts),
      'dispatch-result',
    );
    return turn;
  }

  /** Tell the commander its proposal was not approved. */
  async dispatchDeclinedTurn(objective: string, reason: string): Promise<TurnResult> {
    const { proposal: _dropped, scoutProposal: _alsoDropped, ...turn } = await this.runTurn(
      renderDispatchDeclined(objective, reason),
      'dispatch-declined',
    );
    return turn;
  }

  /**
   * Hand a scout's finding back to the commander.
   *
   * Takes `ScoutOutcomeFacts`, which is a whitelist — see `protocol.ts`. There is no overload that
   * accepts a `RecceOutcome` or a `ScoutRun`, so what crosses is classified once, in a type.
   *
   * Session authority, so a commander that reads a finding and immediately writes a dispatch block
   * has its proposal DELETED and the refusal recorded. That is the interesting case rather than an
   * edge: a scout is sent precisely when nobody knows enough to dispatch, so the turn after one
   * comes back is exactly the turn on which a model most wants to start work — and the human has
   * not typed anything since they approved a question.
   */
  async scoutFindingTurn(facts: ScoutOutcomeFacts): Promise<TurnResult> {
    const { proposal: _dropped, scoutProposal: _alsoDropped, ...turn } = await this.runTurn(
      renderScoutFinding(facts),
      'scout-finding',
    );
    return turn;
  }

  /** Tell the commander its recce did not happen. `reason` is this process's own words. */
  async scoutDeclinedTurn(question: string, reason: string): Promise<TurnResult> {
    const { proposal: _dropped, scoutProposal: _alsoDropped, ...turn } = await this.runTurn(
      renderScoutDeclined(question, reason),
      'scout-declined',
    );
    return turn;
  }

  /**
   * Barge in on the turn in flight.
   *
   * Returns false when there was nothing to stop. Callers use that to decide whether a Ctrl-C
   * meant "stop this answer" or "I want out", which is the difference between one keystroke and
   * two.
   */
  async interrupt(): Promise<boolean> {
    const turn = this.pending;
    const soldier = this.soldier;
    if (turn === null || soldier === null) return false;
    turn.interrupted = true;
    try {
      await soldier.interrupt();
      return true;
    } catch {
      // The soldier refused or never advertised the capability. The turn keeps running; saying
      // it was stopped when it was not is worse than reporting the failure.
      turn.interrupted = false;
      return false;
    }
  }

  /** Close stdin and wait for exit. Idempotent. */
  async close(): Promise<CloseResult> {
    if (this.closeResult !== null) return this.closeResult;
    // Before the soldier is touched, so the pump — which may end at any point after stdin closes
    // — can already tell this shutdown was asked for and keep `onEnded` quiet.
    this.closing = true;
    const soldier = this.soldier;
    if (soldier === null) {
      this.closeResult = { exitCode: null, status: 'error' };
      return this.closeResult;
    }
    const result = await soldier.close();
    await this.pump;
    this.closeResult = result;
    return result;
  }
}
