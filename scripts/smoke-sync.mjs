// Does an OWNER's edit, made from their ordinary editor, reach a guest on a share link?
//
// This was broken: only the /share routes wrote note_events, so two guests on the
// same link synced with each other while the owner's edits went nowhere. The bug
// hid behind a feature that looked like it worked.
const BASE = process.env.FOLIO_BASE || 'http://localhost:4780';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

function makeClient() {
  const jar = new Map();
  return async function call(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

const u = process.argv[2] || String(Date.now());
const owner = makeClient();
const guest = makeClient();

await owner('POST', '/api/auth/signup', { email: `sync${u}@test.dev`, password: 'sync test password' });
const nb = await owner('GET', '/api/notebooks');
const made = await owner('POST', '/api/notes', {
  notebookId: nb.data.notebooks[0].id,
  title: 'Shared lecture notes',
});
const noteId = made.data.note.id;

console.log('\n== unshared note writes no events (table must not grow per keystroke) ==');
await owner('PATCH', `/api/notes/${noteId}`, { title: 'Edited while private' });
const share0 = await owner('POST', `/api/notes/${noteId}/shares`, { permission: 'edit' });
const token = share0.data.token;
await guest('POST', `/api/share/${token}/join`, { displayName: 'Guest' });
const baseline = await guest('GET', `/api/share/${token}/events?since=0`);
check(
  'edits made before sharing left no backlog',
  (baseline.data?.events ?? []).length === 0,
  `${(baseline.data?.events ?? []).length} event(s)`,
);

console.log('\n== THE BUG: owner edits from their own editor ==');
const before = Number(baseline.data?.revision ?? 0);
await owner('PATCH', `/api/notes/${noteId}`, { title: 'Owner renamed this' });
const after = await guest('GET', `/api/share/${token}/events?since=${before}`);
const events = after.data?.events ?? [];
check('guest receives the owner edit', events.length > 0, `${events.length} event(s)`);
check('event is a doc change', events.some((e) => e.kind === 'doc'), JSON.stringify(events).slice(0, 160));

const seen = await guest('GET', `/api/share/${token}/note`);
check(
  'guest fetch reflects the new title',
  seen.data?.note?.title === 'Owner renamed this',
  JSON.stringify(seen.data?.note?.title),
);

console.log('\n== owner ink reaches the guest too ==');
const rev = Number(after.data?.revision ?? before);
await owner('POST', `/api/canvas/${noteId}/ink`, {
  strokes: [{ points: [[0, 0, 0.5], [10, 10, 0.6]], color: '#000', width: 2, tool: 'pen' }],
});
const inkEvents = await guest('GET', `/api/share/${token}/events?since=${rev}`);
check(
  'guest receives the owner ink stroke',
  (inkEvents.data?.events ?? []).some((e) => e.kind === 'ink'),
  JSON.stringify(inkEvents.data?.events ?? []).slice(0, 160),
);

console.log('\n== a guest edit is searchable by the owner ==');
// Regression: the guest PATCH wrote content_json but never content_text, which is
// what full-text search indexes. Everything a collaborator typed was invisible to
// search forever, behind a snippet frozen from before they joined.
await guest('PATCH', `/api/share/${token}/note`, {
  contentJson: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kruskal builds a minimum spanning forest.' }] }],
  },
});
const ownerSearch = await owner('GET', '/api/search?q=Kruskal');
check(
  "owner's search finds what the guest wrote",
  (ownerSearch.data?.results ?? []).length > 0,
  JSON.stringify(ownerSearch.data).slice(0, 160),
);

console.log('\n== revoking stops the feed ==');
await owner('DELETE', `/api/shares/${share0.data.share.id}`);
const afterRevoke = await guest('GET', `/api/share/${token}/events?since=0`);
check('revoked link rejects polling', afterRevoke.status === 404, `got ${afterRevoke.status}`);

console.log(`\n===== ${pass} passed, ${fail} failed =====\n`);
process.exit(fail ? 1 : 0);
