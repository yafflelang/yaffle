/**
 * Writable stream slices. A bytes field read only through `from` slices
 * (`Header hdr from raw[0x00..0x20]`) is assembled from them on write: `carrier: "slices"`,
 * `input: "absent"`. It stays an input (with a hint saying why) when
 *
 * - it is also read directly on the read side (a length, a condition, a check, `from raw`, …);
 * - its slices don't provably cover it and it isn't `@hidden` (the gaps would be written as
 *   zeros, which would lose bytes on a JSON round trip);
 * - its length depends on itself (`u32 n  u8 raw[n]`: n is written as raw.length);
 * - it is sliced through another slice or an `arr[*].field` stream.
 *
 * Overlapping slices of a carrier are a warning: on write both write the shared bytes, and the
 * writer fails (DERIVE) unless they agree. Overlaps are "provably compatible" (no warning) only
 * for two slices with identical bounds, types and derives (e.g. the same constant): any input
 * value can disagree with another.
 */
import type * as A from "./ast.ts";
import type { Ctx } from "./ctx.ts";
import type { Fix } from "./diagnostics.ts";
import type { Elaborator } from "./elaborate.ts";
import { literalInt } from "./expr.ts";
import type { IrExpr, IrField, IrLength, IrMember, IrStreamExpr, IrType } from "../ir/index.ts";
import { irEqual } from "./invert.ts";
import type { FieldResult, StructResult } from "./model.ts";
import { printIrExpr } from "./printer.ts";
import { fieldRefs, visitExpr, visitType } from "../ir/walk.ts";
import { coreType, isIrField } from "./types.ts";

interface Slice {
  field: FieldResult;
  start: IrExpr;
  end?: IrExpr;
}

interface Candidate {
  carrier: FieldResult;
  slices: Slice[];
}

function hex(n: bigint): string {
  return n < 10n ? n.toString() : `0x${n.toString(16)}`;
}

function sliceText(s: Slice, carrier: string): string {
  return `${carrier}[${printIrExpr(s.start)}..${s.end ? printIrExpr(s.end) : ""}]`;
}

/**
 * The first read-side reference to each field of the struct, with a description of where it is
 * (`the length of 'x'`, `a condition`, …). Write-side expressions (derives, transform writes,
 * pointer origins, layout items) don't count.
 */
function readSideRefs(members: IrMember[]): Map<string, string> {
  const out = new Map<string, string>();
  const note = (e: IrExpr | undefined, where: string) => {
    if (!e) return;
    visitExpr(e, {
      expr: x => {
        if (x.kind === "field" && !out.has(x.name)) out.set(x.name, where);
      }
    });
  };
  const lengthOf = (l: IrLength, where: string) => {
    if (l.kind === "count") note(l.expr, where);
    else if (l.kind === "until" || l.kind === "before") note(l.terminator, where);
    else if (l.kind === "untilPredicate") note(l.predicate, where);
  };
  const typeRefs = (t: IrType, name: string) => {
    visitType(t, {
      type: u => {
        switch (u.kind) {
          case "string":
          case "bytes":
            lengthOf(u.length, `the length of '${name}'`);
            break;
          case "array":
            lengthOf(u.length, `the length of '${name}'`);
            note(u.elementPlacement, `the placement of '${name}'`);
            break;
          case "struct":
            for (const a of u.args) note(a, `an argument of '${name}'`);
            break;
          case "extern":
            for (const a of u.args) note(a, `an argument of '${name}'`);
            break;
          case "transform":
            note(u.read, `the transform of '${name}'`);
            break;
          case "layered":
            for (const l of u.layers) {
              const where = `an attribute of '${name}'`;
              if (l.kind === "size") note(l.size, where);
              else if (l.kind === "via") for (const a of l.args) note(a, where);
              else if (l.kind === "align" || l.kind === "alignEnd") {
                note(l.to, where);
                note(l.offset, where);
              } else if (l.kind === "padBefore" || l.kind === "padAfter") note(l.count, where);
              else if (l.kind === "padUntil") note(l.size, where);
              else if (l.kind === "endian") note(l.value, where);
            }
            break;
          default:
            break;
        }
      }
    });
  };
  const visit = (ms: IrMember[]) => {
    for (const m of ms) {
      switch (m.kind) {
        case "field": {
          typeRefs(m.type, m.name);
          note(m.placement?.offset, `the offset of '${m.name}'`);
          note(m.virtual?.read, `the virtual field '${m.name}'`);
          for (const c of m.checks) note(c.expr, `the check of '${m.name}'`);
          if (m.from) {
            let s: IrStreamExpr = m.from.stream;
            while (s.kind === "slice") {
              note(s.start, `the slice bounds of '${m.name}'`);
              note(s.end, `the slice bounds of '${m.name}'`);
              s = s.stream;
            }
          }
          break;
        }
        case "bits":
          for (const f of m.fields)
            for (const c of f.checks) note(c.expr, `the check of '${f.name ?? "reserved bits"}'`);
          break;
        case "block":
          note(m.condition, "a condition");
          for (const l of m.layers) if (l.kind === "endian") note(l.value, "an @endian block");
          visit(m.members);
          if (m.else) visit(m.else);
          break;
        case "switch":
          note(m.discriminant, "a switch");
          for (const c of m.cases) visit(c.members);
          if (m.default) visit(m.default);
          break;
      }
    }
  };
  visit(members);
  return out;
}

/** Phase 1 (before reverse derivation): decide which sliced fields are assembled from their slices. */
export function markSliceCarriers(el: Elaborator, ctx: Ctx, result: StructResult): Candidate[] {
  const byName = new Map<string, FieldResult>();
  for (const f of result.fields.values()) if (f.sym.name) byName.set(f.sym.name, f);
  const slices = new Map<string, Slice[]>();
  const unsupported = new Map<string, string>();
  const wholeStream = new Set<string>();
  for (const fr of result.fields.values()) {
    if (!isIrField(fr.ir) || !fr.ir.from) continue;
    const s = fr.ir.from.stream;
    if (s.kind === "field") wholeStream.add(s.field);
    if (s.kind !== "slice") continue;
    if (s.stream.kind === "field") {
      const list = slices.get(s.stream.field) ?? [];
      list.push({ field: fr, start: s.start, ...(s.end ? { end: s.end } : {}) });
      slices.set(s.stream.field, list);
    } else {
      let inner: IrStreamExpr = s.stream;
      while (inner.kind === "slice") inner = inner.stream;
      const name = inner.kind === "field" ? inner.field : inner.array;
      unsupported.set(
        name,
        inner.kind === "field"
          ? `'${fr.sym.name}' slices a slice of it, and nested slices are read-only`
          : `'${fr.sym.name}' slices the joined \`${inner.array}[*].${inner.field}\` stream, which is read-only`
      );
    }
  }
  const reads = readSideRefs(result.ir.members);
  const out: Candidate[] = [];
  const hint = (f: FieldResult, why: string, fixes: Fix[] = []) =>
    el.report(
      ctx,
      f.sym.nameSpan,
      "slice-carrier-input",
      `'${f.sym.name}' is read through \`from\` slices but stays an input: ${why}.`,
      fixes.length ? { fixes } : {}
    );
  for (const [name, list] of slices) {
    const carrier = byName.get(name);
    if (!carrier || !isIrField(carrier.ir)) continue;
    const ir = carrier.ir;
    if (ir.derive) continue; // a formula or constant decides it
    if (unsupported.has(name)) {
      hint(carrier, unsupported.get(name)!);
      continue;
    }
    if (wholeStream.has(name)) {
      hint(carrier, `it is also the whole stream of another field (\`from ${name}\`)`);
      continue;
    }
    const where = reads.get(name);
    if (where) {
      hint(carrier, `it is also read directly, in ${where}`);
      continue;
    }
    const t = coreType(ir.type);
    if (t.kind !== "bytes") continue;
    // coverage: every byte of the field comes from some slice (or the gaps are fine: @hidden)
    const cov = coverage(list, t.length);
    if (!cov.covered && !ir.hidden) {
      const fix: Fix[] = [];
      const decl = carrier.sym.decl;
      const anchor = decl.attrs.length
        ? decl.attrs[decl.attrs.length - 1]!.span.end
        : decl.span.end;
      fix.push({
        title: `Add @hidden (assemble '${name}' from its slices, zeros in the gaps)`,
        edits: [
          { file: ctx.module.file, span: { start: anchor, end: anchor }, newText: " @hidden" }
        ]
      });
      hint(
        carrier,
        `${cov.gap}, and uncovered bytes would be written as zeros. Add @hidden to assemble it anyway`,
        fix
      );
      continue;
    }
    ir.carrier = "slices";
    ir.input = "absent";
    result.streamFields.add(name);
    carrier.deriveSource = `assembled from its slices (${list.map(s => s.field.sym.name).join(", ")})`;
    out.push({ carrier, slices: list });
  }
  return out;
}

/** Phase 2 (after reverse derivation): lengths that depend on the carrier, and overlaps. */
export function checkSliceCarriers(
  el: Elaborator,
  ctx: Ctx,
  result: StructResult,
  candidates: Candidate[]
): void {
  const byName = new Map<string, FieldResult>();
  for (const f of result.fields.values()) if (f.sym.name) byName.set(f.sym.name, f);
  // fields whose derive (transitively) reads `target`
  const dependsOn = (name: string, target: string, seen = new Set<string>()): boolean => {
    if (name === target) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    const f = byName.get(name);
    if (!f?.ir.derive) return false;
    for (const r of fieldRefs(f.ir.derive)) if (dependsOn(r, target, seen)) return true;
    return false;
  };
  for (const c of candidates) {
    const ir = c.carrier.ir as IrField;
    const name = c.carrier.sym.name;
    const t = coreType(ir.type);
    const exprs: { e: IrExpr; what: string }[] = [];
    if (t.kind === "bytes" && t.length.kind === "count")
      exprs.push({ e: t.length.expr, what: "its length" });
    for (const s of c.slices) {
      exprs.push({ e: s.start, what: `the bounds of '${s.field.sym.name}'` });
      if (s.end) exprs.push({ e: s.end, what: `the bounds of '${s.field.sym.name}'` });
    }
    const cyc = exprs.find(x => [...fieldRefs(x.e)].some(r => dependsOn(r, name)));
    if (cyc) {
      // revert: it stays an input
      delete ir.carrier;
      ir.input = ir.hidden ? "absent" : "required";
      result.streamFields.delete(name);
      delete c.carrier.deriveSource;
      const via = [...fieldRefs(cyc.e)].find(r => dependsOn(r, name));
      el.report(
        ctx,
        c.carrier.sym.nameSpan,
        "slice-carrier-input",
        `'${name}' is read through \`from\` slices but stays an input: ${cyc.what} depends on '${name}' itself${via ? ` ('${via}' is written as ${byName.get(via)?.deriveDisplay ?? "a formula of it"})` : ""}, so it can't be assembled from its slices. Give it a constant length, or \`[]\` with @size.`
      );
      if (ir.hidden && !ir.derive) result.hiddenCandidates.push(c.carrier);
      continue;
    }
    // overlaps between slices
    const reported = new Set<FieldResult>();
    for (let i = 0; i < c.slices.length; i++) {
      for (let j = i + 1; j < c.slices.length; j++) {
        const a = c.slices[i]!;
        const b = c.slices[j]!;
        if (!overlaps(a, b) || compatible(a, b) || reported.has(b.field)) continue;
        reported.add(b.field);
        const span = (b.field.sym.decl as A.FieldDecl).clauses.spans.from ?? b.field.sym.nameSpan;
        el.report(
          ctx,
          span,
          "slice-overlap",
          `'${b.field.sym.name}' (${sliceText(b, name)}) overlaps '${a.field.sym.name}' (${sliceText(a, name)}): on write both are written into '${name}', and the writer fails (DERIVE) unless their bytes there agree.`,
          {
            related: [
              {
                file: ctx.module.file,
                span: (a.field.sym.decl as A.FieldDecl).clauses.spans.from ?? a.field.sym.nameSpan,
                message: `'${a.field.sym.name}' is read from ${sliceText(a, name)}`
              }
            ]
          }
        );
      }
    }
  }
}

/** Do two slices definitely share a byte? (constant bounds, or identical symbolic starts) */
function overlaps(a: Slice, b: Slice): boolean {
  const as = literalInt(a.start);
  const bs = literalInt(b.start);
  const ae = a.end ? literalInt(a.end) : undefined;
  const be = b.end ? literalInt(b.end) : undefined;
  if (as !== undefined && bs !== undefined) {
    const aEnd = a.end ? ae : undefined;
    const bEnd = b.end ? be : undefined;
    if (a.end && aEnd === undefined) return false;
    if (b.end && bEnd === undefined) return false;
    // open ends run to the end of the field
    const aE = aEnd ?? 1n << 62n;
    const bE = bEnd ?? 1n << 62n;
    return as < bE && bs < aE && as < aE && bs < bE;
  }
  return irEqual(a.start, b.start) && (!a.end || !b.end || !irEqual(a.start, a.end));
}

/** Provably the same bytes: identical bounds and types, and identical derives (e.g. constants). */
function compatible(a: Slice, b: Slice): boolean {
  const sameBounds =
    irEqual(a.start, b.start) &&
    ((!a.end && !b.end) || (!!a.end && !!b.end && irEqual(a.end, b.end)));
  const sameType = JSON.stringify(a.field.type) === JSON.stringify(b.field.type);
  const da = a.field.ir.derive;
  const db = b.field.ir.derive;
  return sameBounds && sameType && !!da && !!db && irEqual(da, db);
}

/**
 * Do the slices cover the field? Constant bounds: the union must be [0, length) (or [0, max end)
 * for `[]` fields) without gaps. Symbolic bounds: a chain from 0 where each slice starts where the
 * previous one ends, up to the length or an open end.
 */
function coverage(list: Slice[], length: IrLength): { covered: boolean; gap: string } {
  const lenExpr = length.kind === "count" ? length.expr : undefined;
  const len = lenExpr ? literalInt(lenExpr) : undefined;
  const consts = list.map(s => ({
    s: literalInt(s.start),
    e: s.end ? literalInt(s.end) : undefined,
    open: !s.end
  }));
  if (consts.every(c => c.s !== undefined && (c.open || c.e !== undefined))) {
    const end =
      len ??
      (consts.some(c => c.open) ? undefined : consts.reduce((m, c) => (c.e! > m ? c.e! : m), 0n));
    if (lenExpr && len === undefined && !consts.some(c => c.open))
      return {
        covered: false,
        gap: `its slices' bounds are constants but its length isn't, so they don't provably cover it`
      };
    const ivs = consts
      .map(c => ({ s: c.s!, e: c.open ? (end ?? 1n << 62n) : c.e! }))
      .sort((x, y) => (x.s < y.s ? -1 : x.s > y.s ? 1 : 0));
    let pos = 0n;
    for (const iv of ivs) {
      if (iv.s > pos)
        return {
          covered: false,
          gap: `bytes ${hex(pos)}..${hex(iv.s)} aren't covered by any slice`
        };
      if (iv.e > pos) pos = iv.e;
    }
    if (end !== undefined && pos < end)
      return { covered: false, gap: `bytes ${hex(pos)}..${hex(end)} aren't covered by any slice` };
    return { covered: true, gap: "" };
  }
  // symbolic: follow the chain
  let pos: IrExpr | undefined = {
    kind: "literal",
    value: { kind: "int", value: "0" },
    type: { kind: "bigint" }
  };
  const used = new Set<Slice>();
  for (;;) {
    const next = list.find(s => !used.has(s) && pos && sameValue(s.start, pos));
    if (!next) break;
    used.add(next);
    if (!next.end) return { covered: true, gap: "" };
    pos = next.end;
    if (lenExpr && sameValue(pos, lenExpr)) return { covered: true, gap: "" };
  }
  return { covered: false, gap: `its slices' bounds don't provably cover it` };
}

function sameValue(a: IrExpr, b: IrExpr): boolean {
  const x = literalInt(a);
  const y = literalInt(b);
  if (x !== undefined && y !== undefined) return x === y;
  return irEqual(a, b);
}
