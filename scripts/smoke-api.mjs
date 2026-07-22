// End-to-end API check against a live Unote server.
// Focus: does the multi-user story actually hold, or can one account see another's data?
const BASE = process.env.FOLIO_BASE || 'http://localhost:4780';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
};

// Minimal cookie jar so each "user" keeps its own session.
function makeClient() {
  const jar = new Map();
  return async function call(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON (e.g. HTML error page) is itself a finding */
    }
    return { status: res.status, data };
  };
}

const uniq = process.argv[2] || String(Date.now());
const alice = makeClient();
const bob = makeClient();

console.log('\n== signup ==');
const aSignup = await alice('POST', '/api/auth/signup', {
  email: `alice+${uniq}@test.dev`,
  password: 'correct horse battery',
  displayName: 'Alice',
});
check('signup returns 201', aSignup.status === 201, `got ${aSignup.status}`);
check('signup returns a recovery key', typeof aSignup.data?.recoveryKey === 'string');
const recoveryKey = aSignup.data?.recoveryKey;
console.log(`        recovery key: ${recoveryKey}`);

console.log('\n== weak password rejected ==');
const weak = await makeClient()('POST', '/api/auth/signup', {
  email: `weak+${uniq}@test.dev`,
  password: 'short',
});
check('8-char minimum enforced', weak.status === 400, `got ${weak.status}`);

console.log('\n== duplicate email rejected ==');
const dup = await makeClient()('POST', '/api/auth/signup', {
  email: `alice+${uniq}@test.dev`,
  password: 'correct horse battery',
});
check('duplicate email -> 409', dup.status === 409, `got ${dup.status}`);

console.log('\n== session established ==');
const me = await alice('GET', '/api/auth/me');
check('/me returns the signed-in user', me.status === 200 && me.data?.user?.email?.startsWith('alice'));

console.log('\n== new account is seeded, not empty ==');
const nbs = await alice('GET', '/api/notebooks');
check('starter notebook exists', (nbs.data?.notebooks?.length ?? 0) > 0, JSON.stringify(nbs.data)?.slice(0, 120));
const notebookId = nbs.data?.notebooks?.[0]?.id;

console.log('\n== create + tag a note ==');
const created = await alice('POST', '/api/notes', { notebookId, title: 'Dijkstra' });
check('note created', created.status === 201 || created.status === 200, `got ${created.status}`);
const noteId = created.data?.note?.id;

const tagged = await alice('PATCH', `/api/notes/${noteId}`, {
  title: 'Dijkstra',
  tags: ['algorithms', 'week1'],
});
check('tags persisted', (tagged.data?.note?.tags ?? []).includes('algorithms'), JSON.stringify(tagged.data?.note?.tags));

const tagList = await alice('GET', '/api/tags');
check('tag appears in vocabulary', (tagList.data?.tags ?? []).some((t) => t.tag === 'algorithms'));

console.log('\n== search ==');
const search = await alice('GET', '/api/search?q=Dijkstra');
const hits = search.data?.results ?? search.data?.notes ?? [];
check('full-text search finds the note', JSON.stringify(hits).includes('Dijkstra'), JSON.stringify(search.data)?.slice(0, 160));

const tagSearch = await alice('GET', '/api/search?q=tag%3Aalgorithms');
check('tag: operator works', JSON.stringify(tagSearch.data).includes('Dijkstra'));

console.log('\n== OWNERSHIP ISOLATION (the one that matters) ==');
await bob('POST', '/api/auth/signup', {
  email: `bob+${uniq}@test.dev`,
  password: 'entirely different pw',
  displayName: 'Bob',
});

const bobReadsAlice = await bob('GET', `/api/notes/${noteId}`);
check("Bob cannot READ Alice's note", bobReadsAlice.status === 404 || bobReadsAlice.status === 403, `got ${bobReadsAlice.status}`);

const bobWritesAlice = await bob('PATCH', `/api/notes/${noteId}`, { title: 'pwned' });
check("Bob cannot WRITE Alice's note", bobWritesAlice.status === 404 || bobWritesAlice.status === 403, `got ${bobWritesAlice.status}`);

const bobDeletesAlice = await bob('DELETE', `/api/notes/${noteId}`);
check("Bob cannot DELETE Alice's note", bobDeletesAlice.status === 404 || bobDeletesAlice.status === 403, `got ${bobDeletesAlice.status}`);

const bobNotes = await bob('GET', '/api/notes');
check("Bob's note list excludes Alice's note", !JSON.stringify(bobNotes.data ?? {}).includes(noteId));

const bobTags = await bob('GET', '/api/tags');
check("Bob's tag vocabulary excludes Alice's tags", !(bobTags.data?.tags ?? []).some((t) => t.tag === 'algorithms'));

const bobSearch = await bob('GET', '/api/search?q=Dijkstra');
// Assert on the row count, not on the serialised body: the response echoes the
// parsed query back under `parsed.terms`, so a substring check for the search
// term matches its own echo and reports a leak that isn't there.
check(
  "Bob's search returns no rows for Alice's note",
  (bobSearch.data?.results ?? []).length === 0,
  JSON.stringify(bobSearch.data)?.slice(0, 160),
);

const bobCanvas = await bob('GET', `/api/canvas/${noteId}`);
check("Bob cannot read Alice's canvas", bobCanvas.status === 404, `got ${bobCanvas.status}`);

console.log('\n== unauthenticated access refused ==');
const anon = makeClient();
const anonNotes = await anon('GET', '/api/notes');
check('anonymous /api/notes -> 401', anonNotes.status === 401, `got ${anonNotes.status}`);

console.log('\n== sharing ==');
const share = await alice('POST', `/api/notes/${noteId}/shares`, { permission: 'edit', password: 'letmein-please' });
check('share link created', share.status === 201, `got ${share.status}`);
const token = share.data?.token;

const guest = makeClient();
const peek = await guest('GET', `/api/share/${token}`);
check('guest sees the gate', peek.status === 200 && peek.data?.needsPassword === true, JSON.stringify(peek.data));

const badJoin = await guest('POST', `/api/share/${token}/join`, { password: 'wrong' });
check('wrong share password rejected', badJoin.status === 401, `got ${badJoin.status}`);

const preJoin = await makeClient()('GET', `/api/share/${token}/note`);
check('cannot read shared note before joining', preJoin.status === 401, `got ${preJoin.status}`);

const goodJoin = await guest('POST', `/api/share/${token}/join`, { password: 'letmein-please', displayName: 'Guest1' });
check('correct share password accepted', goodJoin.status === 200, `got ${goodJoin.status}`);

const guestRead = await guest('GET', `/api/share/${token}/note`);
check('guest can read the shared note', guestRead.status === 200 && guestRead.data?.note?.title === 'Dijkstra', JSON.stringify(guestRead.data)?.slice(0, 140));

const revoke = await alice('DELETE', `/api/shares/${share.data?.share?.id}`);
check('share revoked', revoke.status === 200, `got ${revoke.status}`);
const afterRevoke = await guest('GET', `/api/share/${token}/note`);
check('revoked link stops working', afterRevoke.status === 404, `got ${afterRevoke.status}`);

console.log('\n== recovery key ==');
const badRecover = await makeClient()('POST', '/api/auth/recover', {
  email: `alice+${uniq}@test.dev`,
  recoveryKey: 'AAAAA-AAAAA-AAAAA-AAAAA',
  newPassword: 'a brand new password',
});
check('wrong recovery key rejected', badRecover.status === 401, `got ${badRecover.status}`);

// Lower-cased and with the dashes stripped, to prove normalisation works.
const mangled = recoveryKey?.toLowerCase().replace(/-/g, ' ');
const recoverClient = makeClient();
const recovered = await recoverClient('POST', '/api/auth/recover', {
  email: `alice+${uniq}@test.dev`,
  recoveryKey: mangled,
  newPassword: 'a brand new password',
});
check('recovery key redeems (mangled case/spacing)', recovered.status === 200, `got ${recovered.status} ${JSON.stringify(recovered.data)}`);
check('redemption issues a fresh key', typeof recovered.data?.recoveryKey === 'string');

const reused = await makeClient()('POST', '/api/auth/recover', {
  email: `alice+${uniq}@test.dev`,
  recoveryKey: mangled,
  newPassword: 'yet another password',
});
check('old recovery key cannot be reused', reused.status === 401, `got ${reused.status}`);

const oldPw = await makeClient()('POST', '/api/auth/login', {
  email: `alice+${uniq}@test.dev`,
  password: 'correct horse battery',
});
check('old password no longer works', oldPw.status === 401, `got ${oldPw.status}`);

const newPw = await makeClient()('POST', '/api/auth/login', {
  email: `alice+${uniq}@test.dev`,
  password: 'a brand new password',
});
check('new password works', newPw.status === 200, `got ${newPw.status}`);

console.log(`\n===== ${pass} passed, ${fail} failed =====\n`);
process.exit(fail ? 1 : 0);
