// The landing page's scroll motion.
//
// Two properties, and they are in tension, which is the only reason this file exists.
//
//   1. Motion REPLAYS in both directions. An element that leaves the viewport is hidden
//      again and animates on the way back, and a mock resets and replays its scene. An
//      earlier build revealed once and left everything alone, which made the page static on
//      every scroll after the first and did not match the design.
//   2. The page is never blank for anyone who cannot see the animation. Everything above is
//      gated behind `.mkt.is-armed`, which JavaScript adds only once it has decided to
//      animate, so no JS and reduced motion both render the finished page.
//
// Property 1 is what makes property 2 load-bearing rather than decorative: with replay on,
// "hidden" is a state elements return to for the whole life of the page, so a visitor who
// never gets the class must never meet the hiding rule at all.
import { expect, test } from './auth.fixture';

/** Well below the fold on any viewport, so it starts out un-revealed. */
const BELOW_FOLD = '.mkt-close__title';

test.beforeEach(async ({ page }) => {
  // The landing page is only served to logged-out visitors (see main.tsx).
  await page.context().clearCookies();
});

test('a reveal replays every time it re-enters the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const target = page.locator(BELOW_FOLD);
  await expect(target).toHaveCount(1);

  const revealed = () => target.evaluate((el) => el.classList.contains('is-in'));

  await expect.poll(revealed).toBe(false);

  await target.scrollIntoViewIfNeeded();
  await expect.poll(revealed).toBe(true);

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(revealed).toBe(false);

  // The second arrival is the one the old build could not do.
  await target.scrollIntoViewIfNeeded();
  await expect.poll(revealed).toBe(true);
});

test('a mock resets its scene when it leaves and plays it again on the way back', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const demo = page.locator('.mkt-demo').first();
  const playing = () => demo.evaluate((el) => el.classList.contains('is-playing'));

  await demo.scrollIntoViewIfNeeded();
  await expect.poll(playing).toBe(true);

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(playing).toBe(false);

  await demo.scrollIntoViewIfNeeded();
  await expect.poll(playing).toBe(true);
});

/**
 * The safety property, checked the way a visitor would actually experience losing it.
 *
 * Under reduced motion the hook never arms, so no hiding rule applies and every element is
 * at full opacity from the first frame - including the ones far below the fold that no
 * observer has reported yet. If a hiding rule ever escaped the `.is-armed` gate, this is
 * the test that fails, and it fails as "the page is blank" rather than as a class name.
 */
test('with reduced motion the whole page renders finished, top to bottom', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator(BELOW_FOLD)).toHaveCount(1);

  // Fully invisible, not merely faded. Some of these elements are SUPPOSED to sit under 1:
  // the flashcard deck's back and middle cards are held at 0.5 and 0.75 to read as depth.
  // Asserting opacity 1 flagged those two and would have gone on flagging every future
  // decorative fade, which is how a safety test turns into one people delete. What must
  // never happen is content at zero with nothing coming to reveal it.
  const invisible = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.mkt-reveal, .mkt-demo .mkt-demo__step'))
      .filter((el) => Number(getComputedStyle(el).opacity) < 0.02)
      .map((el) => el.className),
  );
  expect(invisible).toEqual([]);
});
