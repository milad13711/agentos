import { NextRequest, NextResponse } from 'next/server';
import { backendFetch, BackendError } from '@/lib/backend';

// Zarinpal redirects the user's browser here with ?Authority=...&Status=OK|NOK
// after they complete (or cancel) payment. Because the browser still carries
// our httpOnly session cookie, we can safely call the backend's authenticated
// verify endpoint from here before telling the user it worked.
export async function GET(req: NextRequest) {
  const authority = req.nextUrl.searchParams.get('Authority');
  const status = req.nextUrl.searchParams.get('Status');
  const base = req.nextUrl.origin;

  if (!authority) {
    return NextResponse.redirect(`${base}/billing?payment=error&message=missing_authority`);
  }

  try {
    const result = await backendFetch('/api/billing/verify', {
      method: 'POST',
      body: JSON.stringify({ authority, status })
    });
    return NextResponse.redirect(`${base}/billing?payment=success&plan=${result.planKey}`);
  } catch (e) {
    if (e instanceof BackendError && (e.status === 401 || e.status === 403)) {
      return NextResponse.redirect(`${base}/login`);
    }
    const message = e instanceof BackendError ? e.message : 'unknown_error';
    return NextResponse.redirect(`${base}/billing?payment=error&message=${encodeURIComponent(message)}`);
  }
}
