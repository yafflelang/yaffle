/**
 * Codecs (`@via`): calling host codecs, and codec reuse for byte-exact rebuilds
 * (docs/IR.md §3.6). A value read from a codec's decoded side remembers the original encoded
 * bytes and a private copy of the decoded bytes. When the same object is serialized and its plain
 * encoding is unchanged, the original encoded bytes are reused instead of re-encoding.
 */
import { fail, wrapHostError } from "./errors.ts";
import { isThenable } from "./source.ts";

export interface CodecCtx {
  args: unknown[];
  outputSize?: number;
  position?: number;
}

/** Host shape (docs/IR.md §5). Async codecs return Promises; streaming codecs return `{ output, consumed }`. */
export interface Codec {
  decode(input: Uint8Array, ctx: CodecCtx): unknown;
  encode(input: Uint8Array, ctx: CodecCtx): unknown;
}

export interface Decoded {
  output: Uint8Array;
  /** Encoded bytes consumed (the whole input unless streaming). */
  consumed: number;
}

type Op = "decode" | "encode";

/** Calls the host; its failures become CODEC errors. */
function call(name: string, op: Op, offset: number, run: () => unknown): unknown {
  try {
    return run();
  } catch (e) {
    return wrapHostError(e, "CODEC", `codec ${name} failed to ${op}`, offset);
  }
}

async function callAsync(
  name: string,
  op: Op,
  offset: number,
  run: () => unknown
): Promise<unknown> {
  try {
    return await run();
  } catch (e) {
    return wrapHostError(e, "CODEC", `codec ${name} failed to ${op}`, offset);
  }
}

/** A sync call's result: an async codec there is a CODEC error. */
function syncResult(name: string, out: unknown, use: string, offset: number): unknown {
  if (isThenable(out)) {
    Promise.resolve(out).catch(() => undefined);
    fail("CODEC", `codec ${name} is async; use ${use}`, offset);
  }
  return out;
}

function decoded(
  name: string,
  out: unknown,
  input: Uint8Array,
  streaming: boolean,
  offset: number
): Decoded {
  if (streaming) {
    const o = out as { output?: unknown; consumed?: unknown } | null;
    if (!o || !(o.output instanceof Uint8Array) || typeof o.consumed !== "number") {
      return fail("CODEC", `streaming codec ${name} must return { output, consumed }`, offset);
    }
    if (o.consumed < 0 || o.consumed > input.length) {
      return fail(
        "CODEC",
        `streaming codec ${name} consumed ${o.consumed} of ${input.length} bytes`,
        offset
      );
    }
    return { output: o.output, consumed: o.consumed };
  }
  if (!(out instanceof Uint8Array))
    return fail("CODEC", `codec ${name} decode returned ${typeof out}`, offset);
  return { output: out, consumed: input.length };
}

function encoded(name: string, out: unknown): Uint8Array {
  if (!(out instanceof Uint8Array)) fail("CODEC", `codec ${name} encode returned ${typeof out}`);
  return out;
}

/** Decodes synchronously. An async codec here is a CODEC error (use parseAsync). */
export function decode(
  codec: Codec,
  name: string,
  input: Uint8Array,
  ctx: CodecCtx,
  streaming: boolean,
  offset = -1
): Decoded {
  const out = call(name, "decode", offset, () => codec.decode(input, ctx));
  return decoded(name, syncResult(name, out, "parseAsync", offset), input, streaming, offset);
}

export async function decodeAsync(
  codec: Codec,
  name: string,
  input: Uint8Array,
  ctx: CodecCtx,
  streaming: boolean,
  offset = -1
): Promise<Decoded> {
  const out = await callAsync(name, "decode", offset, () => codec.decode(input, ctx));
  return decoded(name, out, input, streaming, offset);
}

export function encode(codec: Codec, name: string, input: Uint8Array, ctx: CodecCtx): Uint8Array {
  const out = call(name, "encode", -1, () => codec.encode(input, ctx));
  return encoded(name, syncResult(name, out, "serializeAsync", -1));
}

export async function encodeAsync(
  codec: Codec,
  name: string,
  input: Uint8Array,
  ctx: CodecCtx
): Promise<Uint8Array> {
  return encoded(name, await callAsync(name, "encode", -1, () => codec.encode(input, ctx)));
}

// ── reuse ─────────────────────────────────────────────────────────────────────

interface Origin {
  encoded: Uint8Array;
  decoded: Uint8Array;
}

const origins = new WeakMap<object, Map<string, Origin>>();

/**
 * Remembers that `value` (the content inside a `via` layer) was decoded from `encoded`.
 * `slot` distinguishes nested layers ("field#layer"). `decoded` must not be aliased by values.
 */
export function rememberCodec(
  value: unknown,
  slot: string,
  encoded: Uint8Array,
  decoded: Uint8Array
): void {
  if (typeof value !== "object" || value === null) return;
  let m = origins.get(value);
  if (!m) {
    m = new Map();
    origins.set(value, m);
  }
  m.set(slot, { encoded, decoded });
}

/** The original encoded bytes if `value` came from a parse and its plain encoding is unchanged. */
export function reuseCodec(
  value: unknown,
  slot: string,
  plain: Uint8Array
): Uint8Array | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const o = origins.get(value)?.get(slot);
  if (!o) return undefined;
  if (o.decoded.length !== plain.length) return undefined;
  for (let i = 0; i < plain.length; i++) if (o.decoded[i] !== plain[i]) return undefined;
  return o.encoded;
}

// ── streams ───────────────────────────────────────────────────────────────────

/** Joins pieces into one stream. */
export function joinStream(pieces: readonly Uint8Array[]): Uint8Array {
  if (pieces.length === 1) return pieces[0]!;
  let n = 0;
  for (const p of pieces) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `raw[a..b]` (end exclusive; omitted = to the end). */
export function sliceStream(s: Uint8Array, start: number, end?: number): Uint8Array {
  const e = end ?? s.length;
  if (start < 0 || e > s.length || start > e) {
    fail("EOF", `stream slice [${start}, ${e}) is outside the stream of ${s.length} bytes`);
  }
  return s.subarray(start, e);
}

/**
 * Write side of a joined stream: splits `data` into pieces of the given sizes (the last piece
 * takes the rest when `sizes` is shorter or sums to less).
 */
export function splitBySizes(data: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  for (let i = 0; i < sizes.length; i++) {
    const n = sizes[i]!;
    if (at + n > data.length) fail("DERIVE", `piece sizes exceed the stream length ${data.length}`);
    out.push(data.subarray(at, at + n));
    at += n;
  }
  if (at !== data.length) fail("DERIVE", `piece sizes cover ${at} of ${data.length} stream bytes`);
  return out;
}
