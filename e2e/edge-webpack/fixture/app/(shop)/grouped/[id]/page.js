"use client";
// A client page under a route group: its RSC payload must list this page's
// client chunk, or a soft navigation here fails in the browser.
export default function Grouped() {
  return <p id="grouped">grouped client page</p>;
}
