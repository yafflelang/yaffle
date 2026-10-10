/**
 * Diagnostics: the registry of stable codes, and the internal (offset-based) diagnostic shape the
 * frontend produces. `toApiDiagnostic` converts to the language-service shape (line/character).
 */
import type { CodeAction, Diagnostic, Severity, TextEdit } from "../service/api.ts";
import type { SourceFile, Span } from "./source.ts";

/** Every diagnostic code the frontend emits, with its default severity and a short description. */
export const DIAGNOSTIC_CODES = {
  // ── lexer ──────────────────────────────────────────────────────────────────
  "invalid-character": ["error", "A character that can't start a token."],
  "unterminated-string": ["error", "A string literal without its closing quote."],
  "unterminated-comment": ["error", "A /* comment without its closing */."],
  "unterminated-regex": ["error", "A regex literal without its closing slash."],
  "invalid-escape": ["error", "An unknown escape sequence in a string."],
  "invalid-number": ["error", "A malformed number literal."],
  "invalid-hex-bytes": [
    "error",
    'An x"…" literal with an odd number of digits or non-hex characters.'
  ],
  "invalid-base64": ["error", 'A b64"…" literal that is not valid base64.'],
  "invalid-fourcc": ["error", "A four-character code that is empty, too long or not ASCII."],
  // ── parser ─────────────────────────────────────────────────────────────────
  "syntax-error": ["error", "The parser expected something else."],
  "reserved-word": ["error", "A keyword used as a name."],
  // ── modules ────────────────────────────────────────────────────────────────
  "import-not-found": ["error", "The imported file doesn't exist."],
  "unknown-import-name": ["error", "The imported module doesn't declare this name."],
  "unused-import": ["hint", "An imported name that is never used."],
  "duplicate-import": ["error", "The same name imported twice."],
  // ── names ──────────────────────────────────────────────────────────────────
  "unknown-name": [
    "error",
    "A name that doesn't resolve to a field, parameter or constant in scope."
  ],
  "unknown-type": ["error", "A type name that doesn't resolve."],
  "unknown-member": ["error", "A member that the struct or enum doesn't have."],
  "unknown-function": ["error", "A call to something that isn't a function."],
  "unknown-codec": ["error", "@via names something that isn't a codec."],
  "unknown-attribute": ["error", "An attribute yaffle doesn't know."],
  "duplicate-declaration": ["error", "Two declarations with the same name in one scope."],
  "duplicate-field": [
    "error",
    "Two fields with the same name in one struct (outside alternative branches)."
  ],
  "duplicate-param": ["error", "Two parameters with the same name."],
  "duplicate-enum-member": ["error", "Two enum members with the same name."],
  "duplicate-enum-value": ["warning", "Two enum members with the same value."],
  "duplicate-variant": ["error", "A union lists the same variant twice."],
  "duplicate-attribute": ["warning", "An attribute that can only appear once appears again."],
  "forward-reference": ["error", "A read-side expression refers to a field declared later."],
  "possibly-absent": [
    "error",
    "A field from a conditional branch is used where the branch may not have been taken."
  ],
  "missing-binding": ["error", "A $value is read on a path where nothing binds it."],
  "bound-shadowing": ["warning", "A $value binding shadows an outer binding of the same name."],
  "bound-type-conflict": [
    "error",
    "Bindings of a $value with incompatible types reach the same reader."
  ],
  "outer-unavailable": [
    "error",
    "A nested struct is used where the enclosing struct's fields it reads aren't available."
  ],
  "index-unavailable": ["error", "$index is read on a path that isn't inside an array."],
  "self-reference": ["error", "A field's read-side expression refers to the field itself."],
  // ── types ──────────────────────────────────────────────────────────────────
  "type-mismatch": ["error", "An expression has the wrong type for where it is used."],
  "value-out-of-range": ["error", "A constant doesn't fit the type it is stored in."],
  "string-too-long": ["error", "A constant string longer than its fixed-size field."],
  "fourcc-size": [
    "error",
    "A four-character code whose length doesn't match the integer it is compared with."
  ],
  "fourcc-endian": [
    "error",
    "A four-character code switch case on an integer whose endianness is inherited."
  ],
  "wrong-argument-count": ["error", "Too many or too few arguments."],
  "unknown-argument": ["error", "A named argument that doesn't match a parameter."],
  "duplicate-argument": ["error", "A parameter given more than once."],
  "wrong-type-argument-count": ["error", "Too many or too few generic type arguments."],
  "generic-argument": ["error", "A generic type argument that refers to runtime values."],
  "not-a-type": ["error", "A value used where a type is expected."],
  "not-a-value": ["error", "A type used where a value is expected."],
  "not-constant": ["error", "A value that must be known at compile time isn't."],
  "division-by-zero": ["error", "A constant division or remainder by zero."],
  "alias-cycle": ["error", "Type aliases that refer to each other in a cycle."],
  "recursive-struct": ["error", "A struct that contains itself inline (infinite size)."],
  "const-cycle": ["error", "Constants that refer to each other in a cycle."],
  "invalid-regex": ["error", "A regex outside the portable RE2-style subset, or malformed."],
  "invalid-stream": ["error", "A `from` stream that isn't a bytes field, arr[*].field or a slice."],
  "invalid-length": ["error", "An array declarator that isn't valid for this type."],
  "rest-not-last": ["warning", "A `[]` field followed by more inline fields in the same region."],
  "unreachable-case": ["warning", "A switch case that can never match."],
  "invalid-case": ["error", "A case value that isn't a literal of the discriminant's type."],
  // ── attributes ─────────────────────────────────────────────────────────────
  "invalid-attribute-target": ["error", "An attribute in a place where it has no meaning."],
  "invalid-attribute-argument": [
    "error",
    "An attribute with missing, extra or mistyped arguments."
  ],
  // ── bitfields, enums, pointers ─────────────────────────────────────────────
  "bitfield-overflow": ["error", "Bitfield widths that don't fit the storage unit."],
  "bitfield-width": ["error", "A bitfield width that is zero, negative or wider than its type."],
  "bitfield-type": ["error", "A bitfield type that isn't an integer, bool or enum."],
  "enum-value-range": ["error", "An enum member value that doesn't fit the storage type."],
  "pointer-storage": ["error", "A pointer storage type that isn't an integer."],
  "pointer-attribute": [
    "error",
    "A pointer attribute (@relative, @nullable, @ref) on a field that isn't a pointer."
  ],
  // ── derivation and consistency ─────────────────────────────────────────────
  "contradictory-formula": [
    "error",
    "A computed field whose formula can never agree with the read-side expression using it."
  ],
  "formula-mismatch": [
    "warning",
    "A computed field whose formula agrees with the read side only for some values."
  ],
  "lossy-formula": [
    "warning",
    "A computed field whose formula breaks byte-exact rebuilds of files with other values."
  ],
  "redundant-formula": [
    "hint",
    "A computed field whose formula equals what the field would be derived as."
  ],
  "size-inside-codec": [
    "error",
    "@size inside a non-streaming codec without an outer @size: the codec needs its on-disk size."
  ],
  "layout-cycle": ["error", "A derived value whose own size depends on a position."],
  "hidden-not-derivable": ["error", "A @hidden field the writer can't compute."],
  "unknown-layout-path": ["error", "A layout path that doesn't name a field."],
  "layout-not-placeable": [
    "warning",
    "A layout item that places nothing (no pointer or `at` targets)."
  ],
  "duplicate-layout-item": [
    "warning",
    "A layout item that names targets already placed by an earlier item."
  ],
  "one-way-transform": [
    "hint",
    "An `as` transform without an inverse: the value is read-only in views."
  ],
  "not-invertible": ["error", "An explicit transform inverse (`as … = …`) without `it`."],
  // ── virtual fields, derived arrays, slices ─────────────────────────────────
  "invalid-virtual": [
    "error",
    "A `virtual` field that isn't an integer with `= expression` over earlier fields."
  ],
  "virtual-not-invertible": [
    "error",
    "A virtual field that can't be inverted: its parts can't be derived from its value."
  ],
  "invalid-lambda": [
    "error",
    "A lambda outside map/filter/indicesWhere/sortedBy (or a padding fill), or a builtin missing its lambda."
  ],
  "slice-carrier-input": [
    "hint",
    "A bytes field read through `from` slices that stays an input (it is also read directly, or can't be assembled)."
  ],
  "slice-overlap": [
    "warning",
    "Two `from` slices of one field overlap: on write their bytes there must agree."
  ],
  // ── project ────────────────────────────────────────────────────────────────
  "extern-missing-implementation": [
    "warning",
    "An extern without an implementation for a configured target."
  ],
  "config-error": ["error", "An invalid yaffle.json."],
  "not-implemented": [
    "error",
    "A feature that is designed but not implemented yet (the conformance runner skips on it)."
  ]
} as const satisfies Record<string, readonly [Severity, string]>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

export interface Edit {
  file: SourceFile;
  span: Span;
  newText: string;
}

export interface Fix {
  title: string;
  kind?: CodeAction["kind"];
  edits: Edit[];
  isPreferred?: boolean;
}

export interface Related {
  file: SourceFile;
  span: Span;
  message: string;
}

/** An internal diagnostic: offsets into a source file. */
export interface Diag {
  file: SourceFile;
  span: Span;
  severity: Severity;
  code: DiagnosticCode;
  message: string;
  related?: Related[];
  tags?: ("unnecessary" | "deprecated")[];
  fixes?: Fix[];
}

export interface DiagOptions {
  severity?: Severity;
  related?: Related[];
  tags?: ("unnecessary" | "deprecated")[];
  fixes?: Fix[];
}

/** A preferred fix replacing `span` with `newText` ("Change to …"). */
export function replaceFix(
  file: SourceFile,
  span: Span,
  newText: string,
  title = `Change to '${newText}'`
): Fix {
  return { title, edits: [{ file, span, newText }], isPreferred: true };
}

/** A fix deleting `span`. */
export function removalFix(title: string, file: SourceFile, span: Span, preferred = false): Fix {
  const fix: Fix = { title, edits: [{ file, span, newText: "" }] };
  if (preferred) fix.isPreferred = true;
  return fix;
}

export function makeDiag(
  file: SourceFile,
  span: Span,
  code: DiagnosticCode,
  message: string,
  options: DiagOptions = {}
): Diag {
  const d: Diag = {
    file,
    span,
    code,
    message,
    severity: options.severity ?? DIAGNOSTIC_CODES[code][0]
  };
  if (options.related?.length) d.related = options.related;
  if (options.tags?.length) d.tags = options.tags;
  if (options.fixes?.length) d.fixes = options.fixes;
  return d;
}

/** Collects diagnostics, deduplicating identical ones. */
export class DiagnosticBag {
  readonly items: Diag[] = [];
  private readonly seen = new Set<string>();

  add(d: Diag): void {
    const key = `${d.file.path}:${d.span.start}:${d.span.end}:${d.code}:${d.message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push(d);
  }

  report(
    file: SourceFile,
    span: Span,
    code: DiagnosticCode,
    message: string,
    options?: DiagOptions
  ): Diag {
    const d = makeDiag(file, span, code, message, options);
    this.add(d);
    return d;
  }

  get hasErrors(): boolean {
    return this.items.some(d => d.severity === "error");
  }
}

export function fixToCodeAction(fix: Fix, codes: string[]): CodeAction {
  const changes: Record<string, TextEdit[]> = {};
  for (const e of fix.edits) {
    (changes[e.file.path] ??= []).push({ range: e.file.rangeOf(e.span), newText: e.newText });
  }
  const action: CodeAction = { title: fix.title, kind: fix.kind ?? "quickfix", edit: { changes } };
  if (codes.length) action.diagnosticCodes = codes;
  if (fix.isPreferred) action.isPreferred = true;
  return action;
}

export function toApiDiagnostic(d: Diag): Diagnostic {
  const out: Diagnostic = {
    path: d.file.path,
    range: d.file.rangeOf(d.span),
    severity: d.severity,
    code: d.code,
    message: d.message
  };
  if (d.related?.length) {
    out.related = d.related.map(r => ({
      location: { path: r.file.path, range: r.file.rangeOf(r.span) },
      message: r.message
    }));
  }
  if (d.tags?.length) out.tags = [...d.tags];
  if (d.fixes?.length) out.fixes = d.fixes.map(f => fixToCodeAction(f, [d.code]));
  return out;
}

export function sortDiagnostics<
  T extends { path: string; range: { start: { line: number; character: number } } }
>(list: T[]): T[] {
  return list.sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character
  );
}
