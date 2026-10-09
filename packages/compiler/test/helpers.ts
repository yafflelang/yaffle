/** Shared test helpers: in-memory compilation, IR validation, diagnostic matching. */
import { expect } from "vitest";
import {
  compile,
  compileSource,
  validateIr,
  type CompileResult,
  type CompilerHost
} from "../src/index.ts";
import type { Diagnostic } from "../src/service/api.ts";
import type { IrField, IrMember, IrProgram, IrStruct } from "../src/ir/index.ts";
import { irToText } from "../src/frontend/irtext.ts";
import { parse } from "../src/frontend/parser.ts";
import { SourceFile } from "../src/frontend/source.ts";
import { lex } from "../src/frontend/lexer.ts";
import { DiagnosticBag } from "../src/frontend/diagnostics.ts";

export function memoryHost(files: Record<string, string>): CompilerHost {
  return {
    readFile: p => files[p],
    fileExists: p => p in files
  };
}

/** Compiles one source; every produced program is validated against the IR invariants. */
export function check(
  source: string,
  options: Parameters<typeof compileSource>[3] = {}
): CompileResult {
  const r = compileSource(source, "/memory/main.yfl", undefined, options);
  if (r.program) expectValidIr(r.program);
  return r;
}

export function checkFiles(
  files: Record<string, string>,
  entry = Object.keys(files)[0]!
): CompileResult {
  const r = compile([entry], memoryHost(files));
  if (r.program) expectValidIr(r.program);
  return r;
}

export function expectValidIr(p: IrProgram): void {
  const errors = validateIr(p);
  expect(errors, errors.join("\n")).toEqual([]);
}

/** Compiles and expects no errors; returns the program. */
export function ok(source: string): IrProgram {
  const r = check(source);
  const errors = r.diagnostics.filter(d => d.severity === "error");
  expect(errors.map(fmt), "unexpected errors").toEqual([]);
  expect(r.program).toBeDefined();
  return r.program!;
}

export function okText(source: string): string {
  return irToText(ok(source));
}

export function fmt(d: Diagnostic): string {
  return `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.severity} ${d.code}: ${d.message}`;
}

/** Codes of all diagnostics. */
export function codes(source: string): string[] {
  return check(source).diagnostics.map(d => d.code);
}

/** Expects a diagnostic with `code`; returns it. The marker `⟦…⟧` in the source (if any) must be its range. */
export function expectDiag(
  source: string,
  code: string,
  messagePart?: string | RegExp
): Diagnostic {
  const { text, marks } = stripMarks(source);
  const r = check(text);
  const found = r.diagnostics.filter(d => d.code === code);
  expect(
    found.length,
    `expected ${code}, got:\n${r.diagnostics.map(fmt).join("\n")}`
  ).toBeGreaterThan(0);
  let d = found[0]!;
  if (marks.length) {
    const m = marks[0]!;
    const match = found.find(
      x =>
        x.range.start.line === m.start.line &&
        x.range.start.character === m.start.character &&
        x.range.end.line === m.end.line &&
        x.range.end.character === m.end.character
    );
    expect(
      match,
      `no ${code} at the marked range ${JSON.stringify(m)}; got ${found.map(fmt).join("; ")} ${JSON.stringify(found.map(f => f.range))}`
    ).toBeDefined();
    d = match!;
  }
  if (messagePart !== undefined) {
    if (typeof messagePart === "string") expect(d.message).toContain(messagePart);
    else expect(d.message).toMatch(messagePart);
  }
  return d;
}

export function expectNoDiag(source: string, code: string): void {
  const r = check(source);
  const found = r.diagnostics.filter(d => d.code === code);
  expect(found.map(fmt), `unexpected ${code}`).toEqual([]);
}

/** `⟦` and `⟧` mark ranges in test sources. */
export function stripMarks(source: string): {
  text: string;
  marks: { start: { line: number; character: number }; end: { line: number; character: number } }[];
} {
  const marks: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  }[] = [];
  let text = "";
  let line = 0;
  let col = 0;
  let open: { line: number; character: number } | undefined;
  for (const ch of source) {
    if (ch === "⟦") {
      open = { line, character: col };
      continue;
    }
    if (ch === "⟧") {
      if (open) marks.push({ start: open, end: { line, character: col } });
      open = undefined;
      continue;
    }
    text += ch;
    if (ch === "\n") {
      line++;
      col = 0;
    } else col += ch.length;
  }
  return { text, marks };
}

/** `|` marks a cursor position. */
export function cursor(source: string): { text: string; pos: { line: number; character: number } } {
  const i = source.indexOf("|");
  const text = source.slice(0, i) + source.slice(i + 1);
  const before = source.slice(0, i).split("\n");
  return { text, pos: { line: before.length - 1, character: before[before.length - 1]!.length } };
}

export function struct(p: IrProgram, id: string): IrStruct {
  const s = p.structs.find(x => x.id === id);
  expect(s, `struct ${id} not in ${p.structs.map(x => x.id).join(", ")}`).toBeDefined();
  return s!;
}

export function field(s: IrStruct, name: string): IrField {
  let found: IrField | undefined;
  const visit = (ms: IrMember[]) => {
    for (const m of ms) {
      if (m.kind === "field" && m.name === name) found ??= m;
      else if (m.kind === "block") {
        visit(m.members);
        if (m.else) visit(m.else);
      } else if (m.kind === "switch") {
        for (const c of m.cases) visit(c.members);
        if (m.default) visit(m.default);
      }
    }
  };
  visit(s.members);
  expect(found, `field ${name} not in ${s.id}`).toBeDefined();
  return found!;
}

export function parseSource(text: string): {
  module: ReturnType<typeof parse>["module"];
  diagnostics: string[];
} {
  const f = new SourceFile("/t.yfl", text);
  const bag = new DiagnosticBag();
  const r = parse(f, bag);
  return {
    module: r.module,
    diagnostics: bag.items.map(
      d =>
        `${f.positionAt(d.span.start).line + 1}:${f.positionAt(d.span.start).character + 1} ${d.code}: ${d.message}`
    )
  };
}

export function lexSource(text: string): {
  tokens: ReturnType<typeof lex>["tokens"];
  comments: ReturnType<typeof lex>["comments"];
  diagnostics: string[];
} {
  const f = new SourceFile("/t.yfl", text);
  const bag = new DiagnosticBag();
  const r = lex(f, bag);
  return { ...r, diagnostics: bag.items.map(d => d.code) };
}
