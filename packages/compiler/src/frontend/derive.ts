/**
 * Derivation and consistency (derived fields in DESIGN.md).
 *
 * Read-side uses of a field ("sources") let the writer compute it:
 * - array/bytes/string lengths    `Entry e[count]`        → count = e.length
 * - `@size` layers                `T b @size(n)`          → n = encodedSize(b, i)
 * - placements                    `T t at ofs * 0x800`    → ofs = offsetof(t) / 0x800 (+ constraint)
 * - struct arguments              `Blob(n) b`             → n = (Blob's own derivation of its param)
 * Linear expressions over one field (`+ − ×` and `<<` with constants) are inverted. Explicit
 * formulas are sampled against the read side: contradictions are errors, partial agreement and
 * lossy formulas are warnings, formulas equal to what the field would be derived as are hints.
 */
import type { Ctx } from "./ctx.ts";
import { removalFix, type Related } from "./diagnostics.ts";
import type { Elaborator } from "./elaborate.ts";
import { intLit, literalInt } from "./expr.ts";
import type { IrBuiltinFn, IrExpr, IrField, IrLayer, IrType, IrValueType } from "../ir/index.ts";
import { fieldRefs, mapExpr, walkExpr } from "../ir/walk.ts";
import { evalIr, invertLinear, irEqual, linear } from "./invert.ts";
import type { FieldResult, StructResult } from "./model.ts";
import { printIrExpr } from "./printer.ts";
import { widenLeft } from "./source.ts";
import type { FieldSym } from "./symbols.ts";
import { BIGINT, STRING, coreType, isIntType, isIrField, valueTypeOf } from "./types.ts";

interface Source {
  kind: "len" | "size" | "at" | "arg";
  field: FieldSym;
  /** The read-side expression that uses the derived field. */
  expr: IrExpr;
  /** What the writer measures (`len(f)`, `offsetof(f)`, `encodedSize(f, i)`, …). */
  measure: IrExpr;
  /** Normalized key of `measure` for sampling. */
  key: string;
  describe: string;
}

/** `u16[lens[$index]] *lists[9] : u64`: `lens` is derived as `lengths(lists)`. */
interface Elementwise {
  field: FieldSym;
  /** The array field holding the per-element lengths. */
  target: string;
  measure: IrExpr;
}

/** Measures a formula is sampled at (counts, sizes, offsets). */
const SAMPLES = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 100, 255, 256, 1000, 4096
].map(BigInt);

const MEASURES = ["len", "encodedLength", "offsetof", "sizeof", "encodedSize"];

function call(name: IrBuiltinFn, args: IrExpr[], type: IrValueType = BIGINT): IrExpr {
  return { kind: "call", callee: { kind: "builtin", name }, args, type };
}

export function analyzeDerivations(el: Elaborator, ctx: Ctx, result: StructResult): void {
  const fields = [...result.fields.values()].sort((a, b) => a.sym.order - b.sym.order);
  const byName = new Map<string, FieldResult[]>();
  for (const f of fields) {
    if (!f.sym.name) continue;
    const l = byName.get(f.sym.name) ?? [];
    l.push(f);
    byName.set(f.sym.name, l);
  }
  const elementwise: Elementwise[] = [];
  const sources = collectSources(el, fields, elementwise);
  deriveFromSources(result, sources, byName);
  deriveElementwise(elementwise, byName);
  markFixedPlacements(fields, byName);
  if (ctx.report) {
    for (const x of fields) {
      if (x.ir.deriveKind !== "formula" || !x.ir.derive || x.ir.input === "required") continue;
      const src = sources.find(s => fieldRefs(s.expr).has(x.sym.name));
      if (src) analyzeFormula(el, ctx, x, x.ir.derive, src);
    }
    // reported once every struct is checked (program.ts): a field consumed by a stream
    // is derived by the writer, and the pieces of `from arr[*].piece` live in other structs
    for (const f of fields) {
      const ir = f.ir as IrField;
      if (ir.kind === "field" && ir.hidden && !ir.derive && !result.streamFields.has(f.sym.name))
        result.hiddenCandidates.push(f);
    }
  }
  reportLayoutCycles(el, ctx, fields, byName);
  // for callers passing a field as an argument
  for (const p of result.sym.params) {
    if (p.bound) continue;
    for (const src of sources) {
      const lin = linearParam(src.expr);
      if (!lin || lin.name !== p.name) continue;
      result.paramDerivations.set(p.name, invertLinear({ a: lin.a, b: lin.b }, src.measure));
      break;
    }
  }
}

function setDerived(x: FieldResult, derive: IrExpr, source: string): void {
  x.ir.derive = derive;
  x.ir.deriveKind = "auto";
  x.ir.input = "absent";
  x.deriveDisplay = printIrExpr(derive);
  x.deriveSource = source;
}

/** Each field is derived from the first source linear in it (later ones are checked on write). */
function deriveFromSources(
  result: StructResult,
  sources: Source[],
  byName: Map<string, FieldResult[]>
): void {
  for (const src of sources) {
    const lin = linear(src.expr);
    if (!lin || !lin.x || lin.a === 0n) continue;
    const cands = byName.get(lin.x.name);
    if (!cands || cands.length !== 1) continue;
    const x = cands[0]!;
    // an explicit formula, or already derived by an earlier source (shared count)
    if (!derivable(x) || x.ir.derive) continue;
    if (!isPrefix(src.field.frames, x.sym.frames)) continue;
    setDerived(x, invertLinear(lin, src.measure), src.describe);
    if (src.kind !== "at") continue;
    const placement = (result.fields.get(src.field)?.ir as IrField | undefined)?.placement;
    const m = lin.a < 0n ? -lin.a : lin.a;
    if (placement && m > 1n)
      placement.constraint = {
        modulus: m.toString(),
        remainder: (((lin.b % m) + m) % m).toString()
      };
  }
}

function deriveElementwise(elementwise: Elementwise[], byName: Map<string, FieldResult[]>): void {
  for (const ew of elementwise) {
    const cands = byName.get(ew.target);
    if (!cands || cands.length !== 1) continue;
    const x = cands[0]!;
    if (x.ir.derive || !isIrField(x.ir) || x.ir.placement || x.ir.from) continue;
    const t = coreType(x.ir.type);
    if (t.kind !== "array" || !isIntType(valueTypeOf(t.element))) continue;
    if (!isPrefix(ew.field.frames, x.sym.frames)) continue;
    setDerived(x, ew.measure, `element lengths of ${ew.field.name}`);
  }
}

/** A placement is `fixed` unless every field its offset uses is derived by the writer. */
function markFixedPlacements(fields: FieldResult[], byName: Map<string, FieldResult[]>): void {
  for (const f of fields) {
    const ir = f.ir as IrField;
    if (ir.kind !== "field" || !ir.placement) continue;
    const refs = fieldRefs(ir.placement.offset);
    let usesOther = false;
    walkExpr(ir.placement.offset, e => {
      if (
        e.kind === "param" ||
        e.kind === "builtinValue" ||
        e.kind === "member" ||
        e.kind === "call"
      )
        usesOther = true;
    });
    const allDerived =
      refs.size > 0 &&
      [...refs].every(n =>
        (byName.get(n) ?? []).every(r => r.ir.derive && !r.ir.input.startsWith("req"))
      );
    ir.placement.fixed = !(allDerived && !usesOther);
  }
}

/** A variable-size derived value that depends on a position would move what it points at. */
function reportLayoutCycles(
  el: Elaborator,
  ctx: Ctx,
  fields: FieldResult[],
  byName: Map<string, FieldResult[]>
): void {
  const dependsOnPosition = (f: FieldResult, seen: Set<FieldResult>): boolean => {
    if (!f.ir.derive || seen.has(f)) return false;
    seen.add(f);
    let dep = false;
    walkExpr(f.ir.derive, e => {
      if (e.kind === "call" && e.callee.kind === "builtin" && e.callee.name === "offsetof")
        dep = true;
      if (e.kind === "field")
        for (const o of byName.get(e.name) ?? [])
          if (o !== f && dependsOnPosition(o, seen)) dep = true;
    });
    return dep;
  };
  for (const f of fields) {
    if (!f.ir.derive || !isIrField(f.ir)) continue;
    if (el.staticSize(f.type) !== undefined) continue;
    if (dependsOnPosition(f, new Set())) {
      el.report(
        ctx,
        f.sym.nameSpan,
        "layout-cycle",
        `'${f.sym.name}' has a variable size but is derived from a position: its own size would move what it points at. Use a fixed-size type.`
      );
    }
  }
}

function derivable(x: FieldResult): boolean {
  if (isIrField(x.ir)) {
    // a virtual field's value is an input (its parts are derived from it)
    if (x.ir.virtual) return false;
    let t = x.ir.type;
    if (t.kind === "layered") t = t.inner;
    // integers and integer-valued extern types (varints); not transforms, arrays or pointers
    if (t.kind !== "prim" && t.kind !== "extern") return false;
    if (x.ir.placement || x.ir.from) return false;
  }
  return isIntType(x.value);
}

/** `lens[$index]` (possibly converted): the per-element length array `lens`. */
function elementwiseTarget(e: IrExpr): string | undefined {
  while (e.kind === "convert") e = e.operand;
  if (e.kind !== "index" || e.object.kind !== "field") return undefined;
  let i = e.index;
  while (i.kind === "convert") i = i.operand;
  return i.kind === "builtinValue" && i.name === "index" ? e.object.name : undefined;
}

function isPrefix(a: FieldSym["frames"], b: FieldSym["frames"]): boolean {
  if (a.length > b.length) return false;
  return a.every((f, i) => f.member === b[i]!.member && f.branch === b[i]!.branch);
}

function collectSources(
  el: Elaborator,
  fields: FieldResult[],
  elementwise: Elementwise[]
): Source[] {
  const out: Source[] = [];
  for (const f of fields) {
    if (!isIrField(f.ir) || !f.sym.name) continue;
    const ir = f.ir;
    const fe: IrExpr = { kind: "field", name: f.sym.name, type: f.value };
    sizeSources(f, ir, fe, out);
    // lengths, also of a pointer's target array (`T[n] *p : u64`)
    let core = coreType(ir.type);
    if (core.kind === "pointer") core = coreType(core.target);
    if (core.kind === "array") {
      let elt = coreType(core.element);
      if (elt.kind === "pointer") elt = coreType(elt.target);
      if ((elt.kind === "array" || elt.kind === "bytes") && elt.length.kind === "count") {
        const target = elementwiseTarget(elt.length.expr);
        if (target)
          elementwise.push({
            field: f.sym,
            target,
            measure: call("lengths", [fe], { kind: "array", element: BIGINT })
          });
      }
    }
    if (
      (core.kind === "array" || core.kind === "bytes" || core.kind === "string") &&
      core.length.kind === "count"
    ) {
      let measure = call("len", [fe]);
      if (core.kind === "string") {
        const unit = core.unit;
        const bytes = call("encodedLength", [
          fe,
          intLit(unit),
          { kind: "literal", value: { kind: "string", value: core.encoding }, type: STRING }
        ]);
        measure =
          unit === 1
            ? bytes
            : { kind: "binary", op: "/", left: bytes, right: intLit(unit), type: BIGINT };
      }
      out.push({
        kind: "len",
        field: f.sym,
        expr: core.length.expr,
        measure,
        key: `len:${f.sym.name}`,
        describe: `${core.kind === "string" ? "length" : "element count"} of ${f.sym.name}`
      });
    }
    if (ir.placement) {
      out.push({
        kind: "at",
        field: f.sym,
        expr: ir.placement.offset,
        measure: call("offsetof", [fe]),
        key: `off:${f.sym.name}`,
        describe: `offset of ${f.sym.name}`
      });
    }
    if (!ir.placement && !ir.from) argumentSources(el, f, ir, fe, out);
  }
  return out;
}

function sizeSources(f: FieldResult, ir: IrField, fe: IrExpr, out: Source[]): void {
  const layers: IrLayer[] = ir.type.kind === "layered" ? ir.type.layers : [];
  layers.forEach((l, i) => {
    if (l.kind !== "size") return;
    const insideVia = layers.slice(i + 1).some(x => x.kind === "via");
    const outsideVia = layers.slice(0, i).some(x => x.kind === "via");
    out.push({
      kind: "size",
      field: f.sym,
      expr: l.size,
      measure: call("encodedSize", [fe, intLit(i)]),
      key: sizeKey(f.sym.name, layers, i),
      describe: insideVia
        ? `decoded size of ${f.sym.name}`
        : outsideVia
          ? `on-disk size of ${f.sym.name}`
          : `size of ${f.sym.name}`
    });
  });
}

/** `Blob(len) c`: `len` is derived through Blob's own derivation of its parameter. */
function argumentSources(
  el: Elaborator,
  f: FieldResult,
  ir: IrField,
  fe: IrExpr,
  out: Source[]
): void {
  const st = coreType(ir.type);
  if (st.kind !== "struct") return;
  const inst = el.instancesById.get(st.struct);
  const callee = inst && el.results.get(st.struct);
  if (!inst || !callee || !callee.done) return;
  inst.sym.params.forEach((p, idx) => {
    const arg = st.args[idx + 1];
    const d = callee.paramDerivations.get(p.name);
    if (!arg || !d) return;
    let ok = true;
    const measure = mapExpr(d, e => {
      if (e.kind === "field") return { kind: "member", object: fe, name: e.name, type: e.type };
      if (e.kind === "param" || e.kind === "builtinValue") ok = false;
      return e;
    });
    if (!ok) return;
    out.push({
      kind: "arg",
      field: f.sym,
      expr: arg,
      measure,
      key: `arg:${f.sym.name}:${p.name}`,
      describe: `argument ${p.name} of ${f.sym.name}`
    });
  });
}

/** Sizes measured through a run of size layers are the same value. */
function sizeKey(field: string, layers: IrLayer[], i: number): string {
  let k = i;
  while (k < layers.length && layers[k]!.kind === "size") k++;
  return `size:${field}:${k}`;
}

function measureKey(e: IrExpr, fields: Map<string, IrType>): string | undefined {
  if (e.kind !== "call" || e.callee.kind !== "builtin") return undefined;
  const a0 = e.args[0];
  if (!a0 || a0.kind !== "field") return undefined;
  const name = a0.name;
  const t = fields.get(name);
  const layers = t && t.kind === "layered" ? t.layers : [];
  switch (e.callee.name) {
    case "len":
    case "encodedLength":
      return `len:${name}`;
    case "offsetof":
      return `off:${name}`;
    case "sizeof":
      return sizeKey(name, layers, layers.length);
    case "encodedSize": {
      const i = literalInt(e.args[1]!);
      return i === undefined ? undefined : sizeKey(name, layers, Number(i));
    }
  }
  return undefined;
}

/** Samples an explicit formula for `x` against the read-side source that uses it. */
function analyzeFormula(
  el: Elaborator,
  ctx: Ctx,
  x: FieldResult,
  formula: IrExpr,
  src: Source
): void {
  const types = new Map<string, IrType>();
  if (ctx.struct) for (const [f, t] of ctx.fieldTypes) types.set(f.name, t.ir);
  if (!dependsOnlyOnMeasure(formula, src.key, types)) return;
  const evalAt = (e: IrExpr, v: bigint) =>
    evalIr(e, { call: c => (measureKey(c, types) === src.key ? v : undefined) });
  const evalRead = (xv: bigint) =>
    evalIr(src.expr, { field: n => (n === x.sym.name ? xv : undefined) });
  // only measures some value of the field can produce count (`ids[p * 2]` only has even lengths)
  const lin = linear(src.expr);
  const reachable = (v: bigint): boolean => {
    if (!lin || !lin.x || lin.a === 0n) return true;
    const d = v - lin.b;
    return d % lin.a === 0n && d / lin.a >= 0n;
  };
  let matches = 0;
  let mismatches = 0;
  let firstBad: bigint | undefined;
  for (const v of SAMPLES) {
    if (!reachable(v)) continue;
    const xv = evalAt(formula, v);
    if (typeof xv !== "bigint") return;
    const ev = evalRead(xv);
    if (typeof ev !== "bigint") return;
    if (ev === v) matches++;
    else {
      mismatches++;
      if (firstBad === undefined && v > 0n) firstBad = v;
    }
  }
  const file = ctx.module.file;
  const clause = x.sym.decl.clauses.spans.formula;
  const span = clause ?? x.sym.nameSpan;
  const removeFix = clause
    ? [removalFix("Remove the formula", file, widenLeft(file, clause), true)]
    : [];
  const readAs: Related[] = [
    { file, span: src.field.nameSpan, message: `'${x.sym.name}' is read as the ${src.describe}` }
  ];
  const what = src.kind === "len" ? "elements" : src.kind === "at" ? "offset" : "bytes";
  if (mismatches && matches <= 1) {
    el.report(
      ctx,
      span,
      "contradictory-formula",
      `This formula can never agree with how '${x.sym.name}' is read (${src.describe}): writing ${firstBad ?? 1n} ${what} would read back differently.`,
      { related: readAs }
    );
    return;
  }
  if (mismatches) {
    el.report(
      ctx,
      span,
      "formula-mismatch",
      `This formula agrees with how '${x.sym.name}' is read only for some values: e.g. ${firstBad} ${what} would read back differently.`,
      { related: readAs }
    );
    return;
  }
  // consistent: redundant (equal to the derived value) or lossy (read side not injective)
  if (lin && lin.x && lin.x.name === x.sym.name && lin.a !== 0n) {
    const auto = invertLinear(lin, src.measure);
    const same =
      irEqual(auto, formula) ||
      SAMPLES.every(v => evalAt(auto, v) === evalAt(formula, v) || (v - lin.b) % lin.a !== 0n);
    if (same)
      el.report(
        ctx,
        span,
        "redundant-formula",
        `'${x.sym.name}' is derived from the ${src.describe}; the formula is redundant.`,
        { tags: ["unnecessary"], fixes: removeFix }
      );
    return;
  }
  const collision = firstCollision(x, evalRead);
  if (collision)
    el.report(
      ctx,
      span,
      "lossy-formula",
      `Consistent but lossy: files where '${x.sym.name}' is ${collision[1]} read the same as ${collision[0]}, but are rebuilt with the formula's value. Drop the formula to keep the original value (byte-exact rebuilds).`,
      { fixes: removeFix }
    );
}

/** The formula reads nothing but the source's measure (no fields, parameters or other measures). */
function dependsOnlyOnMeasure(formula: IrExpr, key: string, types: Map<string, IrType>): boolean {
  let measured = false;
  let other = false;
  walkExpr(formula, e => {
    if (e.kind === "call") {
      if (measureKey(e, types) === key) measured = true;
      else if (e.callee.kind === "extern" || MEASURES.includes(e.callee.name)) other = true;
    }
    if (e.kind === "field" && !isMeasured(formula, e)) other = true;
    if (
      e.kind === "param" ||
      e.kind === "builtinValue" ||
      e.kind === "member" ||
      e.kind === "map" ||
      e.kind === "index"
    )
      other = true;
  });
  return measured && !other;
}

/** Is `target` the argument of a call (a measure) inside `root`? */
function isMeasured(root: IrExpr, target: IrExpr): boolean {
  let under = false;
  walkExpr(root, e => {
    if (e.kind === "call" && e.args.includes(target)) under = true;
  });
  return under;
}

/**
 * Two values of `x` that read back the same, among the values a file can hold: in range and
 * passing the field's checks (`u32 nodeSize = nodes.length * 24 where it % 24 == 0` can't be 1).
 */
function firstCollision(
  x: FieldResult,
  evalRead: (xv: bigint) => unknown
): [bigint, bigint] | undefined {
  const admissible = (n: bigint): boolean => {
    const v = x.value;
    if (v.kind === "int") {
      const bits = BigInt(x.bits?.width ?? v.bits);
      const lo = v.signed ? -(1n << (bits - 1n)) : 0n;
      const hi = v.signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
      if (n < lo || n > hi) return false;
    }
    if ("type" in x.ir && x.ir.type.kind === "transform") return true;
    return x.ir.checks.every(c => evalIr(c.expr, { it: n }) !== false);
  };
  const seen = new Map<string, bigint>();
  for (let n = 0n; n <= 300n; n++) {
    if (!admissible(n)) continue;
    const ev = evalRead(n);
    if (typeof ev !== "bigint") return undefined;
    const prev = seen.get(ev.toString());
    if (prev !== undefined) return [prev, n];
    seen.set(ev.toString(), n);
  }
  return undefined;
}

/** `a·p + b` over a single *parameter* p. */
function linearParam(e: IrExpr): { a: bigint; b: bigint; name: string } | undefined {
  let name: string | undefined;
  let bad = false;
  const asField = mapExpr(e, x => {
    if (x.kind === "param") {
      if (name && name !== x.name) bad = true;
      name = x.name;
      return { kind: "field", name: `\u0000${x.name}`, type: x.type };
    }
    if (x.kind === "field") bad = true;
    return x;
  });
  if (bad || !name) return undefined;
  const lin = linear(asField);
  if (!lin || !lin.x || lin.a === 0n) return undefined;
  return { a: lin.a, b: lin.b, name };
}

/** Reports a `@hidden` field the writer can't compute. */
export function reportHiddenUnderivable(el: Elaborator, f: FieldResult): void {
  const attr = f.sym.decl.attrs.find(a => a.name.name === "hidden");
  const file = f.sym.module.file;
  el.diags.report(
    file,
    attr?.span ?? f.sym.nameSpan,
    "hidden-not-derivable",
    `'${f.sym.name}' is @hidden but the writer can't compute it: give it a formula (= …) or use it as a length, size or offset.`,
    attr ? { fixes: [removalFix("Remove @hidden", file, widenLeft(file, attr.span))] } : {}
  );
}
