import { Router } from 'express';
import QRCode from 'qrcode';
import { config } from '../config.js';
import { userId } from '../auth/middleware.js';
import { aiHealth, credentialProblem, sharedPoolCreds } from '../ai/client.js';
import { resolveHealthCreds } from '../ai/gate.js';
import { appPublicUrl, lanAddresses, normalisePort } from '../lib/publicUrl.js';
import { createPairing, pruneExpiredPairings, PAIRING_TTL_MS } from '../auth/pairing.js';

const router = Router();

function lanUrls(): string[] {
  return lanAddresses().map((address) => `http://${address}:${config.port}`);
}

router.get('/', (_req, res) => {
  // `configured` used to mean "a key string exists", which said yes on the deployed site
  // while the base URL still pointed at localhost. It now means "this could actually work".
  const problem = credentialProblem(sharedPoolCreds(), 'shared-pool');
  res.json({
    name: 'Unote',
    version: '0.1.0',
    port: config.port,
    ai: {
      configured: !problem,
      problem: problem ? { reason: problem.reason, error: problem.error, hint: problem.hint } : null,
      baseUrl: config.ai.baseUrl,
      textModels: config.ai.textModels,
    },
    lan: { urls: lanUrls() },
  });
});

/**
 * Is AI available FOR THIS USER?
 *
 * The answer has to be per-caller, not per-deployment. A user who has saved their own
 * provider key is not asking about the operator's gateway, and answering with the
 * operator's verdict is what made a working personal key look like a broken app: every AI
 * affordance in the web client hides itself on this response (web/src/lib/aiStatus.ts).
 *
 * `/api/meta` is mounted behind requireAuth in app.ts, so there is always a user here.
 */
router.get('/ai-health', async (req, res) => {
  const { creds, source } = await resolveHealthCreds(userId(req));
  res.json(await aiHealth(creds, source));
});

/**
 * The QR a desktop user shows their phone.
 *
 * Two things were wrong here, and they were independent:
 *
 *  1. The encoded URL was built from `os.networkInterfaces()` - the addresses of the
 *     machine running this process. On Vercel that is the function container's private
 *     address, so the QR encoded an unroutable `http://10.x.x.x:4780` that no phone could
 *     open. The base now comes from `appPublicUrl(req)`, which starts from the origin the
 *     requesting browser demonstrably reached us on.
 *
 *  2. The QR encoded only the base, while the modal DISPLAYED `${base}/capture`. Even on a
 *     LAN where the address happened to be right, scanning landed on the dashboard rather
 *     than the capture page. The encoded string and the displayed string are now one value.
 *
 * And one thing was missing entirely: the phone has no session, so /capture could not have
 * worked however correct the URL was. The URL now carries a single-use pairing code the
 * phone exchanges for a capture-scoped session (auth/pairing.ts, POST /api/auth/pair).
 *
 * A code is minted per request, so every open of the modal issues a fresh one. That is
 * intended - they expire in minutes, and an unredeemed code costs one row the prune below
 * reclaims.
 */
router.get('/qr', async (req, res) => {
  const uid = userId(req);

  // Local dev can offer several plausible LAN addresses when only one of them is the Wi-Fi
  // the phone is on, so the UI may ask for a specific one. Validated against this machine's
  // OWN addresses rather than used as given: the response embeds a live pairing code, and
  // an arbitrary caller-supplied base would point that code at somebody else's host.
  const requested = typeof req.query.lan === 'string' ? req.query.lan : '';
  const addresses = lanAddresses();
  // See appPublicUrl: only a port, never a host, and only consulted for a local run.
  const browserPort = normalisePort(typeof req.query.port === 'string' ? req.query.port : undefined);
  let base = appPublicUrl(req, browserPort);
  if (requested && addresses.includes(requested)) {
    const port = browserPort || req.get('host')?.split(':')[1] || String(config.port);
    base = `http://${requested}:${port}`;
  }

  if (!base) {
    res.status(503).json({
      error: "Could not work out this server's public address. Set FOLIO_PUBLIC_URL and try again.",
    });
    return;
  }

  const { token, expiresAt } = await createPairing(uid);
  // Opportunistic, and after the insert so a slow delete never delays the code the user is
  // waiting on. A failure here is not worth failing the request over.
  pruneExpiredPairings().catch((err) => console.warn('[meta] pairing prune failed', err));

  const url = `${base}/capture?pair=${encodeURIComponent(token)}`;
  const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 1 });

  res.json({
    url,
    base,
    expiresAt,
    ttlMs: PAIRING_TTL_MS,
    /** Alternative LAN addresses, offered when the first guess is the wrong network. */
    lanAddresses: addresses,
    all: lanUrls(),
    dataUrl,
  });
});

export default router;
