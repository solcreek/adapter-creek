export const runtime = "edge";
export async function GET(req, { params }) { const { slug } = await params; return Response.json({ slug }); }
export async function POST(req) { return Response.json({ echoed: await req.json() }); }
