import { afterEach, describe, expect, it } from "vitest";

import { readFileSync, promises } from "../src/shims/fs.js";

describe("fs shim user files", () => {
  afterEach(() => {
    delete globalThis.__USER_FILES;
    delete globalThis.__MANIFESTS;
  });

  it("resolves Turbopack hashed server asset paths back to traced source files", async () => {
    globalThis.__USER_FILES = {
      "test/e2e/server-asset-modules/my-data.json": "{\"message\":\"hello world\"}",
    };

    const path = "/server/assets/my-data.0xq5k_kxzo_4n.json";
    expect(readFileSync(path, "utf-8")).toBe("{\"message\":\"hello world\"}");
    await expect(promises.readFile(new URL("file://" + path), { encoding: "utf-8" }))
      .resolves
      .toBe("{\"message\":\"hello world\"}");
  });

  it("does not guess hashed text assets when the original basename is ambiguous", () => {
    globalThis.__USER_FILES = {
      "one/my-data.json": "one",
      "two/my-data.json": "two",
    };

    expect(() => readFileSync("/server/assets/my-data.abc123.json", "utf-8")).toThrow(/ENOENT/);
  });
});
