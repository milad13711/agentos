import { NextRequest, NextResponse } from 'next/server';
import { API_URL } from '@/lib/backend';
import { getSessionToken } from '@/lib/session';

async function forward(req: NextRequest, path: string[], method: string) {
  const token = getSessionToken();
  if (!token) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = `${API_URL}/api/${path.join('/')}${req.nextUrl.search}`;
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store'
  };

  if (method !== 'GET' && method !== 'DELETE') {
    const bodyText = await req.text();
    if (bodyText) {
      init.body = bodyText;
      init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    }
  }

  const res = await fetch(url, init);
  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  }

  // File passthrough (e.g. .xlsx / .csv report downloads)
  const buf = await res.arrayBuffer();
  return new NextResponse(buf, {
    status: res.status,
    headers: {
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Disposition': res.headers.get('content-disposition') || 'inline'
    }
  });
}

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }) {
  return forward(req, params.path, 'GET');
}
export async function POST(req: NextRequest, { params }: { params: { path: string[] } }) {
  return forward(req, params.path, 'POST');
}
export async function PATCH(req: NextRequest, { params }: { params: { path: string[] } }) {
  return forward(req, params.path, 'PATCH');
}
export async function DELETE(req: NextRequest, { params }: { params: { path: string[] } }) {
  return forward(req, params.path, 'DELETE');
}
