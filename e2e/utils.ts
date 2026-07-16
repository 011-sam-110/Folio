import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * Shared helpers for the Folio e2e suite.
 *
 * Selector policy (per the build contract): prefer getByRole/getByPlaceholder/getByText
 * matched against the literal copy in docs/FRONTEND.md, or against real DOM already
 * confirmed by reading the in-progress source of the other parallel agents (notably
 * ImportModal.tsx, CapturePage.tsx, AskPage.tsx, NoteCard.tsx, Modal.tsx, Toast.tsx,
 * lib/format.ts and lib/useShortcuts.ts, all of which already existed with real
 * markup at the time this suite was written). Pages that were still placeholder
 * stubs at that time (NotePage.tsx, DashboardPage.tsx, NotebookPage.tsx, the
 * sidebar/App shell) have no confirmed DOM yet, so a handful of elements there are
 * targeted via data-testid hooks this file assumes exist — see the task handoff
 * notes for the full list; the owning web-* agents need to add them.
 */

export const TESTIDS = {
  noteEditor: 'note-editor', // the TipTap contenteditable root on /note/:id
  autosaveStatus: 'autosave-status', // element whose text cycles Saving.../Saved .../error
  slashMenu: 'slash-menu',
  slashMenuItem: 'slash-menu-item',
  wikilinkMenu: 'wikilink-menu',
  wikilinkMenuItem: 'wikilink-menu-item',
  backlinksSection: 'backlinks-section',
  historyDrawer: 'history-drawer',
  historyVersionItem: 'history-version-item',
  noteRow: 'note-row', // NotebookPage list row fallback — real NoteCard.tsx renders `.note-card` (role="button"), prefer that
  pinnedStrip: 'pinned-strip',
  recentGrid: 'recent-notes',
  continueCard: 'continue-card',
  statsLine: 'dashboard-stats',
  quickSwitcher: 'quick-switcher',
  quickSwitcherResult: 'quick-switcher-result',
  fulltextResults: 'fulltext-results',
  aiPreviewModal: 'ai-preview-modal',
} as const;

export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function exact(text: string): RegExp {
  return new RegExp(escapeRegex(text));
}

/** The generic Modal.tsx dialog, however it's currently on screen. */
export function dialog(page: Page): Locator {
  return page.getByRole('dialog');
}

/**
 * Creates a notebook through the sidebar "+ New notebook" control and waits for it
 * to appear in the sidebar. Returns once the notebook link is visible.
 */
export async function createNotebookViaSidebar(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /new notebook/i }).click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  const nameInput = d.getByPlaceholder(/name/i).or(d.getByRole('textbox').first());
  await nameInput.fill(name);
  await d.getByRole('button', { name: /^(create|save|add)\b/i }).first().click();
  await expect(d).not.toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('link', { name: exact(name) })).toBeVisible({ timeout: 10_000 });
}

/** Opens a notebook from the sidebar by name (partial match). */
export async function openNotebook(page: Page, name: string): Promise<void> {
  await page.getByRole('link', { name: exact(name) }).click();
  await page.waitForURL(/\/notebook\//);
}

/** Clicks "New note" on the currently open notebook page and waits for the editor to load. */
export async function createNoteViaButton(page: Page): Promise<void> {
  await page.getByRole('button', { name: /new note/i }).first().click();
  await page.waitForURL(/\/note\//);
  await expect(page.getByTestId(TESTIDS.noteEditor)).toBeVisible({ timeout: 10_000 });
}

export function editorBody(page: Page): Locator {
  return page.getByTestId(TESTIDS.noteEditor);
}

export function titleInput(page: Page): Locator {
  return page.getByPlaceholder('Untitled');
}

export function autosaveStatus(page: Page): Locator {
  return page.getByTestId(TESTIDS.autosaveStatus);
}

/** Waits until the autosave chip settles on a "Saved" state. */
export async function waitForSaved(page: Page): Promise<void> {
  await expect(autosaveStatus(page)).toHaveText(/saved/i, { timeout: 15_000 });
}

/** Types text into the editor body, focusing it first. */
export async function typeInEditor(page: Page, text: string): Promise<void> {
  const body = editorBody(page);
  await body.click();
  await page.keyboard.type(text, { delay: 10 });
}

export async function setNoteTitle(page: Page, title: string): Promise<void> {
  const input = titleInput(page);
  await input.click();
  await input.fill(title);
}

/** Opens the Ctrl/Cmd+K quick switcher. */
export async function openQuickSwitcher(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId(TESTIDS.quickSwitcher)).toBeVisible({ timeout: 5_000 });
}

export function quickSwitcherInput(page: Page): Locator {
  return page.getByTestId(TESTIDS.quickSwitcher).getByRole('textbox');
}

/** Selects the first <option> in a <select> whose visible text matches `pattern`. */
export async function selectOptionMatching(select: Locator, pattern: RegExp): Promise<void> {
  const options = select.locator('option');
  const count = await options.count();
  for (let i = 0; i < count; i++) {
    const text = (await options.nth(i).textContent()) ?? '';
    if (pattern.test(text)) {
      const value = await options.nth(i).getAttribute('value');
      await select.selectOption(value ?? text);
      return;
    }
  }
  throw new Error(`No <option> matching ${pattern} found`);
}

/**
 * Note list rows. web/src/components/NoteCard.tsx (real, already-built) renders
 * `role="button"` cards with class `note-card`, and its own docstring says
 * NotebookPage reuses it with a `controls` prop — so `.note-card` is the primary
 * selector, with the `note-row` testid as a fallback in case that inference is
 * wrong once NotebookPage.tsx actually lands.
 */
export function noteCards(page: Page): Locator {
  return page.locator('.note-card').or(page.getByTestId(TESTIDS.noteRow));
}

/** Extracts the note id from the current /note/:id URL. */
export function noteIdFromUrl(page: Page): string {
  const m = page.url().match(/\/note\/([^/?#]+)/);
  if (!m) throw new Error(`not on a note page: ${page.url()}`);
  return m[1];
}

// ---------------------------------------------------------------------------
// Direct-API helpers for fast, reliable test *setup* (per docs/API.md). Used to
// seed specific notebooks/notes/tags where the UI mechanism is either already
// covered by another test or genuinely ambiguous (e.g. how tags get attached to
// a note) — the *behavior under test* in each spec still goes through the UI.
// ---------------------------------------------------------------------------

export interface ApiNotebook {
  id: string;
  name: string;
}

export async function apiCreateNotebook(request: APIRequestContext, name: string): Promise<ApiNotebook> {
  const res = await request.post('/api/notebooks', { data: { name, emoji: '🧪' } });
  expect(res.ok(), `create notebook failed: ${res.status()}`).toBeTruthy();
  const { notebook } = await res.json();
  return notebook;
}

export interface ApiNote {
  id: string;
  title: string;
}

/**
 * Drives the desktop ImportModal end-to-end: opens it (tolerating either a kind
 * picker menu on the trigger, or kind tabs inside the modal itself — the exact
 * shape isn't pinned down by docs/FRONTEND.md), attaches a file, optionally picks
 * a notebook, submits, waits for the job to reach 'done', and follows through to
 * the resulting note (whether that's an explicit "Open note" button or an
 * automatic navigation).
 */
export async function runDesktopImport(
  page: Page,
  opts: { kindLabel: RegExp; filePath: string; notebookName?: string; doneTimeout?: number },
): Promise<Locator> {
  await page.getByRole('button', { name: /import/i }).first().click();

  // ImportModal (web/src/features/import/ImportModal.tsx) always titles its dialog
  // "Import" and exposes the 3 kinds as role="tab" inside role="tablist".
  const d = page.getByRole('dialog', { name: /import/i }).or(dialog(page));
  await expect(d.first()).toBeVisible({ timeout: 10_000 });

  const kindControl = d
    .getByRole('tab', { name: opts.kindLabel })
    .or(d.getByRole('menuitem', { name: opts.kindLabel }))
    .or(d.getByRole('button', { name: opts.kindLabel }));
  if (await kindControl.count()) {
    await kindControl.first().click();
  }

  await d.locator('input[type="file"]').first().setInputFiles(opts.filePath);

  if (opts.notebookName) {
    const notebookSelect = d.getByRole('combobox').first();
    if (await notebookSelect.count()) {
      await selectOptionMatching(notebookSelect, exact(opts.notebookName)).catch(() => undefined);
    }
  }

  // Submit button reads "Import" (or "Import N pages" for multi-page photo chains).
  const submit = d.getByRole('button', { name: /^import(\s|$)|upload|start|process/i });
  if (await submit.count()) {
    await submit.first().click();
  }

  // Terminal states per ImportModal: phase 'done' shows an "Open note" button,
  // phase 'error' shows "Import failed" + the error message. Whichever comes
  // first tells us how the job resolved — fail loudly rather than timing out
  // blindly on a job that already errored.
  const openNoteBtn = d.getByRole('button', { name: /open note/i });
  const failed = d.getByText(/import failed/i);
  await expect(openNoteBtn.or(failed)).toBeVisible({ timeout: opts.doneTimeout ?? 120_000 });
  if (await failed.isVisible().catch(() => false)) {
    const detail = await d.locator('.im-result__message').textContent().catch(() => null);
    throw new Error(`Import job failed: ${detail ?? '(no error detail rendered)'}`);
  }

  await openNoteBtn.click();
  await page.waitForURL(/\/note\//, { timeout: 15_000 });
  return d;
}

export async function apiCreateNote(
  request: APIRequestContext,
  notebookId: string,
  title: string,
  opts: { tags?: string[]; contentText?: string } = {},
): Promise<ApiNote> {
  const res = await request.post('/api/notes', {
    data: {
      notebookId,
      title,
      tags: opts.tags,
      contentText: opts.contentText ?? title,
      contentJson: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: opts.contentText ?? title }] }],
      },
    },
  });
  expect(res.ok(), `create note failed: ${res.status()}`).toBeTruthy();
  const { note } = await res.json();
  return note;
}
