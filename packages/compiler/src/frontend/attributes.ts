/**
 * The attribute registry: every attribute yaffle knows, where it may appear, its arguments and
 * documentation (used by the checker, completion, hover and signature help).
 */

export type AttrTarget =
  "field" | "block" | "struct" | "alias" | "enum" | "bits" | "codec" | "externType" | "layoutItem";

export interface AttrArgSpec {
  name: string;
  /** int: integer expression; expr: any expression; fill: byte or `i => expr`; codec: codec ref; word: one of `words`; string: string literal; endian: endian expression. */
  kind: "int" | "fill" | "codec" | "word" | "string" | "endian";
  optional?: boolean;
  words?: string[];
}

export interface AttrSpec {
  name: string;
  targets: AttrTarget[];
  args: AttrArgSpec[];
  /** Produces an IR layer (order matters; may repeat). */
  layer: boolean;
  /** May appear more than once on the same target. */
  repeatable: boolean;
  /** Only meaningful on pointer fields. */
  pointerOnly?: boolean;
  /** Named-only arguments: `from:` and `offset:` on @align/@alignEnd. */
  named?: AttrArgSpec[];
  /** Padding that takes the `strict` word last: its fill is checked on read. */
  strictWord?: boolean;
  doc: string;
}

const fill: AttrArgSpec = { name: "fill", kind: "fill", optional: true };
const origin: AttrArgSpec[] = [
  { name: "from", kind: "word", optional: true, words: ["file", "base"] },
  { name: "offset", kind: "int", optional: true }
];
const STRICT_DOC =
  " `strict` as the last argument checks this padding's fill on read (`@padUntil(0x80, strict)`).";
const ORIGIN_DOC =
  " `from: file` measures from the start of the file (or decoded region, or stream) instead of the nearest `@base`; `offset: k` aligns the position k bytes ahead (`@align(4, offset: 0x19)` pads until (pos + 0x19) % 4 == 0).";

/** An attribute as written in the registry below (`name` is its key; flags default to false). */
type AttrDefinition = Omit<AttrSpec, "name" | "layer" | "repeatable"> &
  Partial<Pick<AttrSpec, "layer" | "repeatable">>;

const DEFINITIONS: Record<string, AttrDefinition> = {
  size: {
    targets: ["field", "block", "struct", "alias", "externType"],
    args: [{ name: "n", kind: "int" }],
    layer: true,
    repeatable: true,
    doc: "Exactly `n` bytes. Measures whatever it wraps: inside `@via` it is the decoded size, outside it the size on disk. A size field used here is derived. On an `extern type`, declares a fixed size."
  },
  via: {
    targets: ["field", "block", "struct", "alias"],
    args: [{ name: "codec", kind: "codec" }],
    layer: true,
    repeatable: true,
    doc: "Runs the wrapped content through a codec (`extern codec`): the wrapped content is the codec's decoded side."
  },
  align: {
    targets: ["field", "block", "struct", "alias", "layoutItem"],
    args: [{ name: "to", kind: "int" }, fill],
    named: origin,
    strictWord: true,
    layer: true,
    repeatable: true,
    doc:
      "Pad before until the offset from the nearest `@base` is a multiple of `to`. In `layout`, aligns every target the item places." +
      ORIGIN_DOC +
      STRICT_DOC
  },
  padBefore: {
    targets: ["field", "block", "struct", "alias"],
    args: [{ name: "n", kind: "int" }, fill],
    strictWord: true,
    layer: true,
    repeatable: true,
    doc: "`n` padding bytes before the content." + STRICT_DOC
  },
  padAfter: {
    targets: ["field", "block", "struct", "alias"],
    args: [{ name: "n", kind: "int" }, fill],
    strictWord: true,
    layer: true,
    repeatable: true,
    doc: "`n` padding bytes after the content." + STRICT_DOC
  },
  padUntil: {
    targets: ["field", "block", "struct", "alias"],
    args: [{ name: "size", kind: "int" }, fill],
    strictWord: true,
    layer: true,
    repeatable: true,
    doc:
      "Pad after the content until it occupies exactly `size` bytes. Content larger than `size` is an error." +
      STRICT_DOC
  },
  alignEnd: {
    targets: ["field", "block", "struct", "alias"],
    args: [{ name: "to", kind: "int" }, fill],
    named: origin,
    strictWord: true,
    layer: true,
    repeatable: true,
    doc:
      "Pad after the content until its end offset (from the nearest `@base`) is a multiple of `to`." +
      ORIGIN_DOC +
      STRICT_DOC
  },
  endian: {
    targets: ["field", "block", "struct", "alias"],
    args: [{ name: "order", kind: "endian" }],
    layer: true,
    doc: "Sets `$endian` (`le` or `be`) for everything inside."
  },
  strict: {
    targets: ["field", "block", "struct", "bits"],
    args: [],
    layer: true,
    doc: "Padding fill and reserved bits inside are checked on read."
  },
  base: {
    targets: ["struct"],
    args: [],
    doc: "Pointers and `at` offsets inside count from this struct's first byte."
  },
  hidden: {
    targets: ["field"],
    args: [],
    doc: "Not in the input or output types. The field must be derived or computed (`= …`)."
  },
  relative: {
    targets: ["field"],
    args: [],
    pointerOnly: true,
    doc: "The pointer's target is at the address of this field plus the (signed) stored value."
  },
  nullable: {
    targets: ["field"],
    args: [{ name: "value", kind: "int", optional: true }],
    pointerOnly: true,
    doc: "A stored value of 0 (or the given value) means null. `@nullable(empty)` on a pointer to an array or an `at` array: an empty array is written as 0, and 0 reads as an empty array."
  },
  origin: {
    targets: ["field"],
    args: [{ name: "offset", kind: "int" }],
    pointerOnly: true,
    doc: "The stored offset counts from `offset` (from the base) instead of the base: target = base + offset + value. It may use `offsetof` of any field of the struct, and `offsetof(this)` for the struct's start."
  },
  ref: {
    targets: ["field"],
    args: [],
    pointerOnly: true,
    doc: "The pointer doesn't own its target: on write it points at an equal value already placed in the same base."
  },
  encoding: {
    targets: ["field", "alias"],
    args: [{ name: "encoding", kind: "string" }],
    doc: 'Text encoding of `char` data: "utf8" (default), "ascii" or "latin1".'
  },
  split: {
    targets: ["field"],
    args: [{ name: "policy", kind: "word", words: ["fit", "sizes"] }],
    doc: "How the writer splits a `from arr[*].field` stream into pieces: `fit` (largest piece whose encoded form fits its block) or `sizes` (the pieces' size fields from the input)."
  },
  open: {
    targets: ["enum"],
    args: [],
    doc: "Unknown values pass through as numbers instead of failing."
  },
  bitorder: {
    targets: ["bits", "struct"],
    args: [{ name: "order", kind: "word", words: ["lsb", "msb"] }],
    doc: "Bit allocation order of bitfields: `lsb` (default, first field in the lowest bits) or `msb`."
  },
  ranged: {
    targets: ["codec"],
    args: [],
    doc: "The codec can decode any slice given its position, so lazy views decode only what they read."
  },
  streaming: {
    targets: ["codec"],
    args: [],
    doc: "The codec finds its own end: it reports how many encoded bytes it consumed."
  }
};

export const ATTRIBUTES: Record<string, AttrSpec> = Object.fromEntries(
  Object.entries(DEFINITIONS).map(([name, d]) => [
    name,
    { name, layer: false, repeatable: false, ...d }
  ])
);

export function attributeSignature(spec: AttrSpec): string {
  if (!spec.args.length) return `@${spec.name}`;
  const parts = spec.args.map(a => (a.optional ? `${a.name}?` : a.name));
  if (spec.strictWord) parts.push("strict?");
  for (const n of spec.named ?? [])
    parts.push(`${n.name}: ${n.words ? n.words.join(" | ") : n.kind === "int" ? "n" : n.kind}`);
  return `@${spec.name}(${parts.join(", ")})`;
}

export function targetLabel(t: AttrTarget): string {
  switch (t) {
    case "field":
      return "fields";
    case "block":
      return "blocks";
    case "struct":
      return "structs";
    case "alias":
      return "type aliases";
    case "enum":
      return "enums";
    case "bits":
      return "bits blocks";
    case "codec":
      return "extern codecs";
    case "externType":
      return "extern types";
    case "layoutItem":
      return "layout items";
  }
}
