"use client";
import { useActionState } from "react";
import { echo } from "./actions";
// Imported by a node page and an edge page: the action then has a module id in
// each runtime's build, and an edge POST must dispatch to the edge one.
export default function ActionForm() {
  const [result, action] = useActionState(echo, null);
  return (
    <form action={action}>
      <input type="hidden" name="name" value="creek" />
      <p id="result">{result ?? "none"}</p>
      <button id="submit">Submit</button>
    </form>
  );
}
