/**
 * Deploy manifest for Creek CLI.
 *
 * Written to .creek/adapter-output/manifest.json after build.
 * Creek CLI reads this to know how to upload and deploy.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { DeployManifestBase } from "@solcreek/adapter-core";

const require = createRequire(import.meta.url);
const adapterPackage = require("../package.json") as { name?: string; version?: string };

export interface DeployManifest extends DeployManifestBase {
  /** Main worker entry file name (relative to server/) */
  entrypoint: string;
  /** All files in server/ directory */
  serverFiles: string[];
  /** Asset directory name (relative to adapter-output/) */
  assetDir: "assets";
  /** CF Workers compatibility settings */
  compatibilityDate: string;
  compatibilityFlags: string[];
  /** Whether middleware is present */
  hasMiddleware: boolean;
  /** Whether prerenders exist (signals ISR support needed) */
  hasPrerender: boolean;
  /** Signals control-plane to inject DO bindings for ISR cache */
  doBindings: boolean;
}

export async function writeManifest(
  outputDir: string,
  opts: {
    buildId: string;
    nextVersion: string;
    entrypoint: string;
    serverFiles: string[];
    hasMiddleware: boolean;
    hasPrerender: boolean;
  },
): Promise<void> {
  const manifest: DeployManifest = {
    version: 1,
    buildId: opts.buildId,
    nextVersion: opts.nextVersion,
    framework: "nextjs",
    adapter: {
      name: adapterPackage.name ?? "@solcreek/adapter-creek",
      version: adapterPackage.version ?? "0.0.0",
    },
    entrypoint: opts.entrypoint,
    serverFiles: opts.serverFiles,
    assetDir: "assets",
    compatibilityDate: "2026-03-28",
    compatibilityFlags: ["nodejs_compat_v2"],
    hasMiddleware: opts.hasMiddleware,
    hasPrerender: opts.hasPrerender,
    // Always inject DO bindings for Next.js SSR (ISR cache support)
    doBindings: true,
  };

  await fs.writeFile(
    path.join(outputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}
