import { increment } from "../../lib/add";
export const config = { runtime: "edge" };
export default async function handler(req) {
  const input = Number(new URL(req.url).searchParams.get("input")) || 1;
  return Response.json({ input, value: await increment(input) });
}
