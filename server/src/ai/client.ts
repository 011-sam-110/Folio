import { config } from '../config.js';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
};

export class AiError extends Error {
  constructor(message: string, public attempts: Array<{ model: string; error: string }>) {
    super(message);
  }
}

/** Upper bound on note text handed to the LLM. Beyond this a large note can blow past a
 *  fallback model's context window on every attempt, hanging for minutes before failing. */
export const AI_MAX_CHARS = 24_000;

/** Truncate note content sent to the model, appending a visible marker so the model (and
 *  anyone debugging) knows the tail was cut. Safe on any string. */
export function capForAi(text: string, max = AI_MAX_CHARS): string {
  if (!text) return text;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated]`;
}

async function callOnce(model: string, messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; json?: boolean }): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.ai.timeoutMs);
  try {
    const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.4,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: ctrl.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    const parsed = JSON.parse(body);
    if (parsed.error) throw new Error(String(parsed.error.message ?? 'gateway error').slice(0, 300));
    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('empty completion');
    return content;
  } finally {
    clearTimeout(t);
  }
}

const RATE_LIMIT_RE = /\b429\b|rate.?limit|models exhausted|quota/i;
const RATE_LIMIT_RETRY_DELAY_MS = Number(process.env.FOLIO_AI_RATELIMIT_RETRY_MS ?? 25_000);

/**
 * Chat with model fallback: tries each pinned model in order until one succeeds.
 * The gateway's 'auto' router can pick dead/weak providers, so we never use it.
 * If EVERY model failed with a rate-limit-class error (free-tier providers throttle in
 * bursts), wait once and re-run the whole chain — per-minute limits usually clear.
 */
export async function chat(messages: ChatMessage[], opts: { vision?: boolean; maxTokens?: number; temperature?: number; json?: boolean } = {}): Promise<{ text: string; model: string }> {
  const models = opts.vision ? config.ai.visionModels : config.ai.textModels;

  const runChain = async (): Promise<{ text: string; model: string } | Array<{ model: string; error: string }>> => {
    const attempts: Array<{ model: string; error: string }> = [];
    for (const model of models) {
      try {
        const text = await callOnce(model, messages, opts);
        return { text, model };
      } catch (e) {
        attempts.push({ model, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return attempts;
  };

  let result = await runChain();
  if (Array.isArray(result)) {
    const allRateLimited = result.every(a => RATE_LIMIT_RE.test(a.error));
    if (allRateLimited && RATE_LIMIT_RETRY_DELAY_MS > 0) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_RETRY_DELAY_MS));
      result = await runChain();
    }
  }
  if (Array.isArray(result)) {
    throw new AiError(`All AI models failed (${result.map(a => a.model).join(', ')})`, result);
  }
  return result;
}

/** Extract a JSON object from a completion that may wrap it in prose or code fences. */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const startArr = candidate.indexOf('[');
  const s = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
  if (s === -1) throw new Error('no JSON found in AI response');
  const open = candidate[s];
  const close = open === '{' ? '}' : ']';
  const e = candidate.lastIndexOf(close);
  if (e <= s) throw new Error('unbalanced JSON in AI response');
  return JSON.parse(candidate.slice(s, e + 1)) as T;
}

export async function aiHealth(): Promise<{ ok: boolean; model?: string; error?: string }> {
  try {
    const { model } = await chat([{ role: 'user', content: 'Reply with exactly: OK' }], { maxTokens: 5, temperature: 0 });
    return { ok: true, model };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
