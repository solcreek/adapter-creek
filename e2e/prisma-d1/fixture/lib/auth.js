// Mirrors the customer: Better Auth backed by the Prisma adapter over the same
// PrismaClient that creek swaps onto D1. Present so Better Auth's code lands in
// the same worker bundle — the hypothesised trigger for the 0.2.13 minify break.
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: "file:./dev.db" }) });

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "sqlite" }),
  emailAndPassword: { enabled: true },
  secret: "e2e-secret-not-for-production",
});
