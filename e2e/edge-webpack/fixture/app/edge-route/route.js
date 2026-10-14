export const runtime = "edge";
export function GET(req) { return Response.json({ route: "app-edge", header: req.headers.get("x-from-mw") }); }
