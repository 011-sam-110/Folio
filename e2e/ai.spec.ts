import { expect, test, type APIRequestContext } from '@playwright/test';
import { TESTIDS, apiCreateNote, apiCreateNotebook, uniqueName } from './utils';

// These specs hit the real local AI gateway (docs/SPEC.md: http://localhost:3001/v1)
// through the server's /api/ai/* routes — no mocking. Generous timeouts throughout
// since a single call can legitimately take up to ~90s, and the suite runs serial
// so a slow/overloaded gateway doesn't cause cross-test interference.
test.describe.configure({ mode: 'serial' });

const ALGO_CONTENT = `
Binary search trees keep every node's left subtree smaller and right subtree larger,
which gives average-case O(log n) search, insert, and delete. Without rebalancing,
inserting sorted data degrades a BST into a linked list with O(n) operations, which
is exactly the failure mode that self-balancing variants like AVL trees and red-black
trees exist to prevent. AVL trees bound the height difference between subtrees to at
most one, rebalancing via rotations after every insert or delete. Red-black trees use
a looser coloring invariant that permits fewer rotations on average, trading a
slightly taller tree for cheaper maintenance. B-trees generalize this idea for disk-
backed storage by allowing many keys per node, which minimizes the number of disk
reads for a lookup — this is exactly why relational databases index tables with
B-tree (or B+tree) structures rather than plain binary trees.
`.trim();

const DEADLOCK_CONTENT = `
A deadlock occurs when a set of processes are each waiting for a resource held by
another process in that same set, and none of them can proceed. Four conditions must
all hold simultaneously for deadlock to be possible: mutual exclusion (a resource can
only be held by one process at a time), hold and wait (a process holds at least one
resource while waiting for another), no preemption (a resource can only be released
voluntarily by the process holding it), and circular wait (a closed chain of processes
each waiting on the next). Breaking any single one of these four conditions makes
deadlock impossible, which is the basis for prevention strategies; avoidance
strategies like the Banker's algorithm instead only grant requests that leave the
system in a provably safe state.
`.trim();

async function ensureAiHealthy(request: APIRequestContext): Promise<void> {
  const res = await request.get('/api/meta/ai-health');
  const body = await res.json().catch(() => ({}));
  if (!res.ok() || !body?.ok) {
    throw new Error(
      `ai.spec.ts requires a running local AI gateway (http://localhost:3001) — ` +
        `GET /api/meta/ai-health responded ${res.status()} ${JSON.stringify(body)}. ` +
        `Start the gateway before running this spec.`,
    );
  }
}

async function openAiMenuAction(page: import('@playwright/test').Page, actionPattern: RegExp): Promise<void> {
  // Scope to <main>: a notebook whose NAME contains the action word (e.g. "E2E AI
  // Flashcards Notebook") would otherwise make the sidebar's "Change emoji for
  // <notebook>" button — or the breadcrumb link — match `actionPattern` first, so
  // we'd open the emoji picker instead of the AI dropdown item. The sidebar lives in
  // <nav>, excluded from main. The AI dropdown (DropdownButton.tsx) renders its items
  // inline as <button>s inside main, so a button-role match is unambiguous there.
  const main = page.getByRole('main');
  await main.getByRole('button', { name: /^ai\b/i }).click();
  await main.getByRole('button', { name: actionPattern }).first().click();
}

test.describe('AI features (real gateway)', () => {
  test('Summarize a note renders a non-empty markdown preview', async ({ page, request }) => {
    test.setTimeout(180_000);
    await ensureAiHealthy(request);

    const notebook = await apiCreateNotebook(request, uniqueName('E2E AI Summarize Notebook'));
    const note = await apiCreateNote(request, notebook.id, uniqueName('AI Summarize Source'), {
      contentText: ALGO_CONTENT,
    });

    await page.goto(`/note/${note.id}`);
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(note.title, { timeout: 10_000 });

    await openAiMenuAction(page, /summarize/i);

    // The AI preview modal only mounts once the (real) summarize call returns, which
    // can legitimately take up to ~90s — the disabled "AI…" button is the in-flight
    // signal until then. Poll the modal's own testid for non-empty markdown so a
    // single budget covers both "modal appeared" and "content rendered".
    const preview = page.getByTestId(TESTIDS.aiPreviewModal);
    await expect
      .poll(
        async () => {
          const text = await preview.textContent({ timeout: 2_000 }).catch(() => '');
          return (text ?? '').trim().length;
        },
        { timeout: 95_000, message: 'AI summarize preview never rendered non-empty markdown' },
      )
      .toBeGreaterThan(20);
  });

  test('Generate flashcards shows a success toast', async ({ page, request }) => {
    test.setTimeout(180_000);
    await ensureAiHealthy(request);

    const notebook = await apiCreateNotebook(request, uniqueName('E2E AI Flashcards Notebook'));
    const note = await apiCreateNote(request, notebook.id, uniqueName('AI Flashcards Source'), {
      contentText: ALGO_CONTENT,
    });

    await page.goto(`/note/${note.id}`);
    await expect(page.getByPlaceholder('Untitled')).toHaveValue(note.title, { timeout: 10_000 });

    await openAiMenuAction(page, /flashcard/i);
    // The AI menu asks "How many?" before generating — pick a count.
    await page.locator('.folio-flashcard-count').getByRole('button', { name: '8' }).click();

    await expect(page.getByText(/\d+\s*cards?\s*added|flashcards?\s*(created|added|generated)/i)).toBeVisible({
      timeout: 90_000,
    });
  });

  test('/ask answers a question from the notes with at least one source', async ({ page, request }) => {
    test.setTimeout(180_000);
    await ensureAiHealthy(request);

    const notebook = await apiCreateNotebook(request, uniqueName('E2E Ask Notebook'));
    await apiCreateNote(request, notebook.id, uniqueName('Deadlock Conditions'), {
      contentText: DEADLOCK_CONTENT,
    });

    await page.goto('/ask');
    // AskPage.tsx (real, already-built): aria-label "Ask your notes" textarea,
    // Enter (without Shift) submits; the rendered answer lands in the last
    // `.ak-pair`'s `.ak-answer__markdown`, sources as links in `.ak-sources`.
    const input = page.getByPlaceholder(/ask your notes/i);
    await expect(input).toBeVisible({ timeout: 10_000 });
    await input.fill('What are the deadlock conditions?');
    await input.press('Enter');

    const pair = page.locator('.ak-pair').last();
    const answer = pair.locator('.ak-answer__markdown');
    await expect
      .poll(
        async () => {
          const text = await answer.textContent({ timeout: 3_000 }).catch(() => '');
          return (text ?? '').trim().length;
        },
        { timeout: 90_000, message: '/ask never produced an answer' },
      )
      .toBeGreaterThan(50);

    const sources = pair.locator('.ak-sources a');
    await expect(sources.first()).toBeVisible({ timeout: 5_000 });
    expect(await sources.count()).toBeGreaterThanOrEqual(1);
  });
});
