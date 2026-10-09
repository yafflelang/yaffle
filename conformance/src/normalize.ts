/** Turns cases as written in cases.json into what adapters receive (docs/CONFORMANCE.md §2). */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join, resolve } from "node:path";
import type { Case } from "./adapter.ts";
import { normalizeHex } from "./hex.ts";

export interface NormalizedCase {
  /** The case as adapters get it. */
  case: Case;
  /** Input bytes as hex, when small enough to keep (to check serialize output and round trips). */
  inputHex?: string;
}

/** Inputs of at most this many bytes keep their hex for the runner's own byte checks. */
const MAX_KEEP = 1 << 20;

function readSlice(path: string, offset: number, length: number | undefined): Uint8Array {
  const size = statSync(path).size;
  const len = length ?? size - offset;
  if (offset + len > size)
    throw new Error(
      `slice [${offset}, ${offset + len}) is past the end of ${path} (${size} bytes)`
    );
  const buf = new Uint8Array(len);
  const fd = openSync(path, "r");
  try {
    let done = 0;
    while (done < len) {
      const n = readSync(fd, buf, done, len - done, offset + done);
      if (n === 0) throw new Error(`short read from ${path}`);
      done += n;
    }
  } finally {
    closeSync(fd);
  }
  return buf;
}

/**
 * Normalizes one case: hex without whitespace, and `bytes.file` as an absolute path (slices written
 * to `workDir`).
 */
export function normalizeCase(
  c: Case,
  caseDir: string,
  workDir: string,
  index: number
): NormalizedCase {
  const out: Case = { ...c };
  delete out.expect;
  delete out.description;
  if (c.bytes === undefined) return { case: out };
  if (typeof c.bytes === "string") {
    out.bytes = normalizeHex(c.bytes);
    return { case: out, inputHex: out.bytes };
  }
  const { offset, length } = c.bytes;
  let file = resolve(caseDir, c.bytes.file);
  let inputHex: string | undefined;
  if (offset !== undefined || length !== undefined) {
    const slice = readSlice(file, offset ?? 0, length);
    mkdirSync(workDir, { recursive: true });
    file = join(workDir, `slice-${index}.bin`);
    writeFileSync(file, slice);
    if (slice.length <= MAX_KEEP) inputHex = Buffer.from(slice).toString("hex");
  } else if (statSync(file).size <= MAX_KEEP) {
    inputHex = readFileSync(file).toString("hex");
  }
  out.bytes = { file };
  return inputHex === undefined ? { case: out } : { case: out, inputHex };
}
