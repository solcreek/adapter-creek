export const dynamic = "force-dynamic";
export function GET(req) { return Response.json({ route: "app-node", header: req.headers.get("x-from-mw") }); }
