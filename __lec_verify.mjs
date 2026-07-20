// Drives the real Folio UI in a real browser against a real 150MB lecture MP4.
// Measures how long the browser slide scan actually takes and what it actually finds.
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5190';
const VIDEO = process.argv[2];
const SCAN_TIMEOUT_MS = Number(process.argv[3] ?? 900_000);

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage();
page.on('console', m => {
  const t = m.text();
  if (m.type() === 'error' || /lecture|slide|whisper|worker/i.test(t)) console.log('  [console]', t.slice(0, 300));
});
page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 300)));

console.log('1. logging in');
await page.goto(`${BASE}/login`);
await page.locator('input[type=email]').fill('lecture-verify@folio.local');
await page.locator('input[type=password]').fill('lecture-verify-pw-123');
await page.getByRole('button', { name: /sign in|log in/i }).click();
await page.waitForURL(u => !u.pathname.includes('/login'), { timeout: 20_000 });
console.log('   logged in ->', page.url());

const nbs = await (await page.request.get(`${BASE}/api/notebooks`)).json();
if (!nbs.notebooks?.length) {
  await page.request.post(`${BASE}/api/notebooks`, { data: { name: 'Lectures' } });
  console.log('   created a notebook');
}
console.log('   notebooks:', (nbs.notebooks ?? []).length);

console.log('2. opening the import modal via the command palette');
await page.keyboard.press('Control+p');
await page.getByPlaceholder('Type a command…').fill('Import slides');
await page.getByText('Import slides PDF', { exact: true }).first().click();
await page.getByRole('tab', { name: /lecture video/i }).waitFor({ timeout: 15000 });
console.log('   modal open, Lecture video tab present');

console.log('3. selecting the Lecture video tab');
await page.getByRole('tab', { name: /lecture video/i }).click();
await page.getByText(/drop a lecture recording/i).waitFor({ timeout: 15_000 });

console.log('4. attaching the real lecture file:', VIDEO);
await page.locator('input[type=file][accept*="video"]').setInputFiles(VIDEO);
await page.getByRole('button', { name: /find slides/i }).waitFor({ timeout: 30_000 });
const meta = await page.locator('.lec-file__sub').textContent();
console.log('   file loaded, duration/size =', meta);

console.log('5. scanning (this is the measurement)');
const t0 = Date.now();
await page.getByRole('button', { name: /find slides/i }).click();

let lastLog = 0;
const deadline = Date.now() + SCAN_TIMEOUT_MS;
for (;;) {
  if (Date.now() > deadline) throw new Error('scan timed out');
  const reviewed = await page.locator('.lec-strip, .lec-empty').count();
  if (reviewed > 0) break;
  const sub = await page.locator('.lec-sub').first().textContent().catch(() => null);
  if (sub && Date.now() - lastLog > 15_000) {
    console.log(`   [${((Date.now() - t0) / 1000).toFixed(0)}s] ${sub.trim()}`);
    lastLog = Date.now();
  }
  await page.waitForTimeout(1000);
}
const scanSeconds = (Date.now() - t0) / 1000;

const slideCount = await page.locator('.lec-slide').count();
const times = await page.locator('.lec-slide__time').allTextContents();
console.log(`\n=== SCAN RESULT ===`);
console.log(`   wall clock : ${scanSeconds.toFixed(1)}s`);
console.log(`   slides     : ${slideCount}`);
console.log(`   timestamps : ${times.join(' ')}`);

await page.screenshot({ path: process.argv[4] ?? 'review.png', fullPage: false });
console.log('   screenshot written');

await browser.close();
