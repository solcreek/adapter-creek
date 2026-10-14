export const runtime = "edge";
export default async function Page() { return <p id="edge-app-page">edge app page, runtime {typeof EdgeRuntime === "string" ? "edge" : "other"}</p>; }
