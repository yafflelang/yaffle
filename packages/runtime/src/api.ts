/** Glue used by the generated root objects (`X.parse`, `X.serialize`, …). */
import { fail } from "./errors.ts";
import { Reader } from "./reader.ts";
import { isAsyncSource, readAll, readAllSync, type Source, type SyncSource } from "./source.ts";
import { Region, Writer, finishRegion, type LStruct } from "./writer.ts";
import type { LayoutItem } from "./layout.ts";
import type { Endian } from "./prim.ts";

/** Options every root accepts. Root parameters are added by the generated options type. */
export interface BaseOptions {
  /** `$endian` at the root (default "le"). */
  endian?: Endian;
  /** Strict mode: padding fill, reserved bits and bool bytes are checked. */
  strict?: boolean;
}

export type SyncInput = Uint8Array | SyncSource;

/** Runs a generated root reader over a sync input. */
export function parseWith<T>(source: SyncInput, opts: BaseOptions, read: (r: Reader) => T): T {
  if (!(source instanceof Uint8Array) && isAsyncSource(source)) {
    fail("INPUT", "this source is async; use parseAsync or an async view");
  }
  return read(new Reader(readAllSync(source), { strict: opts.strict ?? false }));
}

/** Runs a generated root reader (sync or async) over any source. */
export async function parseWithAsync<T>(
  source: Source,
  opts: BaseOptions,
  read: (r: Reader) => T | Promise<T>
): Promise<T> {
  const bytes = await readAll(source);
  return await read(new Reader(bytes, { strict: opts.strict ?? false }));
}

function rootRegion(layout: readonly LayoutItem[] | undefined): Region {
  const region = new Region();
  region.layout = layout;
  return region;
}

/** Runs a generated root writer in a fresh root region and returns the bytes. */
export function serializeWith(
  layout: readonly LayoutItem[] | undefined,
  write: (w: Writer) => LStruct | void
): Uint8Array {
  const region = rootRegion(layout);
  return finishRegion(region, write(new Writer(region)));
}

export async function serializeWithAsync(
  layout: readonly LayoutItem[] | undefined,
  write: (w: Writer) => Promise<LStruct | void>
): Promise<Uint8Array> {
  const region = rootRegion(layout);
  return finishRegion(region, await write(new Writer(region)));
}

/** Checks the options object and returns it. */
export function options<T extends object>(o: T | undefined): T {
  if (o === undefined) return {} as T;
  if (typeof o !== "object" || o === null) fail("INPUT", "options must be an object");
  return o;
}
