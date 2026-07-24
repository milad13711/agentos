import { cookies } from 'next/headers';

export const SESSION_COOKIE = 'agentos_session';

/**
 * Reads the AgentOS API token from the httpOnly cookie. Only callable from
 * Server Components, Route Handlers, or Server Actions — never from client code.
 */
export function getSessionToken(): string | null {
  return cookies().get(SESSION_COOKIE)?.value ?? null;
}

/**
 * Sets the session cookie after a successful login/register. httpOnly means
 * client-side JavaScript can never read this value — this is the whole point
 * of routing auth through Next.js instead of storing the token in
 * localStorage (as the local-dev prototype did).
 */
export function setSessionCookie(token: string) {
  // Secure-by-default in production (cookie only sent over HTTPS) — the
  // correct, permanent setting once Caddy is terminating TLS on a real
  // domain. Set ALLOW_INSECURE_COOKIE=1 only for temporary testing over
  // plain HTTP (e.g. hitting the server by raw IP before DNS is set up).
  const secure = process.env.NODE_ENV === 'production' && process.env.ALLOW_INSECURE_COOKIE !== '1';
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 12 // 12h — matches the backend token TTL
  });
}

export function clearSessionCookie() {
  cookies().delete(SESSION_COOKIE);
}
