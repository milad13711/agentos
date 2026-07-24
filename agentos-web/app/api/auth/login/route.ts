import { NextResponse } from 'next/server';
import { API_URL } from '@/lib/backend';
import { setSessionCookie } from '@/lib/session';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store'
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    return NextResponse.json({ error: data.error || 'login_failed', message: data.message }, { status: res.status });
  }

  setSessionCookie(data.token);
  // Deliberately omit `token` from the response body — the browser never sees it.
  return NextResponse.json({ user: data.user, tenant: data.tenant });
}
