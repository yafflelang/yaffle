# The yaffle compiler frontend

The frontend turns `.yfl` sources into the IR specified in [IR.md](IR.md), reports diagnostics,
and powers the language service and the CLI. It lives in `packages/compiler/src/`:

| Directory   | Contents                                                                    |
| ----------- | --------------------------------------------------------------------------- |
| `frontend/` | lexer, parser, binder, checker and lowering, formatter, printers            |
| `ir/`       | the IR types (`ir.ts`), traversal helpers (`walk.ts`), the validator        |
| `service/`  | the language service behind `service/api.ts`                                |
| `cli/`      | the `yaffle` command (`runCli` in `cli.ts`, the executable in `main.ts`)    |
| `index.ts`  | the public API: `compile`, `compileSource`, `loadProjectConfig`, `build`, … |

## Pipeline

`runFrontend` (`frontend/program.ts`) drives one compilation:

1. **Load.** Read the entry files and, following `import`s, every module they reach. Parse
   results are cached per path and text (`ParseCache`; the language service keeps one).
2. **Parse.** `lexer.ts` produces tokens that record whether a line break precedes them (members
   end at line breaks) and collects comments separately. `parser.ts` is an error-tolerant
   recursive descent parser: missing pieces become `undefined`, empty identifiers or `Error`
   expressions, so broken files still give a tree.
3. **Bind.** `symbols.ts` creates a symbol per declaration, parameter and field. A struct's fields
   are flattened through blocks, branches, cases and bitfields; each records the conditional
   branches (`frames`) it sits in. Then imports are resolved and modules ordered (imports first).
4. **Check.** The `Elaborator` (`elaborate.ts`) checks every declaration once. Struct bodies go
   through `members.ts`, expressions through `expr.ts`.
5. **Assemble.** `instances.ts` builds the program from the export roots (see below).
6. **Report** unused imports, then return the program (unless there are errors), the diagnostics
   and the elaborator, whose `SemanticModel` (`model.ts`) the language service reads.

Module paths in the IR are relative to the project root (`rootDir`) or else to the common
directory of all modules. Paths given to the compiler are used verbatim (win32 drive letters, `\`
separators and the language server's virtual paths keep their spelling); only `.` and `..` are
resolved (`util.ts`).

## Checking and lowering

One code path both checks and lowers. A `Ctx` (`ctx.ts`) says where an expression is: the module
and struct in scope, the side (`read`: earlier fields only; `write`: every field; `const`), the
conditional frames and guards around it, what `it` means, and whether to report diagnostics and
record language-service information.

- **Check mode** runs once per declaration, reporting and recording; generic type parameters are
  opaque. A non-generic struct's check result _is_ its IR.
- **Lower mode** lowers a generic instance with its type arguments substituted, silently. Type
  arguments must be constants, so an instance doesn't depend on where it's used.

`members.ts` lowers a struct body in two passes. Pass A lowers what the read side needs, in
declaration order: types, arrays, pointers, transforms, layers, placements, streams, bitfields,
blocks, `if` and `switch`. Pass B lowers what may reference any field: computed fields, defaults,
explicit transform inverses, pointer origins and checks. Then:

- `virtual.ts` inverts each `virtual` field, deriving its parts by flattening its formula into a
  mixed radix (`(hi << 32) | lo`, `a * 1000 + b`).
- `slices.ts` decides which bytes fields are assembled from their `from` slices on write.
- `derive.ts` derives fields from their read-side uses: array/string lengths, `@size` layers,
  `at` offsets (with placement constraints) and struct arguments, inverting expressions linear in
  one field (`invert.ts`). The formulas of computed fields are sampled against the read side to find
  contradictory, partial, lossy and redundant ones. It also decides which placements are `fixed`
  and reports layout cycles.
- The layout block is lowered last, with its paths resolved through arrays and pointer targets.

Supporting modules: `types.ts` (primitives, value types, static sizes), `range.ts` (interval
analysis for the value types of integer transforms and untyped constants), `attributes.ts` (the
attribute registry used by the checker, completion and hover), `diagnostics.ts` (the registry of
diagnostic codes and quick-fix helpers), `printer.ts` and `irtext.ts` (source and IR printers;
`irToText` is `yaffle ir --text` and the golden-test format), and `format.ts` (the formatter,
which keeps the author's column alignment and is idempotent).

### Program assembly

`assembleProgram` instantiates every struct reachable from the export roots (plus any extra roots
a tool asks for), then runs the requirements analysis:

- Each instance's direct needs are the bound values (`$version`), enclosing structs' fields and
  `$index` it reads. Needs propagate along uses to a fixpoint, unless the use site binds the value
  itself or sits inside an array.
- A need that reaches an export root is a diagnostic with the full path
  (`R → records (Record) → m (Motion)`) and a quick fix that adds a root parameter.
- Implicit parameters are appended in the order IR.md §1 specifies, implicit arguments are filled
  at every recorded use site, and the provisional names used during lowering (`\0b:version`,
  `\0o:Owner.field`) are renamed in place.
- Finally it reports inline recursion, marks the pieces of `from arr[*].piece` streams, computes
  `async` and `usesEndian`, and collects the enums, externs and exported constants the structs
  use. Struct ids are qualified names (`Asset.Record`), module-prefixed only when two modules
  declare the same name; generic instances are `Span<Point>`.

### IR utilities

`ir/walk.ts` visits and maps expressions, types, layers and members. `ir/validate.ts`
(`validateIr`, exported from the package root) checks a program against IR.md: arguments match
parameters, read-side expressions use only earlier fields, references resolve, bits fit, input and
derive are consistent, and the program is plain JSON. The frontend's tests run it on every
program they produce.

## Language service

`createLanguageService(host)` (`service/index.ts`) implements `service/api.ts`.

- **Analysis** (`analysis.ts`): a `Workspace` holds open-file overlays and the project
  configuration and bumps a version on every change. An `Analysis` is one frontend run over the
  open files and the project's sources, cached until the next change; it indexes the semantic
  model by declaration and position. Project sources are found by expanding the `sources` globs
  through `ProjectHost.readDirectory` when the host has it.
- **Locating** (`locate.ts`): the path of AST nodes at an offset.
- **Features**: hover (`describe.ts`: field types, offsets, sizes, byte order, layers, inverses,
  checks, bit diagrams, binding sites, keyword and attribute docs), completion and signature help
  (`completion.ts`: context from the AST refined by lexing the text before the cursor),
  navigation, references and rename (`index.ts`), and document symbols, semantic tokens, folding,
  inlay hints and code lenses (`features.ts`). Quick fixes come from the diagnostics.
- **Samples** (`sample.ts`): `decodeSample` compiles the file with the chosen struct as an extra
  root, generates TypeScript with the TS backend into a temporary directory (cached per program,
  removed on `dispose`), imports it and walks a lazy view, annotating each field with its value,
  file offset and size. Generated modules import the runtime through a shim that re-exports the
  service's own copy. `getRootParameters` describes the root's parameters for prompting.
- **Layout suggestions** (`layoutSuggest.ts`): `suggestLayout` decodes a sample, rebuilds the
  placement tree of each base region, explains the targets' file order with layout items
  (shortest paths first), chooses alignments from the gaps, and minimizes the result against a
  simulation of the runtime's layout engine (IR.md §4.3). It resolves to undefined when the
  schema's own layouts already reproduce the sample.

## CLI

```
yaffle check [files…] [--project yaffle.json]
yaffle build [--project yaffle.json] [--target ts] [--out dir] [files…]
yaffle ir <file> [--pretty | --text]
yaffle fmt [files…] [--check] [--stdout]
```

Without files, `check` and `fmt` use the project's sources; `--project` defaults to the nearest
`yaffle.json` above the working directory. Diagnostics are printed with the source line and a
caret underline (colored on a TTY unless `NO_COLOR` or `--no-color`). Exit codes: 0 ok, 1 errors
in the sources (or files to reformat with `--check`), 2 usage errors, 70 internal errors.

`build` compiles the project, runs the backends registered in `backends/index.ts` for each
target, and writes their files. Extern module paths in `yaffle.json` are relative to the project
and are passed to the backends relative to the output directory.

## Tests

`packages/compiler/test/{frontend,service,cli}`, run with
`npx vitest run --project yaffle packages/compiler/test/frontend packages/compiler/test/service packages/compiler/test/cli`.

| File                        | Covers                                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `lexer`, `parser`           | every token and construct, error recovery, spans                                                          |
| `diagnostics`               | every diagnostic code, positive and negative (the registry must be covered), quick fixes                  |
| `design`                    | golden IR (`golden/design-*.txt`) for the DESIGN.md examples, and the IR.md §8 examples                   |
| `lowering`                  | golden IR (`golden/lowering-*.txt`) for groups, alignment origins, virtual fields, derived arrays, slices |
| `language`, `semantics`     | bound values, nesting, `$index`, transforms, placements, aliases, generics, roots, …                      |
| `tiff`                      | the TIFF fixture schema (golden and assertions)                                                           |
| `corpus`                    | every conformance schema compiles, validates and formats idempotently                                     |
| `validate`, `format`, `api` | the IR validator, the formatter, the public API                                                           |
| `service/*`                 | every language-service feature, workspace behaviour, sample decoding and layout suggestions, fuzzed edits |
| `cli`                       | every command, in process and as a process                                                                |

## Known limits

- **Presence of conditional fields** is decided structurally: a use is guarded only by the same
  condition text (in an `if` or `?:`), or when every branch declares the field. There is no
  implication reasoning, and member access to conditional fields of _other_ structs isn't
  checked.
- **Formula consistency** (contradictory, partial, lossy, redundant) is decided by sampling the
  measures 0…4096, not by proof.
- **Struct-argument derivations** work one level deep for plain struct fields, not arrays of
  structs. Element-wise lengths support exactly `lens[$index]`.
- **Virtual fields** can't themselves be derived from a later read-side use, and their parts must
  be fields of the same struct.
- **`before` and predicate `until`** are only implemented for arrays (strings and bytes report
  `not-implemented`).
- **Layout paths** don't traverse unions. Layout item arguments can't use sizes or positions.
- **Incremental analysis** is per workspace: any change re-runs the semantic passes over all files
  (parse results are cached per file).
- **Hover offsets** inside switches, unions and after alignment are symbolic approximations.
- **`suggestLayout`** doesn't infer layout groups (a sample only a group can explain is reported
  as inexpressible), assumes every instance of a struct follows one order, and models placement
  constraints only as explicit `@align`.
- **Samples** annotate fields read from streams at their position in the stream, not in
  the file.
