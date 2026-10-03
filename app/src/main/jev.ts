/**
 * The TypeSafe client. Jev takes `state` and typed questions and returns a probability for each
 * answer; it generates no text. See https://docs.typesafe.ai/api.md.
 */

import type { DecideConfig, Judgment, Settings } from '../shared/types.ts';

export type JevQuestion =
  | { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
  | { type: 'score'; instructions: unknown; criteria: unknown[] };

export interface JevAnswer {
  type: 'noul' | 'choice' | 'score';
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  inputTokens: number;
  latencyMs: number;
}

export type JevFetch = typeof fetch;

export class JevError extends Error {
  readonly status: number | null;
  /** No key, or TypeSafe refused it: a setup problem to fix, never an answer to route on. */
  readonly setup: boolean;
  constructor(message: string, status: number | null, setup = false) {
    super(message);
    this.status = status;
    this.setup = setup;
  }
}

/** The error text TypeSafe sent, without the JSON around it. */
function reason(text: string): string {
  try {
    // FastAPI nests it: {"detail": {"error_type": ..., "message": "Cannot authenticate ..."}}.
    let said: unknown = JSON.parse(text);
    for (let i = 0; i < 3 && typeof said === 'object' && said !== null; i += 1) {
      const o = said as { error?: unknown; message?: unknown; detail?: unknown };
      said = o.message ?? o.detail ?? o.error;
    }
    if (typeof said === 'string') return said.replace(/\.$/, '');
  } catch {
    /* not JSON: use it as it is */
  }
  return text.trim().slice(0, 200);
}

const TIMEOUT_MS = 20_000;

export async function askJev(
  settings: Settings['typesafe'],
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
  fetchImpl: JevFetch = fetch,
): Promise<JevResponse> {
  if (settings.apiKey.trim() === '') {
    throw new JevError('There is no TypeSafe API key yet. Jev needs one; add it in Settings under Jev.', null, true);
  }
  const started = Date.now();
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetchImpl(`${settings.baseUrl.replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.model, state, questions }),
      signal: combined,
    });
  } catch (err) {
    if (timeout.aborted) throw new JevError(`Jev did not answer within ${String(TIMEOUT_MS / 1000)} s.`, null);
    throw new JevError(`Could not reach TypeSafe: ${err instanceof Error ? err.message : String(err)}`, null);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    if (response.status === 401 || response.status === 403) {
      throw new JevError(`TypeSafe refused the API key (${reason(text) || response.statusText}). Paste a working key in Settings under Jev.`, response.status, true);
    }
    throw new JevError(`TypeSafe answered ${String(response.status)}: ${reason(text) || response.statusText}.`, response.status);
  }
  const parsed = (await response.json()) as { model?: string; answers?: Record<string, JevAnswer>; usage?: { input_tokens?: number } };
  return {
    model: parsed.model ?? settings.model,
    answers: parsed.answers ?? {},
    inputTokens: parsed.usage?.input_tokens ?? 0,
    latencyMs: Date.now() - started,
  };
}

/** The question a Decide node sends, in the shape its mode needs. */
export function decideQuestion(config: DecideConfig, question: string): JevQuestion {
  switch (config.mode) {
    case 'yesno':
      return { type: 'noul', instructions: question };
    case 'choice':
      return {
        type: 'choice',
        instructions: question,
        criteria: Object.fromEntries(config.options.map((o) => [o.key, o.description.trim() === '' ? null : o.description])),
      };
    case 'score':
      return { type: 'score', instructions: question, criteria: config.levels };
  }
}

/** Turn Jev's answer into the handle a Decide node leaves by. */
export function judgmentFrom(config: DecideConfig, answer: JevAnswer | undefined, meta: { model: string; latencyMs: number }): Judgment {
  if (answer === undefined) throw new JevError('Jev returned no answer for the question.', null);
  switch (config.mode) {
    case 'yesno': {
      const p = answer.noul;
      if (typeof p !== 'number') throw new JevError('Jev returned a yes/no answer without a probability.', null);
      return { mode: 'yesno', answer: p >= config.threshold ? 'yes' : 'no', probabilities: { yes: p, no: 1 - p }, confidence: Math.abs(p - 0.5) * 2, value: p, ...meta };
    }
    case 'choice': {
      if (typeof answer.choice !== 'string') throw new JevError('Jev returned a choice answer without a choice.', null);
      return { mode: 'choice', answer: answer.choice, probabilities: answer.probabilities ?? {}, confidence: answer.confidence ?? 0, ...meta };
    }
    case 'score': {
      if (typeof answer.score !== 'number') throw new JevError('Jev returned a score answer without a score.', null);
      return {
        mode: 'score',
        answer: answer.score >= config.cut ? 'high' : 'low',
        probabilities: answer.probabilities ?? {},
        confidence: answer.confidence ?? 0,
        value: answer.score,
        ...meta,
      };
    }
  }
}

export async function judge(
  settings: Settings['typesafe'],
  config: DecideConfig,
  question: string,
  state: string,
  signal?: AbortSignal,
  fetchImpl?: JevFetch,
): Promise<Judgment> {
  const res = await askJev(settings, state, { q: decideQuestion(config, question) }, signal, fetchImpl);
  return judgmentFrom(config, res.answers['q'], { model: res.model, latencyMs: res.latencyMs });
}
