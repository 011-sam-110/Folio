import crypto from 'node:crypto';
import { config, IS_SERVERLESS } from '../config.js';
import { checkUserSuppliedUrl } from '../lib/publicHost.js';

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
 * The contract, stated plainly because it is easy to get wrong: a BARE key is assumed to
 * belong to the same gateway this deployment already targets, so it inherits both the
 * operator's base URL and the operator's tuned model chain. A user bringing a key from a
 * DIFFERENT provider must also give the endpoint, and usually the model names too - a
 * personal OpenAI key called with `gemini-2.5-flash` is a 404 every time.
 *
 * `models` used to be described here and not implemented: the chains were always the
 * operator's. That made "any OpenAI-compatible provider" true only for providers that
 * happen to serve the operator's model names.
 */
export function userKeyCreds(apiKey: string, baseUrl?: string | null, models?: string[] | null): AiCreds {
  const pinned = (models ?? []).map(m => m.trim()).filter(Boolean);
  return {
    baseUrl: (baseUrl ?? config.ai.baseUrl).replace(/\/$/, ''),
    apiKey,
    textModels: pinned.length ? pinned : config.ai.textModels,
    // One list covers both chains: a user who names their models is naming what their
    // provider serves, and we have no way to know which of them can see an image.
    visionModels: pinned.length ? pinned : config.ai.visionModels,
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

async function callOnce(model: string, messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number; json?: boolean; timeoutMs?: number }, creds: AiCreds): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? config.ai.timeoutMs);
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
 * bursts), wait once and re-run the whole chain - per-minute limits usually clear.
 *
 * `retryOnRateLimit: false` opts out of that wait. The health probe uses it: a probe that
 * sleeps 25s and re-runs the chain turns "is AI available?" into a minutes-long question,
 * and the honest answer for a throttled pool is "not right now" anyway.
 */
export async function chat(messages: ChatMessage[], opts: { vision?: boolean; maxTokens?: number; temperature?: number; json?: boolean; creds?: AiCreds; timeoutMs?: number; retryOnRateLimit?: boolean } = {}): Promise<{ text: string; model: string }> {
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
    if (opts.retryOnRateLimit !== false && allRateLimited && RATE_LIMIT_RETRY_DELAY_MS > 0) {
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

/** Whose credential a health answer describes. */
export type AiCredSource = 'shared-pool' | 'own-key';

/**
 * Why AI is unavailable, when it is.
 *
 * `not_configured` means no call was made because none could have worked - a missing or
 * unreachable-by-construction setting. `unreachable` means the gateway was actually asked
 * and did not answer usefully. Keeping them apart matters: the first is fixed by editing
 * an environment variable, the second by waiting or by looking upstream, and a UI that
 * says "try again" for the first sends the reader in a circle forever.
 */
export type AiUnavailableReason = 'not_configured' | 'unreachable';

export type AiHealthResult = {
  ok: boolean;
  model?: string;
  error?: string;
  source?: AiCredSource;
  reason?: AiUnavailableReason;
  /** One sentence naming what would fix it. Safe to render verbatim - never contains a key. */
  hint?: string;
};

/**
 * Can this credential set work at all, before a call is spent finding out?
 *
 * Two conditions are configuration rather than outage, and both produce a connect-time
 * error whose text ("fetch failed") reads like an upstream problem. That mis-diagnosis is
 * what kept the production breakage invisible: the deployed default base URL is
 * `http://localhost:3001/v1`, which a serverless function can never reach, and every AI
 * affordance simply vanished rather than saying so.
 *
 * `serverless` is a parameter rather than a direct read of IS_SERVERLESS so the rule can be
 * tested both ways: a loopback gateway is the intended setup for local and self-hosted runs
 * and a guaranteed failure on a platform host.
 */
export function credentialProblem(
  creds: AiCreds,
  source: AiCredSource,
  serverless: boolean = IS_SERVERLESS,
): { reason: AiUnavailableReason; error: string; hint: string } | null {
  if (!creds.apiKey) {
    return {
      reason: 'not_configured',
      error: 'This deployment has no AI gateway key configured.',
      hint: 'The operator needs to set FOLIO_AI_KEY. You can use AI straight away by adding your own API key and endpoint in AI settings.',
    };
  }

  // checkUserSuppliedUrl is the same public-address rule applied to a user's saved
  // endpoint. Reused here rather than duplicated: "an address only this machine can reach"
  // is exactly the question, and it already handles loopback, private ranges, link-local
  // and .local/.internal names.
  if (serverless && !checkUserSuppliedUrl(creds.baseUrl).ok) {
    const operatorDefault = creds.baseUrl === config.ai.baseUrl;
    return {
      reason: 'not_configured',
      error: `The AI gateway address (${creds.baseUrl}) cannot be reached from this deployment.`,
      hint:
        source === 'own-key' && operatorDefault
          ? 'Your key has no endpoint saved, so it falls back to this deployment gateway address, which is not reachable. Add a Custom endpoint in AI settings.'
          : source === 'own-key'
            ? 'The Custom endpoint saved in AI settings must be a public address.'
            : 'The operator needs to point FOLIO_AI_BASE_URL at a publicly reachable gateway. You can use AI straight away by adding your own API key and endpoint in AI settings.',
    };
  }

  return null;
}

/**
 * Cached health, keyed by the credential it describes.
 *
 * The probe is a real completion and the client probes on first paint, so without a cache
 * every page load anyone makes spends one call. The cache used to be a single slot, which
 * was correct only while the answer was the same for everyone. It is not: a user on their
 * own key is asking about their own endpoint, and a shared slot would both hand them the
 * operator's verdict and leak theirs to the next caller. The fingerprint below is the
 * credential, so two users on the same credential still share one probe.
 *
 * A failure is cached far more briefly than a success: when a gateway is down the useful
 * behaviour is to notice it coming back quickly, and a failed probe costs nothing upstream.
 */
const HEALTH_TTL_OK_MS = 60_000;
const HEALTH_TTL_BAD_MS = 10_000;
/** Bounded so a stream of one-off user endpoints cannot grow the map without limit. */
const HEALTH_CACHE_MAX = 500;
/**
 * Shorter than a real completion's budget. A probe is one five-token reply, and the client
 * blocks its AI controls on the answer - waiting the full 90s per model to learn that a
 * gateway is dead is the same as no answer at all.
 */
const HEALTH_TIMEOUT_MS = Number(process.env.FOLIO_AI_HEALTH_TIMEOUT_MS ?? 20_000);

const healthCache = new Map<string, { at: number; result: AiHealthResult }>();
const healthInFlight = new Map<string, Promise<AiHealthResult>>();

/** Hashed, not stored raw: this key lives in a long-lived map and includes an API key. */
function credsFingerprint(creds: AiCreds): string {
  return crypto
    .createHash('sha256')
    .update([creds.baseUrl, creds.apiKey, creds.textModels.join(',')].join('\u0000'))
    .digest('base64url');
}

/**
 * Forget the cached verdict for one credential.
 *
 * Called when a user changes or removes their key, so the app does not keep reporting a
 * verdict about a credential that no longer exists. Scoped to the one entry rather than
 * clearing the map, so one person editing their settings does not make every other user on
 * the instance re-probe (which, for the shared pool, costs a real call).
 */
export function forgetAiHealth(creds: AiCreds): void {
  const key = credsFingerprint(creds);
  healthCache.delete(key);
  healthInFlight.delete(key);
}

/** Drop every cached verdict. Test helper. */
export function _resetAiHealthCache(): void {
  healthCache.clear();
  healthInFlight.clear();
}

/**
 * Is AI available for THIS credential?
 *
 * Defaults to the shared pool so existing callers are unchanged, but the caller that
 * matters passes the requesting user's own credential. Answering only for the shared pool
 * is the bug this signature exists to make impossible: a user with a working personal key
 * was told AI was offline because the operator's gateway was unreachable, and every AI
 * control in the app hid itself on that answer.
 */
export async function aiHealth(
  creds: AiCreds = sharedPoolCreds(),
  source: AiCredSource = 'shared-pool',
  opts: { force?: boolean } = {},
): Promise<AiHealthResult> {
  const problem = credentialProblem(creds, source);
  if (problem) return { ok: false, source, ...problem };

  const key = credsFingerprint(creds);

  if (!opts.force) {
    const hit = healthCache.get(key);
    if (hit && Date.now() - hit.at < (hit.result.ok ? HEALTH_TTL_OK_MS : HEALTH_TTL_BAD_MS)) {
      return hit.result;
    }
    // De-duplicate concurrent probes. A cold instance can take several simultaneous
    // requests before the first result lands, and without this each starts its own call.
    const running = healthInFlight.get(key);
    if (running) return running;
  }

  const run = (async (): Promise<AiHealthResult> => {
    try {
      const { model } = await chat([{ role: 'user', content: 'Reply with exactly: OK' }], {
        maxTokens: 5,
        temperature: 0,
        creds,
        timeoutMs: HEALTH_TIMEOUT_MS,
        retryOnRateLimit: false,
      });
      return { ok: true, model, source };
    } catch (e) {
      return {
        ok: false,
        source,
        reason: 'unreachable',
        error: e instanceof Error ? e.message : String(e),
        hint:
          source === 'own-key'
            ? 'Check the API key, Custom endpoint and Models saved in AI settings - the endpoint answered with an error or not at all.'
            : 'The shared AI gateway is not answering. Add your own API key in AI settings to keep using AI in the meantime.',
      };
    }
  })().then(
    (result) => {
      if (healthCache.size >= HEALTH_CACHE_MAX) healthCache.clear();
      healthCache.set(key, { at: Date.now(), result });
      healthInFlight.delete(key);
      return result;
    },
    (err: unknown) => {
      healthInFlight.delete(key);
      throw err;
    },
  );

  healthInFlight.set(key, run);
  return run;
}
