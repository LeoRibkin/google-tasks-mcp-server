// Google Tasks: OAuth setup flow, API client and MCP tools.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { tool } from './mcp.js';
import { page, messagePage, statusList, copyBox, button, esc } from './pages.js';
import {
  env, baseUrl, SetupError, ApiError, InputError, deriveKey, signState, verifyState,
  pkceVerifier, pkceChallenge, randomToken, readCookie, setCookie, redirect, readJson,
  isValidDate, addDays, safeEqual, logError,
} from './util.js';

const SCOPE = 'https://www.googleapis.com/auth/tasks';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://tasks.googleapis.com/tasks/v1';
export const GOOGLE_CALLBACK_PATH = '/oauth/google/callback';
const COOKIE = '__Host-google_oauth';
const enc = encodeURIComponent;

const cfg = () => ({
  clientId: env('GOOGLE_CLIENT_ID'),
  clientSecret: env('GOOGLE_CLIENT_SECRET'),
  refreshToken: env('GOOGLE_REFRESH_TOKEN'),
});
const redirectUri = () => baseUrl() + GOOGLE_CALLBACK_PATH;
const oauthKey = () => deriveKey(cfg().clientSecret, 'google-oauth');

// ---------------------------------------------------------------- tokens
let cache = null; // { token, exp, key } — in memory only, never logged

async function tokenRequest(params) {
  const { clientId, clientSecret } = cfg();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  return { ok: res.ok, status: res.status, data: (await readJson(res)) || {} };
}

function tokenError(status, data) {
  const code = data?.error;
  if (code === 'invalid_grant') {
    return new SetupError('Google rejected the saved sign-in (the refresh token was revoked or expired). '
      + 'Open your Google Tasks setup page, click "Connect Google account" again, and replace GOOGLE_REFRESH_TOKEN in Vercel with the new value.');
  }
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return new SetupError('Google rejected GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Check that both values in Vercel match the OAuth client in Google Cloud.');
  }
  return new ApiError(status, `Google sign-in failed (HTTP ${status}${code ? `, ${code}` : ''}).`);
}

export async function getAccessToken(force = false) {
  const { clientId, clientSecret, refreshToken } = cfg();
  const missing = [
    !clientId && 'GOOGLE_CLIENT_ID', !clientSecret && 'GOOGLE_CLIENT_SECRET', !refreshToken && 'GOOGLE_REFRESH_TOKEN',
  ].filter(Boolean);
  if (missing.length) {
    throw new SetupError(`The Google Tasks connector is not fully set up (missing in Vercel: ${missing.join(', ')}). `
      + 'Finish the steps on your Google Tasks setup page.');
  }
  const key = `${clientId}|${refreshToken}`;
  if (!force && cache && cache.key === key && cache.exp > Date.now() + 60_000) return cache.token;
  const { ok, status, data } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  if (!ok || !data.access_token) throw tokenError(status, data);
  cache = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000, key };
  return cache.token;
}

function apiError(status, data) {
  const err = data?.error || {};
  const reason = `${err.errors?.[0]?.reason || ''} ${err.status || ''}`;
  const msg = err.message || data?._raw || '';
  if (status === 403 && (/accessNotConfigured|SERVICE_DISABLED/i.test(reason) || /has not been used|is disabled/i.test(msg))) {
    return new ApiError(403, 'The Google Tasks API is not enabled in your Google Cloud project. In Google Cloud Console open '
      + '"APIs & Services" > "Library", search for "Google Tasks API", click Enable, wait a minute and try again.');
  }
  if (status === 403 && /insufficient/i.test(`${reason} ${msg}`)) {
    return new ApiError(403, 'The saved Google sign-in does not include permission to manage tasks. Reconnect on the setup page and tick the Google Tasks checkbox.');
  }
  if (status === 404) return new ApiError(404, 'Not found: that task list or task does not exist (check the IDs with list_tasklists / list_tasks).');
  if (status === 429) return new ApiError(429, 'Google Tasks rate limit reached. Wait a minute and try again.');
  return new ApiError(status, `Google Tasks API error (HTTP ${status})${msg ? `: ${msg}` : ''}`);
}

export async function tasksApi(method, path, { query, body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken(attempt > 0);
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && attempt === 0) continue; // refresh the access token once and retry
    const data = await readJson(res);
    if (!res.ok) throw apiError(res.status, data);
    return data;
  }
}

// ---------------------------------------------------------------- helpers
function formatTask(t, list) {
  const out = { id: t.id, title: t.title ?? '', status: t.status === 'completed' ? 'completed' : 'incomplete' };
  if (t.notes) out.notes = t.notes;
  if (t.due) out.due = t.due.slice(0, 10);
  if (t.completed) out.completed_at = t.completed;
  if (t.parent) out.parent_id = t.parent;
  if (t.links?.length) out.links = t.links.map(({ type, description, link }) => ({ type, description, link }));
  if (t.assignmentInfo?.surfaceType) out.assigned_from = t.assignmentInfo.surfaceType;
  out.updated = t.updated;
  if (t.webViewLink) out.web_link = t.webViewLink;
  if (list) { out.list_id = list.id; if (list.title) out.list_title = list.title; }
  return out;
}

// Same order as the Google Tasks app: top-level tasks by position, each followed by its subtasks.
function orderTasks(items) {
  const byPos = (a, b) => String(a.position || '').localeCompare(String(b.position || ''));
  const ids = new Set(items.map((t) => t.id));
  const children = new Map();
  const top = [];
  for (const t of items) {
    if (t.parent && ids.has(t.parent)) {
      if (!children.has(t.parent)) children.set(t.parent, []);
      children.get(t.parent).push(t);
    } else top.push(t);
  }
  const out = [];
  for (const t of top.sort(byPos)) {
    out.push(t);
    const kids = children.get(t.id);
    if (kids) out.push(...kids.sort(byPos));
  }
  return out;
}

const dueToApi = (d) => `${d}T00:00:00.000Z`;

function checkDate(name, value) {
  if (value !== undefined && !isValidDate(value)) throw new InputError(`${name} must be a real date in YYYY-MM-DD format (got "${value}").`);
}

async function allTaskLists() {
  const lists = [];
  let pageToken;
  do {
    const data = await tasksApi('GET', '/users/@me/lists', { query: { maxResults: 100, pageToken } });
    lists.push(...(data?.items || []));
    pageToken = data?.nextPageToken;
  } while (pageToken && lists.length < 1000);
  return lists;
}

// Google's due-date filter does not line up with calendar days (a task due on the 17th is left
// out by dueMax = the 17th at 23:59:59Z), so we ask Google for a window a couple of days wider
// on each side and then keep only the tasks whose due date really is inside the requested range.
const DUE_MARGIN_DAYS = 2;
const MAX_PAGES = 20;

async function fetchTasks(listId, { status, dueFrom, dueTo, cap }) {
  // showHidden: tasks completed (or cleared) in the Google apps are "hidden"; include them and filter by status ourselves.
  const query = { maxResults: 100, showAssigned: true, showHidden: true, showCompleted: status !== 'incomplete' };
  if (status === 'completed') query.completedMin = '1970-01-01T00:00:00.000Z';
  if (dueFrom) query.dueMin = `${addDays(dueFrom, -DUE_MARGIN_DAYS)}T00:00:00.000Z`;
  if (dueTo) query.dueMax = `${addDays(dueTo, DUE_MARGIN_DAYS)}T23:59:59.999Z`;
  const keep = (t) => {
    if (t.deleted) return false;
    if (status === 'completed' && t.status !== 'completed') return false;
    if (status === 'incomplete' && t.status === 'completed') return false;
    if (dueFrom || dueTo) {
      const due = t.due ? String(t.due).slice(0, 10) : '';
      if (!due || (dueFrom && due < dueFrom) || (dueTo && due > dueTo)) return false;
    }
    return true;
  };
  const tasks = [];
  let pageToken;
  let pages = 0;
  do {
    const data = await tasksApi('GET', `/lists/${enc(listId)}/tasks`, { query: { ...query, pageToken } });
    tasks.push(...(data?.items || []).filter(keep));
    pageToken = data?.nextPageToken;
  } while (pageToken && tasks.length <= cap && ++pages < MAX_PAGES);
  return { tasks: orderTasks(tasks), more: Boolean(pageToken) };
}

// ---------------------------------------------------------------- MCP server
const listId = z.string().min(1).optional()
  .describe('Task list ID from list_tasklists. Omit to use the default list ("My Tasks").');
const taskId = z.string().min(1).describe('Task ID (from list_tasks, get_task or create_task).');
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');

export function createServer() {
  const server = new McpServer(
    { name: 'google-tasks', title: 'Google Tasks', version: '1.0.0' },
    {
      instructions: 'Reads and manages the user\'s Google Tasks. Use list_tasklists to find list IDs (the default list is '
        + 'marked is_default). Due dates are calendar dates (YYYY-MM-DD); Google Tasks does not store a due time. '
        + 'list_tasks returns only incomplete tasks unless status is "completed" or "all". Subtasks carry parent_id. '
        + 'Use complete_task to mark a task done. Confirm with the user before deleting anything.',
    },
  );

  server.registerTool('list_tasklists', {
    title: 'List task lists',
    description: 'List all of the user\'s Google Tasks lists with their IDs. The default list is marked is_default.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async () => {
    const [lists, def] = await Promise.all([
      allTaskLists(),
      tasksApi('GET', '/users/@me/lists/@default').catch(() => null),
    ]);
    return {
      count: lists.length,
      task_lists: lists.map((l) => ({ id: l.id, title: l.title, updated: l.updated, ...(def?.id === l.id ? { is_default: true } : {}) })),
    };
  }));

  server.registerTool('create_tasklist', {
    title: 'Create task list',
    description: 'Create a new Google Tasks list.',
    inputSchema: { title: z.string().min(1).max(1024).describe('Name of the new list.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, tool(async ({ title }) => {
    const l = await tasksApi('POST', '/users/@me/lists', { body: { title } });
    return { created: true, task_list: { id: l.id, title: l.title, updated: l.updated } };
  }));

  server.registerTool('list_tasks', {
    title: 'List tasks',
    description: 'List tasks in one list (or all lists), filtered by status and due-date range. Results are in the same '
      + 'order as the Google Tasks app (subtasks follow their parent). Note: when a due-date filter is used, tasks '
      + 'without a due date are not returned.',
    inputSchema: {
      tasklist_id: z.string().min(1).optional()
        .describe('Task list ID from list_tasklists. Omit for the default list. Use "all" to search every list.'),
      status: z.enum(['incomplete', 'completed', 'all']).optional().describe('Which tasks to return. Default: "incomplete".'),
      due_from: dateStr.optional().describe('Only tasks due on or after this date (YYYY-MM-DD).'),
      due_to: dateStr.optional().describe('Only tasks due on or before this date (YYYY-MM-DD).'),
      max_results: z.number().int().min(1).max(500).optional().describe('Maximum tasks to return (default 100, max 500).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async ({ tasklist_id, status = 'incomplete', due_from, due_to, max_results = 100 }) => {
    checkDate('due_from', due_from);
    checkDate('due_to', due_to);
    if (due_from && due_to && due_from > due_to) throw new InputError('due_from must be on or before due_to.');
    const opts = { status, dueFrom: due_from, dueTo: due_to, cap: max_results };
    const filters = { status, ...(due_from ? { due_from } : {}), ...(due_to ? { due_to } : {}) };
    if (tasklist_id === 'all') {
      const lists = await allTaskLists();
      const results = await Promise.all(lists.map((l) => fetchTasks(l.id, opts)));
      const tasks = results.flatMap((r, i) => r.tasks.map((t) => formatTask(t, lists[i])));
      return {
        tasklist: 'all', ...filters, count: Math.min(tasks.length, max_results),
        truncated: tasks.length > max_results || results.some((r) => r.more), tasks: tasks.slice(0, max_results),
      };
    }
    const id = tasklist_id || '@default';
    const r = await fetchTasks(id, opts);
    return {
      tasklist_id: id, ...filters, count: Math.min(r.tasks.length, max_results),
      truncated: r.tasks.length > max_results || r.more, tasks: r.tasks.slice(0, max_results).map((t) => formatTask(t)),
    };
  }));

  server.registerTool('get_task', {
    title: 'Get task',
    description: 'Get one task with all its details.',
    inputSchema: { task_id: taskId, tasklist_id: listId },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, tool(async ({ task_id, tasklist_id }) => {
    const t = await tasksApi('GET', `/lists/${enc(tasklist_id || '@default')}/tasks/${enc(task_id)}`);
    return formatTask(t);
  }));

  server.registerTool('create_task', {
    title: 'Create task',
    description: 'Create a task (optionally as a subtask of another task). New tasks go to the top of the list unless previous_task_id is given.',
    inputSchema: {
      title: z.string().min(1).max(1024).describe('Task title.'),
      notes: z.string().max(8192).optional().describe('Optional notes / details.'),
      due: dateStr.optional().describe('Optional due date (YYYY-MM-DD). Google Tasks stores the date only, not a time.'),
      tasklist_id: listId,
      parent_task_id: z.string().min(1).optional().describe('Create as a subtask of this task (must be in the same list).'),
      previous_task_id: z.string().min(1).optional().describe('Place the new task right after this sibling task.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, tool(async ({ title, notes, due, tasklist_id, parent_task_id, previous_task_id }) => {
    checkDate('due', due);
    const body = { title };
    if (notes) body.notes = notes;
    if (due) body.due = dueToApi(due);
    const t = await tasksApi('POST', `/lists/${enc(tasklist_id || '@default')}/tasks`, {
      query: { parent: parent_task_id, previous: previous_task_id }, body,
    });
    return { created: true, task: formatTask(t) };
  }));

  server.registerTool('update_task', {
    title: 'Update task',
    description: 'Change a task\'s title, notes, due date and/or status. Only the fields you pass are changed.',
    inputSchema: {
      task_id: taskId,
      tasklist_id: listId,
      title: z.string().min(1).max(1024).optional().describe('New title.'),
      notes: z.string().max(8192).optional().describe('New notes. Pass an empty string to clear the notes.'),
      due: z.string().optional().describe('New due date (YYYY-MM-DD), or "none" to remove the due date.'),
      status: z.enum(['incomplete', 'completed']).optional().describe('Mark completed, or "incomplete" to reopen.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, tool(async ({ task_id, tasklist_id, title, notes, due, status }) => {
    const body = {};
    if (title !== undefined) body.title = title;
    if (notes !== undefined) body.notes = notes === '' ? null : notes;
    if (due !== undefined) {
      if (due === 'none' || due === '') body.due = null;
      else { checkDate('due', due); body.due = dueToApi(due); }
    }
    if (status === 'completed') body.status = 'completed';
    if (status === 'incomplete') { body.status = 'needsAction'; body.completed = null; }
    if (!Object.keys(body).length) throw new InputError('Nothing to update: pass at least one of title, notes, due or status.');
    const t = await tasksApi('PATCH', `/lists/${enc(tasklist_id || '@default')}/tasks/${enc(task_id)}`, { body });
    return { updated: true, task: formatTask(t) };
  }));

  server.registerTool('complete_task', {
    title: 'Complete task',
    description: 'Mark a task as completed.',
    inputSchema: { task_id: taskId, tasklist_id: listId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, tool(async ({ task_id, tasklist_id }) => {
    const t = await tasksApi('PATCH', `/lists/${enc(tasklist_id || '@default')}/tasks/${enc(task_id)}`, { body: { status: 'completed' } });
    return { completed: true, task: formatTask(t) };
  }));

  server.registerTool('delete_task', {
    title: 'Delete task',
    description: 'Permanently delete a task. Ask the user to confirm first.',
    inputSchema: { task_id: taskId, tasklist_id: listId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, tool(async ({ task_id, tasklist_id }) => {
    await tasksApi('DELETE', `/lists/${enc(tasklist_id || '@default')}/tasks/${enc(task_id)}`);
    return { deleted: true, task_id };
  }));

  server.registerTool('move_task', {
    title: 'Move task',
    description: 'Reorder a task, make it a subtask (or top-level task again), or move it to another list.',
    inputSchema: {
      task_id: taskId,
      tasklist_id: z.string().min(1).optional().describe('The list the task is in now. Omit for the default list.'),
      parent_task_id: z.string().min(1).optional().describe('Make it a subtask of this task. Omit to move it to the top level.'),
      previous_task_id: z.string().min(1).optional().describe('Put it right after this sibling task. Omit to make it the first item.'),
      destination_tasklist_id: z.string().min(1).optional().describe('Move it into this other list. Omit to stay in the current list.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, tool(async ({ task_id, tasklist_id, parent_task_id, previous_task_id, destination_tasklist_id }) => {
    const t = await tasksApi('POST', `/lists/${enc(tasklist_id || '@default')}/tasks/${enc(task_id)}/move`, {
      query: { parent: parent_task_id, previous: previous_task_id, destinationTasklist: destination_tasklist_id },
    });
    return {
      moved: true,
      task: formatTask(t, destination_tasklist_id ? { id: destination_tasklist_id } : undefined),
    };
  }));

  return server;
}

// ---------------------------------------------------------------- setup pages
export async function setupPage(prefix) {
  const { clientId, clientSecret, refreshToken } = cfg();
  let test;
  if (clientId && clientSecret && refreshToken) {
    try {
      const data = await tasksApi('GET', '/users/@me/lists', { query: { maxResults: 100 } });
      const names = (data?.items || []).map((l) => l.title);
      test = ['ok', 'Connection test passed',
        `I can see ${names.length} task list(s): ${esc(names.slice(0, 10).join(', '))}${names.length > 10 ? ', …' : ''}`];
    } catch (err) {
      test = ['bad', 'Connection test failed', esc(err.message)];
    }
  } else {
    test = ['todo', 'Connection test', 'Runs automatically once the three items above are done.'];
  }
  const vercelEnv = env('VERCEL_DASHBOARD_URL') ? `${env('VERCEL_DASHBOARD_URL')}/settings/environment-variables` : '';
  const body = `
    <h1>Google Tasks connector</h1>
    <p class="lead">Private setup page &mdash; don't share this link.</p>
    <div class="card">${statusList([
      [clientId ? 'ok' : 'todo', 'GOOGLE_CLIENT_ID saved in Vercel'],
      [clientSecret ? 'ok' : 'todo', 'GOOGLE_CLIENT_SECRET saved in Vercel'],
      [refreshToken ? 'ok' : 'todo', 'GOOGLE_REFRESH_TOKEN saved in Vercel', refreshToken ? '' : 'You get this value by clicking the button below.'],
      test,
    ])}</div>
    <div class="card">
      <h2>Connect your Google account</h2>
      <p>Signs you in with Google and gives you a value to save in Vercel as <code class="inline">GOOGLE_REFRESH_TOKEN</code>.
      Google will warn that the app isn't verified &mdash; that's expected for a personal app: click <b>Advanced</b>, then <b>Go to &hellip; (unsafe)</b>.</p>
      ${button(`${prefix}/connect`, refreshToken ? 'Reconnect Google account' : 'Connect Google account', Boolean(clientId && clientSecret))}
      ${clientId && clientSecret ? '' : '<p class="muted">Available after GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are saved and the app is redeployed.</p>'}
    </div>
    <div class="card">
      <h2>Values you may need</h2>
      <label>Authorized redirect URI (for Google Cloud)</label>${copyBox(redirectUri())}
      <label>Connector URL for Claude (keep private)</label>${copyBox(`${baseUrl()}${prefix}/mcp`)}
      ${vercelEnv ? `<p><a href="${esc(vercelEnv)}" target="_blank" rel="noopener noreferrer">Open Vercel environment variables &#8599;</a></p>` : ''}
    </div>`;
  return page('Google Tasks connector', body);
}

export function connect() {
  const { clientId, clientSecret } = cfg();
  if (!clientId || !clientSecret) {
    return messagePage('Not ready yet', '<p>Save GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel and redeploy first.</p>');
  }
  const key = oauthKey();
  const nonce = randomToken(18);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: signState({ t: Date.now(), n: nonce, s: 'google' }, key),
    code_challenge: pkceChallenge(pkceVerifier(key, nonce)),
    code_challenge_method: 'S256',
  });
  return redirect(`${AUTH_URL}?${params}`, { 'set-cookie': setCookie(COOKIE, nonce, 900) });
}

export async function callback(request, url) {
  const clear = { 'set-cookie': setCookie(COOKIE, '', 0) };
  const { clientId, clientSecret } = cfg();
  if (!clientId || !clientSecret) return messagePage('Not ready yet', '<p>Google client ID/secret are missing in Vercel.</p>');
  const error = url.searchParams.get('error');
  if (error) {
    return messagePage('Google sign-in was not completed', error === 'access_denied'
      ? '<p>The sign-in was cancelled or access was not allowed. Go back to the setup page and try again.</p>'
      : `<p>Google returned an error: <code class="inline">${esc(error)}</code>. Go back to the setup page and try again.</p>`, { headers: clear });
  }
  const key = oauthKey();
  const state = verifyState(url.searchParams.get('state'), key);
  const nonce = readCookie(request, COOKIE);
  if (!state || state.s !== 'google' || !nonce || !safeEqual(nonce, state.n)) {
    return messagePage('Link expired', '<p>This sign-in link expired or was opened in a different browser. Go back to the setup page and click <b>Connect Google account</b> again (in the same browser).</p>', { headers: clear });
  }
  const code = url.searchParams.get('code');
  if (!code) return messagePage('Missing code', '<p>Google did not return an authorization code. Please try again.</p>', { headers: clear });
  const { ok, status, data } = await tokenRequest({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: pkceVerifier(key, state.n),
  });
  if (!ok || !data.access_token) {
    logError('google-callback', new Error(`token exchange failed: HTTP ${status} ${data?.error || ''}`));
    return messagePage('Google refused the sign-in', `<p>Google answered: <code class="inline">${esc(data?.error || `HTTP ${status}`)}</code>. Go back to the setup page and try again.</p>`, { headers: clear });
  }
  if (!String(data.scope || '').split(' ').includes(SCOPE)) {
    return messagePage('Tasks permission missing', '<p>Google did not grant access to your tasks. Try again and, on Google\'s permission screen, make sure the box for <b>Create, edit, organize, and delete all your tasks</b> is ticked.</p>', { headers: clear });
  }
  if (!data.refresh_token) {
    return messagePage('No refresh token', '<p>Google did not return a refresh token. Remove the app at <a href="https://myaccount.google.com/connections" target="_blank" rel="noopener noreferrer">myaccount.google.com/connections</a> and try again.</p>', { headers: clear });
  }
  let check;
  try {
    const r = await fetch(`${API}/users/@me/lists?maxResults=100`, { headers: { authorization: `Bearer ${data.access_token}` } });
    const j = await readJson(r);
    check = r.ok ? `&#10003; Test passed: I can see ${(j?.items || []).length} task list(s).` : esc(apiError(r.status, j).message);
  } catch (err) {
    check = `Test call failed: ${esc(err.message)}`;
  }
  const vercelEnv = env('VERCEL_DASHBOARD_URL') ? `${env('VERCEL_DASHBOARD_URL')}/settings/environment-variables` : '';
  const body = `
    <h1>&#10003; Google account connected</h1>
    <div class="card success"><p>${check}</p></div>
    <div class="card">
      <h2>Last step: save this value in Vercel</h2>
      <p>This is your <b>refresh token</b>. Treat it like a password: don't paste it into a chat or email.</p>
      ${copyBox(data.refresh_token, { multiline: true })}
      <ol>
        <li>Click <b>Copy</b> above.</li>
        <li>Open ${vercelEnv ? `<a href="${esc(vercelEnv)}" target="_blank" rel="noopener noreferrer">Vercel &rarr; Settings &rarr; Environment Variables &#8599;</a>` : 'Vercel &rarr; your project &rarr; Settings &rarr; Environment Variables'}.</li>
        <li>Add a variable with key <code class="inline">GOOGLE_REFRESH_TOKEN</code>, paste the value, switch <b>Sensitive</b> on if you see it, and click <b>Save</b>. (If it already exists, edit it and replace the value.)</li>
        <li>Redeploy so the change takes effect: in Vercel open <b>Deployments</b>, click <b>&hellip;</b> next to the newest deployment and choose <b>Redeploy</b>.</li>
      </ol>
    </div>`;
  return page('Google account connected', body, { headers: clear });
}
