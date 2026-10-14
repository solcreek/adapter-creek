import { NextResponse } from "next/server";
export function middleware(req) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/rw/")) {
    const url = req.nextUrl.clone();
    url.pathname = "/edge-ssr-dyn/" + pathname.slice(4);
    return NextResponse.rewrite(url);
  }
  if (pathname.startsWith("/rwapi/")) {
    const url = req.nextUrl.clone();
    url.pathname = "/api/edge-dyn/" + pathname.slice(7);
    return NextResponse.rewrite(url);
  }
  const headers = new Headers(req.headers);
  headers.set("x-from-mw", "yes");
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-mw-ran", "1");
  return res;
}
export const config = { matcher: ["/api/:path*", "/edge-route", "/node-route", "/edge-dyn/:path*", "/rw/:path*", "/rwapi/:path*"] };
