export const config = { runtime: "edge" };
export default function handler(req) {
  const url = new URL(req.url);
  return Response.json({ id: url.searchParams.get("id"), path: url.pathname });
}
