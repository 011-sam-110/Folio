// POST /api/ai/gaps/edits - the note against its own uploads.
//
// Two guarantees carry this route, and both are enforced in the handler rather than asked for
// in the prompt, because a property that only holds when the model cooperates is not a
// property:
//
//  1. Every edit is an `insert`. That is what makes an "Approve all" button safe here in a way
//     it is not for /suggest: this action adds what a source covered, and never rewrites the
//     student's own wording. A model-returned `replace` is dropped, not converted.
//  2. Every edit cites an attachment this note actually has. A citation the reader cannot act
//     on is worse than no citation.
//
// The model is mocked at the `fetch` seam, the same way every other AI suite here does it, so
// the real chat()/complete() path (including metering) still runs.

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';

const ENV = vi.hoisted(() => {
  // ONE model in the chain, so "how many requests did this route issue?" has an exact answer
  // rather than counting the production three-model fallback chain.
  process.env.FOLIO_AI_TEXT_MODELS = 'test-model';
  process.env.FOLIO_AI_RATELIMIT_RETRY_MS = '0';
  process.env.FOLIO_AI_KEK = 'test-only-key-encryption-key';
  return { model: 'test-model' };
});

import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db.js';
import { insertAttachment } from '../src/lib/attachments.js';
import { resetDatabase, resetData, makeUser, closeDatabase, insertNotebook, insertNote, type TestUser } from './helpers.js';

const app = buildApp();

const NO_SOURCES = 'Import slides, a photo or a transcript first.';
const PARA_ID = 'blk-para';
const HEADING_ID = 'blk-heading';

const DOC_WITH_IDS = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { id: HEADING_ID, level: 2 }, content: [{ type: 'text', text: 'Deadlock' }] },
    {
      type: 'paragraph',
      attrs: { id: PARA_ID },
      content: [{ type: 'text', text: 'A deadlock needs mutual exclusion and hold-and-wait.' }],
    },
  ],
};

let alice: TestUser;
let notebookId: string;
let noteId: string;

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetData();
  // ai_usage has no foreign key back to users, so nothing cascades to it and its counters
  // would otherwise leak into the next test.
  await pool.query('DELETE FROM ai_usage');
  alice = await makeUser(app);
  notebookId = await insertNotebook(alice.id);
  noteId = await insertNote(alice.id, notebookId, {
    title: 'Deadlock',
    content_json: JSON.stringify(DOC_WITH_IDS),
    content_text: 'Deadlock\nA deadlock needs mutual exclusion and hold-and-wait.',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await closeDatabase();
});

function gaps(user: TestUser, body: Record<string, unknown>) {
  return user.agent.post('/api/ai/gaps/edits').send(body);
}

/**
 * An upload filed against `noteId`, with the extracted text a real import would have written.
 *
 * This is the same shape the import pipeline produces (routes/imports.ts sets extracted_text
 * and status='ready' once a job finishes) - the route reads that column and nothing else, so
 * there is no second extraction path here.
 */
async function upload(
  opts: { noteId?: string | null; text?: string | null; status?: string; kind?: string; name?: string } = {},
): Promise<string> {
  const id = await insertAttachment({
    uid: alice.id,
    noteId: opts.noteId === undefined ? noteId : opts.noteId,
    kind: opts.kind ?? 'slides',
    originalName: opts.name ?? 'lecture3.pptx',
    storedName: `${Math.random().toString(36).slice(2, 12)}.pptx`,
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    bytes: Buffer.from('not really a deck'),
    status: opts.status ?? 'ready',
  });
  const text = opts.text === undefined ? '## Circular wait\nA cycle in the wait-for graph.' : opts.text;
  await db.prepare('UPDATE attachments SET extracted_text = ? WHERE id = ?').run(text, id);
  return id;
}

/** A well-formed gap edit citing `attachmentId`, overridable field by field. */
function gapEdit(attachmentId: string, over: Record<string, unknown> = {}) {
  return {
    id: 'g1',
    blockId: PARA_ID,
    op: 'insert',
    before: '',
    after: 'The fourth condition is circular wait: a cycle in the wait-for graph.',
    reason: 'The deck lists four conditions and your note stops at two.',
    checkId: 'missing-content.unfinished-thought',
    source: { attachmentId, label: 'slide 14 of 31' },
    ...over,
  };
}

/** A gateway that answers with `payload`, or fails outright. */
function stubModel(payload: unknown, opts: { fail?: boolean; raw?: string } = {}) {
  const f = vi.fn(async () => {
    if (opts.fail) return new Response('upstream exploded', { status: 500 });
    const content = opts.raw ?? JSON.stringify(payload);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', f);
  return f;
}

async function userCalls(uid: string): Promise<number> {
  const row = await db
    .prepare("SELECT calls FROM ai_usage WHERE scope = 'user' AND subject = ?")
    .get<{ calls: number }>(uid);
  return Number(row?.calls ?? 0);
}

describe('there has to be something to compare against', () => {
  // Written to be shown verbatim: the action's whole premise is a comparison, and with nothing
  // to compare against the honest answer is to say what is missing, not to let a model guess
  // what a student forgot.
  it('refuses a note with no uploads, in words the UI can show as-is', async () => {
    const gateway = stubModel({ edits: [] });

    const res = await gaps(alice, { noteId });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(NO_SOURCES);
    expect(gateway).not.toHaveBeenCalled();
  });

  // An upload whose extraction failed, or has not finished, carries no text to compare with -
  // so it is not a source, however much it looks like one in the attachments list.
  it('refuses when the uploads carry no extracted text yet', async () => {
    await upload({ text: null });
    await upload({ text: '' });
    await upload({ status: 'extracting' });

    const res = await gaps(alice, { noteId });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(NO_SOURCES);
  });

  it('does not count an upload filed against a different note', async () => {
    const other = await insertNote(alice.id, notebookId);
    await upload({ noteId: other });

    expect((await gaps(alice, { noteId })).body.error).toBe(NO_SOURCES);
  });
});

describe('what it returns', () => {
  it('returns insert-only edits, each citing a real upload', async () => {
    const att = await upload();
    stubModel({ edits: [gapEdit(att), gapEdit(att, { id: 'g2', blockId: HEADING_ID })] });

    const res = await gaps(alice, { noteId });

    expect(res.status).toBe(200);
    expect(res.body.edits).toHaveLength(2);
    for (const e of res.body.edits) {
      expect(e.op).toBe('insert');
      expect(e.source.attachmentId).toBe(att);
      expect(e.source.label).toBe('slide 14 of 31');
      expect(e.reason.trim()).not.toBe('');
    }
    expect(res.body.rejected).toBe(0);
    // Reported under missing-content, which is what gives the rail a severity to sort by.
    expect(res.body.ranFamilies).toEqual(['missing-content']);
    expect(res.body.edits.every((e: { checkId: string }) => e.checkId.startsWith('missing-content.'))).toBe(true);
  });

  it('sends the note as id-tagged blocks and the uploads as id-tagged sources', async () => {
    const att = await upload({ name: 'lecture3.pptx' });
    const gateway = stubModel({ edits: [] });

    await gaps(alice, { noteId });

    const body = JSON.parse(String((gateway.mock.calls[0]?.[1] as RequestInit).body)) as {
      messages: Array<{ content: string }>;
    };
    const user = String(body.messages[1].content);
    expect(user).toContain(`<block id="${PARA_ID}" type="paragraph">`);
    expect(user).toContain(`<source id="${att}" name="lecture3.pptx" kind="slides">`);
    expect(user).toContain('A cycle in the wait-for graph.');
  });

  it('costs one model call', async () => {
    await upload();
    stubModel({ edits: [] });

    await gaps(alice, { noteId });

    expect(await userCalls(alice.id)).toBe(1);
  });
});

describe('the insert-only guarantee is enforced, not requested', () => {
  // The one that matters most. A `replace` that reached the rail would break the promise the
  // action is sold on, and converting it to an insert would be worse still: the model's
  // phrasing would land in the note under a promise that it never would.
  it('drops a replace rather than converting it', async () => {
    const att = await upload();
    stubModel({
      edits: [
        gapEdit(att),
        gapEdit(att, { id: 'g2', op: 'replace', before: 'hold-and-wait', after: 'hold and wait' }),
      ],
    });

    const res = await gaps(alice, { noteId });

    expect(res.body.edits).toHaveLength(1);
    expect(res.body.edits.every((e: { op: string }) => e.op === 'insert')).toBe(true);
    expect(res.body.rejected).toBe(1);
  });

  it('drops a delete too', async () => {
    const att = await upload();
    stubModel({ edits: [gapEdit(att, { op: 'delete', before: 'hold-and-wait', after: '' })] });

    const res = await gaps(alice, { noteId });

    expect(res.body.edits).toEqual([]);
    expect(res.body.rejected).toBe(1);
  });
});

describe('every edit has to cite a source the reader can act on', () => {
  it('drops an edit with no source at all', async () => {
    const att = await upload();
    stubModel({ edits: [gapEdit(att), gapEdit(att, { id: 'g2', source: undefined })] });

    const res = await gaps(alice, { noteId });

    expect(res.body.edits).toHaveLength(1);
    expect(res.body.rejected).toBe(1);
  });

  it('drops an edit whose label is blank', async () => {
    const att = await upload();
    stubModel({ edits: [gapEdit(att, { source: { attachmentId: att, label: '   ' } })] });

    const res = await gaps(alice, { noteId });

    expect(res.body.edits).toEqual([]);
    expect(res.body.rejected).toBe(1);
  });

  // A cited id this request did not supply is either invented or points at somebody else's
  // upload. Either way the reader cannot follow it.
  it('drops an edit citing an attachment that is not one of this note uploads', async () => {
    const att = await upload();
    const other = await insertNote(alice.id, notebookId);
    const elsewhere = await upload({ noteId: other });
    stubModel({ edits: [gapEdit(att), gapEdit(elsewhere, { id: 'g2' }), gapEdit('made-up-id', { id: 'g3' })] });

    const res = await gaps(alice, { noteId });

    expect(res.body.edits).toHaveLength(1);
    expect(res.body.edits[0].source.attachmentId).toBe(att);
    expect(res.body.rejected).toBe(2);
  });

  it('trims an over-long label rather than throwing the suggestion away', async () => {
    const att = await upload();
    const label = 'slide 14 of 31, '.repeat(20);
    stubModel({ edits: [gapEdit(att, { source: { attachmentId: att, label } })] });

    const res = await gaps(alice, { noteId });

    expect(res.body.edits).toHaveLength(1);
    expect(res.body.edits[0].source.label.length).toBe(60);
    expect(res.body.edits[0].source.label).toBe(label.slice(0, 60));
  });

  it('drops an edit reported under a check outside the missing-content family', async () => {
    const att = await upload();
    stubModel({ edits: [gapEdit(att, { checkId: 'grammar.spelling' })] });

    const res = await gaps(alice, { noteId });

    expect(res.body.edits).toEqual([]);
    expect(res.body.rejected).toBe(1);
  });
});

describe('failures are reported as failures', () => {
  it('502s when the gateway does not answer', async () => {
    await upload();
    stubModel(null, { fail: true });

    const res = await gaps(alice, { noteId });

    expect(res.status).toBe(502);
    expect(res.body.attempts[0].model).toBe(ENV.model);
  });

  // "Your note covers everything in the slides" and "the model did not answer" must never look
  // the same to a student deciding whether their notes are complete - so a 200 carrying an
  // unreadable body is an error, not an empty result.
  it('502s when the completion cannot be read, rather than reporting no gaps', async () => {
    await upload();
    stubModel(null, { raw: 'Sure! Here are some thoughts about your notes.' });

    const res = await gaps(alice, { noteId });

    expect(res.status).toBe(502);
    expect(res.body.edits).toBeUndefined();
  });

  it('requires a noteId, 404s an unknown note, and 404s another account note', async () => {
    const bob = await makeUser(app);
    expect((await gaps(alice, {})).status).toBe(400);
    expect((await gaps(alice, { noteId: 'nope' })).status).toBe(404);
    expect((await gaps(bob, { noteId })).status).toBe(404);
  });

  it('404s for a soft-deleted note', async () => {
    await upload();
    await db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), noteId);
    expect((await gaps(alice, { noteId })).status).toBe(404);
  });

  it('requires a session', async () => {
    const res = await request(app).post('/api/ai/gaps/edits').send({ noteId });
    expect(res.status).toBe(401);
  });
});

// The Assistant panel still calls POST /api/ai/gaps for advisory markdown. This route was
// added alongside it rather than replacing it, so both answer their own caller - a swap would
// have broken the panel silently, with the same URL returning a shape it cannot render.
describe('the advisory /gaps route is untouched', () => {
  it('still answers with markdown', async () => {
    await upload();
    stubModel(null, { raw: '## Missing from your notes\n- Circular wait' });

    const res = await alice.agent.post('/api/ai/gaps').send({ noteId });

    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain('Missing from your notes');
    expect(res.body.edits).toBeUndefined();
  });
});
