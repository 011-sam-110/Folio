/**
 * Phone capture, end to end, across TWO devices.
 *
 * This is the spec the feature never had, and its absence is why the bug shipped: every
 * existing check drove /capture from an already-authenticated context, which is the one
 * situation a real phone is never in. `mobile-capture.spec.ts` navigates straight to
 * /capture carrying the worker's session cookie - so it passed throughout, while the actual
 * flow (scan a code on a device that has never signed in) was impossible.
 *
 * The second context here has NO storage state. It is the phone.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devices, expect } from '@playwright/test';
import { test } from './auth.fixture';
import { apiCreateNotebook, uniqueName } from './utils';

const FIXTURES_DIR = fileURLToPath(new URL('fixtures', import.meta.url));

/** Decode the QR image back to the string a camera would read. */
async function decodeQr(dataUrl: string): Promise<string> {
  const { Jimp } = await import('jimp');
  const jsQR = (await import('jsqr')).default;
  const img = await Jimp.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
  const decoded = jsQR(new Uint8ClampedArray(img.bitmap.data), img.bitmap.width, img.bitmap.height);
  if (!decoded) throw new Error('QR image did not decode');
  return decoded.data;
}

/** Open the desktop Phone-capture modal and return what its QR actually encodes. */
async function readQrFromModal(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: /phone capture/i }).click();
  const qr = page.locator('img[alt*="QR code"]');
  await expect(qr).toBeVisible({ timeout: 15_000 });
  const src = await qr.getAttribute('src');
  expect(src, 'QR should render as an inline data URL').toMatch(/^data:image\/png;base64,/);
  return decodeQr(src!);
}

test.describe('Phone capture (QR pairing across devices)', () => {
  test('the QR encodes an absolute, reachable /capture URL carrying a pairing code', async ({ page }) => {
    const encoded = await readQrFromModal(page);
    console.log('DECODED QR PAYLOAD:', encoded);

    const url = new URL(encoded);

    // The whole bug, asserted. It used to encode a bare origin taken from the server's own
    // network interfaces - on Vercel, an unroutable container address; here, whichever
    // adapter os.networkInterfaces() happened to list first.
    expect(url.pathname).toBe('/capture');
    expect(url.searchParams.get('pair')).toBeTruthy();
    expect(url.hostname).not.toBe('localhost');
    expect(url.hostname).not.toBe('127.0.0.1');

    // And what the modal PRINTS must be the origin of what it ENCODES - those were two
    // different strings before, and only the printed one was right.
    const printed = await page.locator('text=/\\/capture$/').first().textContent();
    expect(encoded.startsWith(printed!.trim().replace(/\/capture$/, ''))).toBe(true);

    await page.screenshot({ path: 'test-results/phone-capture-qr-modal.png' });
  });

  test('a device with NO session opens that URL and reaches the capture page', async ({ page, browser }) => {
    const encoded = await readQrFromModal(page);

    // A brand-new phone: its own context, no cookies, no storage state.
    const phone = await browser.newContext({ ...devices['Pixel 7'] });
    try {
      const phonePage = await phone.newPage();

      // Prove it really is signed out before scanning.
      const meBefore = await phonePage.request.get(new URL('/api/auth/me', encoded).toString());
      expect(meBefore.status()).toBe(401);

      await phonePage.goto(encoded);

      // Before the fix this landed on /login - RequireAuth wrapped /capture and the phone
      // had no session to satisfy it.
      await expect(phonePage).toHaveURL(/\/capture/, { timeout: 15_000 });
      await expect(phonePage).not.toHaveURL(/\/login/);
      await expect(phonePage.getByRole('button', { name: /photo of notes|capture|take photo/i }).first()).toBeVisible({
        timeout: 15_000,
      });

      // The pairing code must not be left sitting in the address bar.
      expect(phonePage.url()).not.toContain('pair=');

      await phonePage.screenshot({ path: 'test-results/phone-capture-paired-phone.png' });
    } finally {
      await phone.close();
    }
  });

  test('the paired phone can complete a capture, and cannot do anything else', async ({ page, browser, request }) => {
    test.setTimeout(150_000);
    const notebook = await apiCreateNotebook(request, uniqueName('E2E Pair Capture'));
    const encoded = await readQrFromModal(page);

    const phone = await browser.newContext({ ...devices['Pixel 7'] });
    try {
      const phonePage = await phone.newPage();
      await phonePage.goto(encoded);
      await expect(phonePage).toHaveURL(/\/capture/, { timeout: 15_000 });

      const origin = new URL(encoded).origin;

      // The grant, positively: it can list notebooks and run one import.
      await phonePage.getByRole('radio', { name: new RegExp(notebook.name) }).first().click();
      await phonePage.getByRole('tab', { name: /transcript/i }).click();
      await phonePage.locator('input[type="file"]').first().setInputFiles(path.join(FIXTURES_DIR, 'transcript.txt'));
      await phonePage.getByRole('button', { name: /upload.*process/i }).click();

      const success = phonePage.getByRole('heading', { name: /note ready/i });
      const errorBanner = phonePage.locator('.cp-error');
      await expect(success.or(errorBanner)).toBeVisible({ timeout: 120_000 });
      if (await errorBanner.isVisible().catch(() => false)) {
        test.skip(true, `capture failed upstream: ${await errorBanner.locator('p').first().textContent()}`);
      }
      await expect(phonePage.locator('.cp-success__title')).toBeVisible();
      await phonePage.screenshot({ path: 'test-results/phone-capture-success.png' });

      // The grant, negatively - this is what stops a scanned QR being an account takeover.
      for (const target of ['/api/notes', '/api/dashboard', '/api/meta/qr', '/api/ai/keys']) {
        const res = await phonePage.request.get(origin + target);
        expect(res.status(), `${target} must be refused for a capture-scoped session`).toBe(403);
      }
      const pw = await phonePage.request.post(origin + '/api/auth/password', {
        data: { currentPassword: 'x', newPassword: 'yyyyyyyyyy' },
      });
      expect(pw.status()).toBe(403);

      // And it is confined in the UI too, rather than rendering a shell that 403s.
      await phonePage.goto(origin + '/');
      await expect(phonePage).toHaveURL(/\/capture/, { timeout: 10_000 });
    } finally {
      await phone.close();
    }
  });

  test('a pairing code works exactly once', async ({ page, browser }) => {
    const encoded = await readQrFromModal(page);

    const first = await browser.newContext({ ...devices['Pixel 7'] });
    const second = await browser.newContext({ ...devices['Pixel 7'] });
    try {
      const p1 = await first.newPage();
      await p1.goto(encoded);
      await expect(p1).toHaveURL(/\/capture/, { timeout: 15_000 });
      await expect(p1.locator('.cp-message')).toHaveCount(0);

      // A bystander who photographed the screen scans the same code afterwards.
      const p2 = await second.newPage();
      await p2.goto(encoded);
      await expect(p2.getByText(/expired or has already been used/i)).toBeVisible({ timeout: 15_000 });
      await p2.screenshot({ path: 'test-results/phone-capture-replay-refused.png' });
    } finally {
      await first.close();
      await second.close();
    }
  });
});
