// End-to-end tests with a mocked Google OAuth + Tasks API.
// No network access, no real accounts and no real data are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'https://app.test';
const SECRET = 'tasks_test_secret_abcdefghijklmnop';
Object.assign(process.env, {
  PUBLIC_BASE_URL: BASE, TASKS_PATH_SECRET: SECRET, VERCEL_DASHBOARD_URL: 'https://vercel.com/example-team/example-project',
});

const { handle } = await import('../lib/app.js');
const util = await import('../lib/util.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

// ------------------------------------------------------------ mock Google
const G = { access: 'g-access-1', refresh: 'g-refresh-ok', tokenCalls: 0, lists: [], tasks: new Map(), seq: 0, dueShiftH: 24 };
G.lists = [{ id: 'L1', title: 'My Tasks', updated: '2026-01-01T00:00:00.000Z' }, { id: 'L2', title: 'Work', updated: '2026-01-02T00:00:00.000Z' }];
G.tasks = new Map([['L1', []], ['L2', []]]);
const gList = (id) => (id === '@default' ? 'L1' : id);
const pos = (n) => String(n).padStart(20, '0');
function gNewTask(listId, body, parent, previous) {
  const arr = G.tasks.get(listId);
  const siblings = arr.filter((t) => (t.parent || null) === (parent || null)).sort((a, b) => a.position.localeCompare(b.position));
  let p;
  if (previous) { const prev = siblings.find((t) => t.id === previous); p = pos(Number(prev.position) + 1); for (const s of siblings) if (s.position >= p) s.position = pos(Number(s.position) + 1); }
  else { p = pos(0); for (const s of siblings) s.position = pos(Number(s.position) + 1); }
  const t = { kind: 'tasks#task', id: `T${++G.seq}`, title: body.title, notes: body.notes, status: body.status || 'needsAction', due: body.due, parent: parent || undefined, position: p, updated: new Date().toISOString(), webViewLink: `https://tasks.google.com/task/T${G.seq}` };
  arr.push(t);
  return t;
}
async function googleMock(url, init) {
  const method = (init?.method || 'GET').toUpperCase();
  if (url.origin === 'https://oauth2.googleapis.com') {
    G.tokenCalls++;
    const p = new URLSearchParams(init.body);
    assert.equal(p.get('client_id'), 'g-client-id');
    assert.equal(p.get('client_secret'), 'g-client-secret');
    if (p.get('grant_type') === 'refresh_token') {
      if (p.get('refresh_token') !== G.refresh) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: G.access, expires_in: 3599, token_type: 'Bearer', scope: 'https://www.googleapis.com/auth/tasks' });
    }
    if (p.get('grant_type') === 'authorization_code') {
      assert.equal(p.get('redirect_uri'), `${BASE}/oauth/google/callback`);
      assert.ok(p.get('code_verifier')?.length >= 43);
      assert.equal(util.pkceChallenge(p.get('code_verifier')), G.lastChallenge, 'PKCE verifier must match challenge');
      if (p.get('code') === 'code-noscope') return Response.json({ access_token: 'x', refresh_token: 'y', scope: 'openid' });
      return Response.json({ access_token: G.access, refresh_token: 'new-refresh-token-from-google', expires_in: 3599, scope: 'https://www.googleapis.com/auth/tasks' });
    }
  }
  assert.equal(url.origin, 'https://tasks.googleapis.com');
  if (init?.headers?.authorization !== `Bearer ${G.access}`) return Response.json({ error: { code: 401, message: 'Invalid Credentials' } }, { status: 401 });
  const path = url.pathname.replace('/tasks/v1', '');
  const q = url.searchParams;
  const body = init?.body ? JSON.parse(init.body) : {};
  let m;
  if (path === '/users/@me/lists' && method === 'GET') return Response.json({ items: G.lists });
  if (path === '/users/@me/lists/@default') return Response.json(G.lists[0]);
  if (path === '/users/@me/lists' && method === 'POST') { const l = { id: `L${G.lists.length + 1}`, title: body.title, updated: new Date().toISOString() }; G.lists.push(l); G.tasks.set(l.id, []); return Response.json(l); }
  if ((m = /^\/lists\/([^/]+)\/tasks$/.exec(path))) {
    const lid = gList(decodeURIComponent(m[1]));
    if (!G.tasks.has(lid)) return Response.json({ error: { code: 404, message: 'Not Found' } }, { status: 404 });
    if (method === 'POST') return Response.json(gNewTask(lid, body, q.get('parent'), q.get('previous')));
    let items = G.tasks.get(lid).filter((t) => !t.deleted);
    if (q.get('showCompleted') === 'false') items = items.filter((t) => t.status !== 'completed');
    if (q.get('showHidden') !== 'true') items = items.filter((t) => !t.hidden);
    if (q.get('completedMin')) items = items.filter((t) => t.completed && t.completed >= q.get('completedMin'));
    // Google's due filter doesn't line up with calendar days. Observed on the real API: a task due on
    // day D is left out by dueMax = D at 23:59:59.999Z, but included by dueMax = D+1 at 23:59:59.999Z
    // and by dueMin = D-1 at 23:59:59.999Z. G.dueShiftH models this (filter time = due + shift); the
    // tests run with several shifts so the connector must not depend on the exact rule.
    const dueAt = (t) => new Date(Date.parse(t.due) + G.dueShiftH * 3600_000).toISOString();
    if (q.get('dueMin')) items = items.filter((t) => t.due && dueAt(t) > q.get('dueMin'));
    if (q.get('dueMax')) items = items.filter((t) => t.due && dueAt(t) <= q.get('dueMax'));
    const size = Number(q.get('maxResults') || 20); const start = Number(q.get('pageToken') || 0);
    const page = items.slice(start, start + size);
    return Response.json({ items: page, ...(start + size < items.length ? { nextPageToken: String(start + size) } : {}) });
  }
  if ((m = /^\/lists\/([^/]+)\/tasks\/([^/]+)(\/move)?$/.exec(path))) {
    const lid = gList(decodeURIComponent(m[1])); const tid = decodeURIComponent(m[2]);
    const arr = G.tasks.get(lid) || [];
    const t = arr.find((x) => x.id === tid && !x.deleted);
    if (!t) return Response.json({ error: { code: 404, message: 'Not Found' } }, { status: 404 });
    if (m[3]) {
      const dest = q.get('destinationTasklist') || lid;
      arr.splice(arr.indexOf(t), 1);
      const moved = gNewTask(dest, t, q.get('parent'), q.get('previous'));
      Object.assign(moved, { id: t.id, status: t.status, completed: t.completed });
      return Response.json(moved);
    }
    if (method === 'GET') return Response.json(t);
    if (method === 'DELETE') { t.deleted = true; return new Response(null, { status: 204 }); }
    if (method === 'PATCH') {
      for (const [k, v] of Object.entries(body)) { if (v === null) delete t[k]; else t[k] = v; }
      if (body.status === 'completed' && !t.completed) { t.completed = new Date().toISOString(); }
      if (body.status === 'needsAction') delete t.completed;
      t.updated = new Date().toISOString();
      return Response.json(t);
    }
  }
  throw new Error(`Unmocked Google call ${method} ${url}`);
}

// ------------------------------------------------------------ fetch router
globalThis.fetch = async (input, init = {}) => {
  const req = input instanceof Request ? input : null;
  const url = new URL(req ? req.url : String(input));
  if (url.origin === BASE) return handle(req && !init.method ? req : new Request(url, init));
  const headers = Object.fromEntries(new Headers(init.headers || req?.headers || {}).entries());
  const norm = { ...init, headers, body: init.body ?? (req ? await req.text() : undefined) };
  if (url.hostname.endsWith('googleapis.com')) return googleMock(url, norm);
  throw new Error(`Unexpected outbound request: ${url}`);
};

const get = (path, headers = {}) => handle(new Request(BASE + path, { headers }));
async function mcpClient(path) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE + path)));
  return client;
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? '';
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { isError: Boolean(r.isError), text, json };
};

// ------------------------------------------------------------ routing
await test('home page, unknown paths and wrong secrets', async () => {
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.equal(await home.text(), 'Private service.');
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await get('/tasks/wrong-secret-0000000000000/setup')).status, 404);
  assert.equal((await get(`/oura/${SECRET}/setup`)).status, 404);
  assert.equal((await get('/.well-known/oauth-protected-resource')).status, 404);
});

await test('home page explains a missing or unusable path secret without revealing it', async () => {
  try {
    process.env.TASKS_PATH_SECRET = '';
    assert.match(await (await get('/')).text(), /TASKS_PATH_SECRET environment variable is not set/);
    process.env.TASKS_PATH_SECRET = 'short';
    assert.match(await (await get('/')).text(), /at least 16 characters/);
    process.env.TASKS_PATH_SECRET = 'has spaces and/slashes 1234567890';
    const html = await (await get('/')).text();
    assert.match(html, /only letters, digits/);
    assert.ok(!html.includes('slashes'), 'must never echo the secret');
  } finally {
    process.env.TASKS_PATH_SECRET = SECRET;
  }
});

await test('privacy and terms pages are generic', async () => {
  const privacy = await (await get('/privacy')).text();
  assert.match(privacy, /single-user/);
  assert.match(privacy, /the person who deploys this instance/);
  assert.match(await (await get('/terms')).text(), /the person who deploys this instance/);
});

await test('rewrite fallback path (?__p=)', async () => {
  const r = await get(`/api/index?__p=tasks/${SECRET}/setup`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Google Tasks connector/);
});

await test('MCP GET returns 405, trailing slash ok', async () => {
  assert.equal((await get(`/tasks/${SECRET}/mcp/`)).status, 405);
});

await test('setup page shows todo items before config', async () => {
  const html = await (await get(`/tasks/${SECRET}/setup`)).text();
  assert.match(html, /GOOGLE_CLIENT_ID saved in Vercel/);
  assert.match(html, /btn disabled/);
  assert.match(html, /https:\/\/app\.test\/oauth\/google\/callback/);
  assert.ok(html.includes(`${BASE}/tasks/${SECRET}/mcp`));
});

await test('tools report missing setup', async () => {
  const c = await mcpClient(`/tasks/${SECRET}/mcp`);
  const r = await call(c, 'list_tasklists');
  assert.equal(r.isError, true);
  assert.match(r.text, /GOOGLE_CLIENT_ID/);
  await c.close();
});

// ------------------------------------------------------------ Google OAuth flow
Object.assign(process.env, { GOOGLE_CLIENT_ID: 'g-client-id', GOOGLE_CLIENT_SECRET: 'g-client-secret' });

await test('connect redirects to Google with PKCE + offline access; callback shows the refresh token once', async () => {
  const r = await get(`/tasks/${SECRET}/connect`);
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(loc.searchParams.get('scope'), 'https://www.googleapis.com/auth/tasks');
  assert.equal(loc.searchParams.get('access_type'), 'offline');
  assert.equal(loc.searchParams.get('prompt'), 'consent');
  assert.equal(loc.searchParams.get('redirect_uri'), `${BASE}/oauth/google/callback`);
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  G.lastChallenge = loc.searchParams.get('code_challenge');
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /^__Host-google_oauth=.+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=900$/);
  const state = loc.searchParams.get('state');
  const cb = await get(`/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`, { cookie: cookie.split(';')[0] });
  const html = await cb.text();
  assert.equal(cb.status, 200, html);
  assert.match(html, /new-refresh-token-from-google/);
  assert.match(html, /Test passed: I can see 2 task list/);
  assert.match(html, /Redeploy/);
  assert.equal(cb.headers.get('cache-control'), 'no-store');
  assert.match(cb.headers.get('content-security-policy'), /script-src 'nonce-/);
  // Replay from a different browser (no cookie) must fail.
  const bad = await get(`/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Link expired/);
  // A tampered state must fail.
  const tampered = await get(`/oauth/google/callback?code=abc&state=${encodeURIComponent(`${state}x`)}`, { cookie: cookie.split(';')[0] });
  assert.equal(tampered.status, 400);
});

await test('callback rejects a missing Tasks scope and a cancelled sign-in', async () => {
  const r = await get(`/tasks/${SECRET}/connect`);
  const loc = new URL(r.headers.get('location'));
  G.lastChallenge = loc.searchParams.get('code_challenge');
  const cb = await get(`/oauth/google/callback?code=code-noscope&state=${encodeURIComponent(loc.searchParams.get('state'))}`, { cookie: r.headers.get('set-cookie').split(';')[0] });
  assert.match(await cb.text(), /Tasks permission missing/);
  const cancel = await get('/oauth/google/callback?error=access_denied&state=x');
  assert.match(await cancel.text(), /cancelled/);
});

// ------------------------------------------------------------ Google Tasks tools
process.env.GOOGLE_REFRESH_TOKEN = G.refresh;
const tc = await mcpClient(`/tasks/${SECRET}/mcp`);
let parentId; let childId; let otherId;

await test('server info + tool list', async () => {
  assert.equal(tc.getServerVersion().name, 'google-tasks');
  const { tools } = await tc.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['complete_task', 'create_task', 'create_tasklist', 'delete_task', 'get_task', 'list_tasklists', 'list_tasks', 'move_task', 'update_task']);
  const lt = tools.find((t) => t.name === 'list_tasks');
  assert.deepEqual(Object.keys(lt.inputSchema.properties).sort(), ['due_from', 'due_to', 'max_results', 'status', 'tasklist_id']);
  assert.equal(tools.find((t) => t.name === 'delete_task').annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === 'list_tasklists').annotations.readOnlyHint, true);
});

await test('list_tasklists marks the default list', async () => {
  const r = await call(tc, 'list_tasklists');
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.count, 2);
  assert.equal(r.json.task_lists[0].is_default, true);
  assert.equal(r.json.task_lists[1].is_default, undefined);
});

await test('create_tasklist', async () => {
  const r = await call(tc, 'create_tasklist', { title: 'Groceries' });
  assert.equal(r.json.task_list.title, 'Groceries');
});

await test('create_task + subtask + previous', async () => {
  let r = await call(tc, 'create_task', { title: 'Parent', notes: 'n1', due: '2026-10-20' });
  assert.equal(r.isError, false, r.text);
  parentId = r.json.task.id;
  assert.equal(r.json.task.due, '2026-10-20');
  assert.equal(r.json.task.status, 'incomplete');
  r = await call(tc, 'create_task', { title: 'Child', parent_task_id: parentId });
  childId = r.json.task.id;
  assert.equal(r.json.task.parent_id, parentId);
  r = await call(tc, 'create_task', { title: 'Other', due: '2026-10-25', previous_task_id: parentId });
  otherId = r.json.task.id;
  r = await call(tc, 'create_task', { title: 'Bad date', due: '2026-02-30' });
  assert.equal(r.isError, true);
  assert.match(r.text, /real date/);
});

await test('list_tasks ordering + exact due-date filters', async () => {
  let r = await call(tc, 'list_tasks');
  assert.deepEqual(r.json.tasks.map((t) => t.title), ['Parent', 'Child', 'Other']);
  const titles = async (args) => (await call(tc, 'list_tasks', args)).json.tasks.map((t) => t.title);
  // 24 = what the real API did; the others model other plausible rules (zones ahead of or behind UTC).
  for (const shift of [24, 47, 0, -3, -14]) {
    G.dueShiftH = shift;
    const at = `(Google due shift ${shift}h)`;
    assert.deepEqual(await titles({ status: 'all', due_from: '2026-10-20', due_to: '2026-10-20' }), ['Parent'], at);
    assert.deepEqual(await titles({ due_from: '2026-10-19', due_to: '2026-10-19' }), [], at);
    assert.deepEqual(await titles({ due_from: '2026-10-21', due_to: '2026-10-21' }), [], at);
    assert.deepEqual(await titles({ due_from: '2026-10-21' }), ['Other'], at);
    assert.deepEqual(await titles({ due_to: '2026-10-24' }), ['Parent'], at);
    assert.deepEqual(await titles({ due_from: '2026-10-20', due_to: '2026-10-25' }), ['Parent', 'Other'], at);
  }
  G.dueShiftH = 24;
  r = await call(tc, 'list_tasks', { due_from: '2026-10-22', due_to: '2026-10-21' });
  assert.equal(r.isError, true);
});

await test('get_task + update_task', async () => {
  let r = await call(tc, 'get_task', { task_id: parentId });
  assert.equal(r.json.notes, 'n1');
  r = await call(tc, 'update_task', { task_id: parentId, title: 'Parent v2', due: 'none', notes: '' });
  assert.equal(r.json.task.title, 'Parent v2');
  assert.equal(r.json.task.due, undefined);
  assert.equal(r.json.task.notes, undefined);
  r = await call(tc, 'update_task', { task_id: parentId });
  assert.equal(r.isError, true);
  assert.match(r.text, /Nothing to update/);
  r = await call(tc, 'get_task', { task_id: 'missing' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Not found/);
});

await test('complete_task + status filters (incl. hidden) + reopen', async () => {
  let r = await call(tc, 'complete_task', { task_id: otherId });
  assert.equal(r.json.task.status, 'completed');
  assert.ok(r.json.task.completed_at);
  G.tasks.get('L1').find((t) => t.id === otherId).hidden = true; // like completing it in the Google app
  r = await call(tc, 'list_tasks');
  assert.deepEqual(r.json.tasks.map((t) => t.title), ['Parent v2', 'Child']);
  r = await call(tc, 'list_tasks', { status: 'completed' });
  assert.deepEqual(r.json.tasks.map((t) => t.title), ['Other']);
  r = await call(tc, 'list_tasks', { status: 'all' });
  assert.equal(r.json.count, 3);
  r = await call(tc, 'update_task', { task_id: otherId, status: 'incomplete' });
  assert.equal(r.json.task.status, 'incomplete');
  assert.equal(r.json.task.completed_at, undefined);
});

await test('move_task to another list, list all lists', async () => {
  let r = await call(tc, 'move_task', { task_id: childId, destination_tasklist_id: 'L2' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.task.list_id, 'L2');
  assert.equal(r.json.task.parent_id, undefined);
  r = await call(tc, 'list_tasks', { tasklist_id: 'all' });
  assert.deepEqual(r.json.tasks.map((t) => `${t.list_title}:${t.title}`).sort(), ['My Tasks:Other', 'My Tasks:Parent v2', 'Work:Child']);
});

await test('delete_task', async () => {
  let r = await call(tc, 'delete_task', { task_id: childId, tasklist_id: 'L2' });
  assert.equal(r.json.deleted, true);
  r = await call(tc, 'list_tasks', { tasklist_id: 'L2' });
  assert.equal(r.json.count, 0);
});

await test('pagination + max_results truncation', async () => {
  for (let i = 0; i < 130; i++) gNewTask('L2', { title: `bulk ${i}` });
  let r = await call(tc, 'list_tasks', { tasklist_id: 'L2', max_results: 500 });
  assert.equal(r.json.count, 130);
  assert.equal(r.json.truncated, false);
  r = await call(tc, 'list_tasks', { tasklist_id: 'L2', max_results: 50 });
  assert.equal(r.json.count, 50);
  assert.equal(r.json.truncated, true);
});

await test('access token cached; expired refresh token reported', async () => {
  const before = G.tokenCalls;
  await call(tc, 'list_tasklists');
  await call(tc, 'list_tasklists');
  assert.equal(G.tokenCalls, before, 'should reuse the cached access token');
  G.access = 'g-access-2'; // Google rotates the access token -> 401 -> one refresh
  let r = await call(tc, 'list_tasklists');
  assert.equal(r.isError, false, r.text);
  process.env.GOOGLE_REFRESH_TOKEN = 'revoked';
  r = await call(tc, 'list_tasklists');
  assert.equal(r.isError, true);
  assert.match(r.text, /refresh token was revoked or expired/);
  process.env.GOOGLE_REFRESH_TOKEN = G.refresh;
});

await test('setup page live test passes', async () => {
  const html = await (await get(`/tasks/${SECRET}/setup`)).text();
  assert.match(html, /Connection test passed/);
  assert.match(html, /Reconnect Google account/);
  assert.match(html, /https:\/\/vercel\.com\/example-team\/example-project\/settings\/environment-variables/);
});

await tc.close();

await test('logs are redacted', () => {
  assert.equal(util.redact('Bearer abcdefghijklmnopqrstuvwxyz123456 ok'), 'Bearer [redacted] ok');
});
