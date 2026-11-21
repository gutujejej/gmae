import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Pages that need a signed-in user. The feed itself stays public (anyone can watch).
const PROTECTED = ['/upload', '/profile/edit', '/saved'];
const AUTH_PAGES = ['/login', '/signup'];

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(list: { name: string; value: string; options: CookieOptions }[]) {
          list.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // Always getUser(): it checks the session with Supabase instead of trusting the cookie.
  const { data: { user } } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname; // basePath (/pro) is already removed here
  const needsLogin = PROTECTED.some((p) => path === p || path.startsWith(`${p}/`));

  if (!user && needsLogin) {
    const url = request.nextUrl.clone(); // keeps the /pro prefix
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', path);
    return NextResponse.redirect(url);
  }
  if (user && AUTH_PAGES.includes(path)) {
    const url = request.nextUrl.clone();
    url.pathname = '/feed';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return response;
}
