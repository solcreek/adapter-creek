import { useEffect, useState } from "react";
export default function WebWorkerPage() {
  const [status, setStatus] = useState("waiting");
  useEffect(() => {
    const worker = new Worker(new URL("../lib/web-worker.js", import.meta.url));
    worker.addEventListener("message", ({ data }) => setStatus(data));
    return () => worker.terminate();
  }, []);
  return <p id="web-worker">web worker page: {status}</p>;
}
