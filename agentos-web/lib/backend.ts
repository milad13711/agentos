import { getSessionToken } from './session';

const API_URL = process.env.AGENTOS_API_URL || 'http://localhost:8787';

export class BackendError extends Error {
  status: number;
  data: any;
  constructor(message: string, status: number, data: any) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/**
 * Server-only fetch wrapper for calling the real AgentOS backend.
 * Automatically attaches the session token from the httpOnly cookie.
 * Use from Server Components, Route Handlers, and Server Actions ONLY.
 */
export async function backendFetch(path: string, init: RequestInit = {}) {
  const token = getSessionToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    },
    cache: 'no-store'
  });

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    throw new BackendError((data && (data.message || data.error)) || 'request_failed', res.status, data);
  }
  return data;
}

/** Unauthenticated fetch, for public endpoints like /api/plans on the marketing page. */
export async function backendFetchPublic(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_URL}${path}`, { ...init, cache: 'no-store' });
  if (!res.ok) throw new BackendError('request_failed', res.status, null);
  return res.json();
}

export { API_URL };
