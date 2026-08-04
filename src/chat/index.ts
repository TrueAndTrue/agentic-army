/**
 * `army chat` — a live conversation with a commanding officer that can dispatch real work.
 *
 * The pieces, and why they are separate files:
 *
 * | file          | holds |
 * |---------------|-------|
 * | `protocol.ts` | the envelope encoding and the dispatch-request shape — pure, no process |
 * | `orders.ts`   | the commander's standing orders — pure, a string in and a string out |
 * | `session.ts`  | one duplex claude process and the turn machinery, including the interrupt |
 * | `dispatch.ts` | the bridge to `runCampaign`, and the whitelist of what comes back |
 * | `io.ts`       | the terminal seam, so nothing here ever patches a global |
 * | `run.ts`      | the loop, and the keystroke that authorises a dispatch |
 *
 * The split is not tidiness. `protocol.ts` and `orders.ts` are pure precisely so the two
 * properties that matter — what can reach the commander, and what can leave it — are testable as
 * functions rather than inferred from an end-to-end run that spawns processes.
 */

export * from './dispatch.ts';
export * from './io.ts';
export * from './orders.ts';
export * from './protocol.ts';
export * from './run.ts';
export * from './session.ts';
