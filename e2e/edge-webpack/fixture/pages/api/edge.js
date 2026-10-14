export const config = { runtime: "edge" };
export default function handler(req) {
  return Response.json({ route: "pages-edge", header: req.headers.get("x-from-mw"), url: new URL(req.url).pathname });
}
