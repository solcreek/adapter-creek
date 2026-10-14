import { NextResponse } from "next/server";
import { increment } from "./lib/add";
export async function middleware(req) {
  const { pathname } = req.nextUrl;
  if (pathname === "/mw-wasm") {
    return Response.json({ route: "mw-wasm", value: await increment(1) });
  }
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
export const config = { matcher: ["/api/:path*", "/edge-route", "/node-route", "/edge-dyn/:path*", "/rw/:path*", "/rwapi/:path*", "/mw-wasm"] };
