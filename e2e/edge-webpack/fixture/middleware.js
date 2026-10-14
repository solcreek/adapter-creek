import { NextResponse } from "next/server";
export function middleware(req) {
  const headers = new Headers(req.headers);
  headers.set("x-from-mw", "yes");
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-mw-ran", "1");
  return res;
}
export const config = { matcher: ["/api/:path*", "/edge-route", "/node-route", "/edge-dyn/:path*"] };
