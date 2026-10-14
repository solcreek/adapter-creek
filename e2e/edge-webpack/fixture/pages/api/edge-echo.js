export const config = { runtime: "edge" };
export default async function handler(req) {
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.text() : null;
  return Response.json({ method: req.method, body, q: url.searchParams.get("q"), header: req.headers.get("x-from-mw") });
}
