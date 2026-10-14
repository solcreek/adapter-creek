"use server";
export async function echo(_prev, formData) {
  return `echo:${formData.get("name")}:${typeof EdgeRuntime === "string" ? "edge" : "node"}`;
}
