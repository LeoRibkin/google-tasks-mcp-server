// Shared helpers: config, crypto, dates, responses, errors, safe logging.
import crypto from 'node:crypto';

export const env = (name) => (process.env[name] ?? '').trim();

export function baseUrl() {
  const explicit = env('PUBLIC_BASE_URL').replace(/\/+$/, '');
  if (explicit) return explicit;
  const prod = env('VERCEL_PROJECT_PRODUCTION_URL');
  return prod ? `https://${prod}` : 'http://localhost:3000';
}

// ---------- errors ----------
export class SetupError extends Error {
  constructor(message) { super(message); this.name = 'SetupError'; }
}
export class ApiError extends Error {
  constructor(status, message) { super(message); this.name = 'ApiError'; this.status = status; }
}
export class InputError extends Error {
  constructor(message) { super(message); this.name = 'InputError'; }
}

// ---------- safe logging (never prints tokens or secrets) ----------
export function redact(value) {
  return String(value ?? '')
    .replace(/[A-Za-z0-9_\-.~+/=]{24,}/g, '[redacted]')
    .slice(0, 400);
}
export function logError(where, err) {
  console.error(`[${where}] ${err?.name || 'Error'}: ${redact(err?.message || err)}`);
}

// ---------- crypto ----------
export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const randomToken = (bytes = 24) => b64url(crypto.randomBytes(bytes));

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function deriveKey(secret, purpose) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'),
    Buffer.from('google-tasks-mcp-server/v1'), Buffer.from(purpose), 32));
}

export function signState(data, key) {
  const payload = b64url(JSON.stringify(data));
  const sig = b64url(crypto.createHmac('sha256', key).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyState(state, key, maxAgeMs = 15 * 60 * 1000) {
  if (typeof state !== 'string') return null;
  const dot = state.indexOf('.');
  if (dot < 1) return null;
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = b64url(crypto.createHmac('sha256', key).update(payload).digest());
  if (!safeEqual(sig, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!data || typeof data.t !== 'number') return null;
  const age = Date.now() - data.t;
  if (age > maxAgeMs || age < -60_000) return null;
  return data;
}

export const pkceVerifier = (key, nonce) =>
  b64url(crypto.createHmac('sha256', key).update(`pkce:${nonce}`).digest());
export const pkceChallenge = (verifier) =>
  b64url(crypto.createHash('sha256').update(verifier).digest());

// ---------- cookies ----------
export function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}
export const setCookie = (name, value, maxAgeSeconds) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;

// ---------- dates ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- responses ----------
export const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
};

export const text = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS, ...headers } });

export const notFound = () => text('Not found', 404);

export const redirect = (location, headers = {}) =>
  new Response(null, { status: 302, headers: { location, ...SECURITY_HEADERS, ...headers } });

export async function readJson(res) {
  const body = await res.text();
  if (!body) return null;
  try { return JSON.parse(body); } catch { return { _raw: body.slice(0, 300) }; }
}
