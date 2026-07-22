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

/**
 * Which endpoint and credential a call should use.
 *
 * Passed per request rather than read from config inside the call, because two callers now
 * exist: the shared free-tier pool the operator funds, and a user's own saved key. Making
 * this explicit at the call site means a route cannot accidentally spend the shared budget
 * on a user who supplied their own credential, or vice versa.
 */
export interface AiCreds {
  baseUrl: string;
  apiKey: string;
  textModels: string[];
  visionModels: string[];
}

/** The operator-funded pool, used by anyone who has not saved a key of their own. */
export function sharedPoolCreds(): AiCreds {
  return {
    baseUrl: config.ai.baseUrl,
    apiKey: config.ai.apiKey,
    textModels: config.ai.textModels,
    visionModels: config.ai.visionModels,
  };
}

/**
 * Credentials for a user-supplied key.
 *
 * The model chains stay the operator's defaults unless the user also overrode the base URL.
 * A bare key almost always belongs to the same gateway the app already targets, so reusing
 * the tuned fallback chain is what the user expects. A custom endpoint is a different
 * service whose model names we cannot guess, so the caller supplies those.
 */
export function userKeyCreds(apiKey: string, baseUrl?: string | null): AiCreds {
  return {
    baseUrl: (baseUrl ?? config.ai.baseUrl).replace(/\/$/, ''),
    apiKey,
    textModels: config.ai.textModels,
    visionModels: config.ai.visionModels,
  };
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

async function callOnce(model: string, messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; json?: boolean }, creds: AiCreds): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.ai.timeoutMs);
  try {
    const res = await fetch(`${creds.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.apiKey}`,
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
export async function chat(messages: ChatMessage[], opts: { vision?: boolean; maxTokens?: number; temperature?: number; json?: boolean; creds?: AiCreds } = {}): Promise<{ text: string; model: string }> {
  const creds = opts.creds ?? sharedPoolCreds();
  const models = opts.vision ? creds.visionModels : creds.textModels;

  const runChain = async (): Promise<{ text: string; model: string } | Array<{ model: string; error: string }>> => {
    const attempts: Array<{ model: string; error: string }> = [];
    for (const model of models) {
      try {
        const text = await callOnce(model, messages, opts, creds);
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

export type AiHealthResult = { ok: boolean; model?: string; error?: string };

/**
 * Cached health, shared by every caller on this instance.
 *
 * The probe is a real completion, and the client probes on first paint, so without a cache
 * every page load anyone makes spends one call from the shared free-tier pool. At that
 * point the pool is mostly funding a status light. The answer is also the same for all
 * users — it describes the gateway, not the caller — so one probe per instance per minute
 * is all the information there is to have.
 *
 * A failure is cached far more briefly than a success: when the gateway is down the
 * useful behaviour is to notice it coming back quickly, and a failed probe costs nothing
 * on the provider side anyway.
 */
let healthCache: { at: number; result: AiHealthResult } | null = null;
let healthInFlight: Promise<AiHealthResult> | null = null;
const HEALTH_TTL_OK_MS = 60_000;
const HEALTH_TTL_BAD_MS = 10_000;

export async function aiHealth(): Promise<AiHealthResult> {
  const now = Date.now();
  if (healthCache) {
    const ttl = healthCache.result.ok ? HEALTH_TTL_OK_MS : HEALTH_TTL_BAD_MS;
    if (now - healthCache.at < ttl) return healthCache.result;
  }

  // De-duplicate concurrent probes. A cold instance can take several simultaneous requests
  // before the first result lands, and without this each one starts its own completion.
  healthInFlight ??= (async (): Promise<AiHealthResult> => {
    try {
      const { model } = await chat([{ role: 'user', content: 'Reply with exactly: OK' }], { maxTokens: 5, temperature: 0 });
      return { ok: true, model };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })().then((result) => {
    healthCache = { at: Date.now(), result };
    healthInFlight = null;
    return result;
  });

  return healthInFlight;
}
