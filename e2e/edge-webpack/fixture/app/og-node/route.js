import { ImageResponse } from "next/og";
// next/og on the node runtime: its yoga wasm is embedded, not traced.
export function GET() {
  return new ImageResponse(<div style={{ display: "flex", fontSize: 48 }}>creek</div>, { width: 200, height: 100 });
}
