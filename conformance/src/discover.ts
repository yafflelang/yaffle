/** Finds backend adapters at packages/compiler/src/backends/<target>/conformance.ts. */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConformanceAdapter } from "./adapter.ts";

export interface DiscoveredAdapter {
  target: string;
  /** Absolute path of the adapter module. */
  module: string;
  adapter?: ConformanceAdapter;
  /** Set when the adapter can't be used: load error, bad shape, or `available()` false. */
  unavailable?: string;
}

function isConformanceAdapter(x: unknown): x is ConformanceAdapter {
  if (x === null || typeof x !== "object") return false;
  const a = x as Record<string, unknown>;
  return (
    typeof a.target === "string" && typeof a.available === "function" && typeof a.run === "function"
  );
}

/** Lists `<backendsDir>/<target>/conformance.ts` files, sorted by target name. */
export function findAdapterModules(backendsDir: string): { target: string; module: string }[] {
  if (!existsSync(backendsDir)) return [];
  const out: { target: string; module: string }[] = [];
  for (const name of readdirSync(backendsDir).sort()) {
    const dir = join(backendsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const module = join(dir, "conformance.ts");
    if (existsSync(module)) out.push({ target: name, module });
  }
  return out;
}

/**
 * Imports each adapter module and asks it whether it is available. Never throws: problems are
 * reported per adapter in `unavailable`. `targets` (if given) restricts which targets are loaded.
 */
export async function discoverAdapters(
  backendsDir: string,
  targets?: string[]
): Promise<DiscoveredAdapter[]> {
  const out: DiscoveredAdapter[] = [];
  for (const { target, module } of findAdapterModules(backendsDir)) {
    if (targets !== undefined && !targets.includes(target)) continue;
    out.push(await loadAdapter(target, module));
  }
  return out;
}

export async function loadAdapter(target: string, module: string): Promise<DiscoveredAdapter> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(module).href)) as Record<string, unknown>;
  } catch (e) {
    return { target, module, unavailable: `failed to load ${module}: ${(e as Error).message}` };
  }
  const adapter = mod.adapter ?? mod.default;
  if (!isConformanceAdapter(adapter)) {
    return {
      target,
      module,
      unavailable: `${module} does not export \`adapter: ConformanceAdapter\``
    };
  }
  return checkAvailable({ target, module, adapter });
}

export async function checkAvailable(d: DiscoveredAdapter): Promise<DiscoveredAdapter> {
  if (d.adapter === undefined) return d;
  try {
    if (!(await d.adapter.available()))
      return { ...d, unavailable: `${d.target}: toolchain not available` };
  } catch (e) {
    return { ...d, unavailable: `${d.target}: available() failed: ${(e as Error).message}` };
  }
  return d;
}
