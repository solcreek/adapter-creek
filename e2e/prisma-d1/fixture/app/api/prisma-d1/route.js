import { auth } from "../../../lib/auth";
import { PrismaClient } from "../../../generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const adapter = new PrismaBetterSqlite3({ url: "file:./dev.db" });
    const prisma = new PrismaClient({ adapter });
    // A MODEL query (generated delegate + query compiler), not $queryRaw — the
    // same path Better Auth's getSession uses (session.findFirst).
    await prisma.note.create({ data: { text: "pong" } });
    const notes = await prisma.note.findMany({ take: 1 });
    return Response.json({ ok: true, note: notes?.[0]?.text ?? null, hasAuth: typeof auth?.api?.getSession });
  } catch (e) {
    return new Response(`PRISMA_D1_FAIL: ${e?.message ?? e}`, { status: 500 });
  }
}
