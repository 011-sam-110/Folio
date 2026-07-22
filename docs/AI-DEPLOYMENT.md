# AI deployment runbook

How the deployed site gets working AI, and what has to be true for it to stay working.

## The problem this solves

`FOLIO_AI_BASE_URL` defaulted to `http://localhost:3001/v1`. That is correct for local
development and meaningless in production: a Vercel function has no localhost:3001, so
every AI call on the live site failed at connect time. Fixing it means the gateway needs
a public address.

## Architecture

```
browser  ->  Vercel function (Unote)  ->  Fly.io (FreeLLMAPI gateway)  ->  16 free-tier providers
                     |
                     +-- Postgres (Neon): ai_usage counters, ai_keys (encrypted)
```

Two ways a user's AI call gets paid for:

1. **Shared pool.** The default. Calls authenticate to the gateway with the operator's
   unified key and are metered against a monthly quota, counted per account and per IP.
2. **Personal key.** A user saves their own provider key in Settings. Their calls
   authenticate with that key and skip the quota entirely, because the spend is theirs.

## Limits

Set in `.env` / Vercel env, read in `server/src/config.ts`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FOLIO_AI_FREE_MONTHLY_USER` | 100 | Shared-pool calls per account per calendar month |
| `FOLIO_AI_FREE_MONTHLY_IP` | 1000 | Shared-pool calls per IP per calendar month |

A request must clear both. Either alone is trivially defeated: an account cap by
registering again, an IP cap by switching to a phone hotspot.

The IP ceiling is roughly 10x the account one on purpose. This is a student app, and a
university or halls NAT can put hundreds of legitimate users behind one address. Sizing
them equally would lock out a whole campus once ten people had signed up. Anyone the
ceilings do catch can add their own key.

Counters live in the `ai_usage` table rather than in memory. The in-memory limiter in
`auth/rateLimit.ts` is the right shape for stopping a burst and the wrong shape for a
monthly budget: serverless instances are short-lived and numerous, so an in-process
counter resets constantly and the real ceiling becomes `limit x warm instances`.

## Deploying the gateway

`flyctl` is not installed and Fly login is interactive, so these steps are yours to run.
`fly.toml` is already written at `C:\Users\sampo\freellmapi\fly.toml`.

```bash
# 1. Install flyctl and sign in
iwr https://fly.io/install.ps1 -useb | iex     # PowerShell
fly auth login

# 2. From the gateway repo
cd C:\Users\sampo\freellmapi

# 3. Create the app without deploying yet, so the volume exists first
fly apps create unote-ai-gateway

# 4. Create the volume the SQLite database lives on, in the same region as fly.toml
fly volumes create freellmapi_data --region lhr --size 1

# 5. The key that encrypts stored provider keys. Losing this loses every saved key.
fly secrets set ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 6. Deploy
fly deploy
```

Then open `https://unote-ai-gateway.fly.dev`, complete the dashboard setup to set an
admin password, add your provider keys, and generate the unified API key.

Finally point Unote at it:

```bash
vercel env add FOLIO_AI_BASE_URL production   # https://unote-ai-gateway.fly.dev/v1
vercel env add FOLIO_AI_KEY production        # the unified key from the dashboard
vercel env add FOLIO_AI_KEK production        # openssl rand -base64 32
vercel env add SESSION_SECRET production      # if not already set
```

## Things that will bite you

**Never scale past one machine.** The provider keys live in SQLite on a single Fly
volume. A second instance attaches its own empty volume and silently serves a different
key set, so half of all requests fail with auth errors that look like provider outages.
Scale the VM up, never out.

**The unified key is the only guard on `/v1`.** It lives in Vercel env and never reaches
the browser, but anyone who obtains it can spend your free tiers. If it leaks, regenerate
it in the dashboard and update the Vercel env var. The `/api` admin surface is separately
protected by the dashboard password, so choose a real one.

**`FOLIO_AI_KEK` is load-bearing.** It encrypts users' saved API keys at rest. If it is
unset it derives from `SESSION_SECRET`, which means rotating `SESSION_SECRET` silently
makes every stored key undecryptable and users have to re-enter them. Set it explicitly
in production and rotate it independently.

**The gateway's own rate limiter counts per IP.** Every Unote request arrives from
Vercel's egress, so from the gateway's side the whole user base is one client. That is
why `PROXY_RATE_LIMIT_RPM` is raised to 600 in `fly.toml`. The real per-user control is
the monthly quota, not this.

**Health probes used to cost real completions.** `/api/meta/ai-health` runs an actual
model call, and the client probes it on first paint, so before caching it every page load
anyone made spent one call from the shared pool. It is now cached per instance for 60s on
success and 10s on failure. If you change that, remember what it is spending.
