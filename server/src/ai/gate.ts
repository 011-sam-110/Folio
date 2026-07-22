import type { NextFunction, Request, Response } from 'express';
import { userId } from '../auth/middleware.js';
import { clientIp } from '../lib/clientIp.js';
import { getUserKey } from './keys.js';
import { checkQuota, recordUsage, type QuotaVerdict } from './usage.js';
import { chat, sharedPoolCreds, userKeyCreds, type AiCreds, type AiCredSource, type ChatMessage } from './client.js';

/**
 * Decides, once per request, whose budget an AI call spends and whether it is allowed.
 *
 * Two paths exist, and keeping the choice in one place is the point: a route must not be
 * able to forget the quota check, and must not meter a user who is paying with their own
 * key. Every AI-calling route resolves a context here and then completes through it.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `aiQuotaGate`. Present on every request that reached an AI handler. */
      aiCtx?: AiContext;
    }
  }
}

export interface AiContext {
  creds: AiCreds;
  /** True when the call spends the operator-funded pool, and therefore must be metered. */
  shared: boolean;
  uid: string;
  ip: string;
}

export class QuotaExceededError extends Error {
  constructor(public verdict: QuotaVerdict) {
    super('AI monthly limit reached');
  }
}

/**
 * Resolve the caller's AI context, throwing if the shared pool is spent.
 *
 * A saved user key short-circuits the quota entirely: the call is billed to their
 * credential, so metering it would be counting someone else's money. The check is only
 * ever reached by users on the shared pool.
 */
export async function resolveAiContext(req: Request): Promise<AiContext> {
  const uid = userId(req);
  const ip = clientIp(req);

  const own = await getUserKey(uid);
  if (own) {
    return { creds: userKeyCreds(own.apiKey, own.baseUrl, own.models), shared: false, uid, ip };
  }

  const verdict = await checkQuota(uid, ip);
  if (!verdict.allowed) throw new QuotaExceededError(verdict);

  return { creds: sharedPoolCreds(), shared: true, uid, ip };
}

/**
 * Which credential a health probe should describe for this user.
 *
 * Same resolution as `resolveAiContext` minus the quota check, because a probe is a
 * question about reachability, not a request to spend. Sharing the resolution is the
 * point: if health answered for a different credential than the one the next AI call
 * would use, it would be confidently wrong - which is exactly the bug that hid every AI
 * control from users who had brought their own key.
 */
export async function resolveHealthCreds(uid: string): Promise<{ creds: AiCreds; source: AiCredSource }> {
  const own = await getUserKey(uid);
  return own
    ? { creds: userKeyCreds(own.apiKey, own.baseUrl, own.models), source: 'own-key' }
    : { creds: sharedPoolCreds(), source: 'shared-pool' };
}

/** The 429 body. Says which ceiling was hit, when it lifts, and how to get past it now. */
function quotaBody(verdict: QuotaVerdict) {
  const perIp = verdict.blockedBy === 'ip';
  return {
    error: perIp
      ? 'This network has used up its shared monthly AI allowance. Add your own API key in Settings to keep going.'
      : 'You have used your free monthly AI allowance. Add your own API key in Settings to keep going.',
    reason: 'quota_exceeded',
    blockedBy: verdict.blockedBy,
    used: perIp ? verdict.ip.used : verdict.user.used,
    limit: perIp ? verdict.ip.limit : verdict.user.limit,
    resetAt: verdict.resetAt,
  };
}

/**
 * Gate every AI route behind quota resolution.
 *
 * Mounted as middleware rather than called per handler so that adding a new AI endpoint
 * cannot accidentally ship unmetered, which is how the shared pool would quietly drain.
 */
export async function aiQuotaGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    req.aiCtx = await resolveAiContext(req);
    next();
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      res.status(429).json(quotaBody(err.verdict));
      return;
    }
    next(err);
  }
}

/**
 * Narrow `req.aiCtx` for handlers mounted behind the gate. Throws rather than falling back
 * to the shared pool, so a route mounted without the gate fails loudly instead of silently
 * spending the operator's budget unmetered. Same reasoning as `userId(req)`.
 */
export function aiCtx(req: Request): AiContext {
  if (!req.aiCtx) throw new Error('route requires aiQuotaGate middleware');
  return req.aiCtx;
}

/**
 * Run a completion against a resolved context, charging the shared pool when it applies.
 *
 * Metering happens after the completion returns, so a user is never charged for a call
 * that failed on the gateway. Multi-call flows (an import doing OCR then restructuring)
 * charge per model call, because that is what the pool actually spends.
 */
export async function complete(
  ctx: AiContext,
  messages: ChatMessage[],
  opts: { vision?: boolean; maxTokens?: number; temperature?: number; json?: boolean } = {},
): Promise<{ text: string; model: string }> {
  const result = await chat(messages, { ...opts, creds: ctx.creds });
  if (ctx.shared) await recordUsage(ctx.uid, ctx.ip);
  return result;
}
