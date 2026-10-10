# Architecture

```
.yfl files ──► parser ──► checker ──► IR ──► backends: TS, Rust, Python, Go, C#, Java, C++
                  │                            └─► generated code + a small runtime per target
                  └──► language service ──► language server ──► VS Code extension
```

- **Frontend** (`packages/compiler/src/frontend`): a hand-written lexer, an error-tolerant
  recursive-descent parser, binder, checker and derivation. yaffle's grammar is
  newline-sensitive (optional semicolons, `@` lines continuing the previous field, `<` for both
  generics and comparisons, C declarators like `T *name[n] : u64`), which suits a hand-written
  parser with full control over recovery and ranges. See [compiler.md](compiler.md).
- **IR** (`packages/compiler/src/ir`, [IR.md](IR.md)): a JSON-serializable, language-neutral
  program. Generics are monomorphized and aliases inlined. Bound `$values` and references to
  enclosing structs' fields become implicit parameters passed at every use site, and every value
  the writer computes (derived, computed and constant fields) is an explicit `derive` expression.
  Every semantic question is answered here; backends only translate.
- **Backends** (`packages/compiler/src/backends/<target>`): `generate(program, options)` returns
  source files. They emit imperative code, Kaitai-style, rather than schema objects for an
  interpreter. Each target has a small runtime (streams, views, commit, codecs) that the generated
  code imports or inlines.
- **Language service** (`packages/compiler/src/service`): the editor-facing API over the frontend.
  The language server and the VS Code extension sit on top of it. See [tooling.md](tooling.md).

## Repository

| Path                                          | What                                                           |
| --------------------------------------------- | -------------------------------------------------------------- |
| `packages/compiler`                           | frontend, IR, language service, CLI and every backend          |
| `packages/runtime`, `packages/runtime-<lang>` | the runtime each target's generated code uses                  |
| `packages/lsp`, `packages/vscode`             | language server and VS Code extension                          |
| `conformance`                                 | the shared test suite, its runner, and test externs per target |

## Targets

| Target     | Runtime                   | Parse, serialize, JSON | Views, surgical writes | Async                                  |
| ---------- | ------------------------- | ---------------------- | ---------------------- | -------------------------------------- |
| TypeScript | `packages/runtime`        | ✓                      | ✓                      | sources, codecs, awaitable view chains |
| Rust       | `packages/runtime-rust`   | ✓                      | ✓                      | async codecs run synchronously         |
| Python     | `packages/runtime-python` | ✓                      | ✓                      | asyncio sources, codecs and views      |
| Go         | `packages/runtime-go`     | ✓                      | ✓                      | context-aware codecs, blocking reads   |
| C#         | `packages/runtime-csharp` | ✓                      | ✓                      | sources, codecs and views              |
| Java       | `packages/runtime-java`   | ✓                      | ✓                      | views on virtual threads               |
| C++        | `packages/runtime-cpp`    | ✓                      | ✓ (file-backed views)  | —                                      |

Every target generates the same entry points under its own conventions:

| Target     | Parse / serialize                                                  | JSON                    | Views                                     |
| ---------- | ------------------------------------------------------------------ | ----------------------- | ----------------------------------------- |
| TypeScript | `X.parse(bytes)`, `X.serialize(x)`, `parseAsync`                   | `toJson` / `fromJson`   | `X.view(src)`, `$patches`, `$commit`      |
| Rust       | `X::parse(&bytes)`, `x.serialize()`, `parse_with`                  | `to_json` / `from_json` | `X::view(bytes)`, `set_…`, `commit()`     |
| Python     | `X.parse(data, **params)`, `x.serialize()`, `parse_async`          | `to_json` / `from_json` | `X.view(src)`, `_patches`, `_commit`      |
| Go         | `ParseX(data, opts)`, `SerializeX(v, opts)`, `…Context`            | `XToJSON` / `XFromJSON` | `ViewX(data, opts)`, setters, `Commit`    |
| C#         | `X.Parse(bytes, opts)`, `X.Serialize(x, opts)`, `ParseAsync`       | `ToJson` / `FromJson`   | `X.View(…)`, sync and async               |
| Java       | `X.parse(bytes, options)`, `X.serialize(x, options)`, `parseAsync` | `toJson` / `fromJson`   | `X.view(bytes)`, `patches()`, `commit(…)` |
| C++        | `X::parse(bytes)`, `X::serialize(x)`                               | `to_json` / `from_json` | `X::view(bytes)`, `X::view_file(path)`    |

The details per target are in `targets/<lang>.md`.

## Project config

`yaffle.json` lists the sources and, per target, the output directory and where extern
implementations live. CLI flags override it, and the language server reads the same file.

```jsonc
{
  "sources": ["*.yfl"],
  "targets": {
    "ts": { "out": "gen/ts", "externs": { "zstd": "./externs/zstd.ts" } },
    "rust": { "out": "gen/rust", "externs": { "zstd": "./externs/zstd.rs#ZSTD" } }
  }
}
```

```sh
yaffle check schema.yfl                             # diagnostics with code frames
yaffle build --project yaffle.json --target ts
yaffle ir schema.yfl --text                         # the IR the backends see
yaffle fmt --check *.yfl
```

## Testing

- **Conformance** ([CONFORMANCE.md](CONFORMANCE.md)): one suite of `(.yfl, bytes) → JSON`,
  `JSON → bytes` and round-trip cases, run against every target through a per-target adapter, in
  parse mode and again through lazy views.
- **Per target:** native runtime tests (cargo, unittest, go test, xUnit, a Java runner, a C++
  runner) plus vitest tests that compile `.yfl`, generate code, and build and run it.
- **Frontend and tooling:** unit and golden-IR tests, language server tests at protocol level
  against both a fake and the real compiler, and grammar tests for the extension.
