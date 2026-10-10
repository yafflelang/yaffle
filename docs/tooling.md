# Editor tooling

yaffle ships a language server (`packages/lsp`, `@yaffle/lsp`, executable `yaffle-lsp`) and a VS
Code extension (`packages/vscode`) that bundles it. The language knowledge lives in the compiler's
`LanguageService` (`packages/compiler/src/service/api.ts`); the server is a thin, defensive
protocol adapter over it, so any LSP client gets the same features.

## Language server

### Features

| Feature            | What it does                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diagnostics        | Pushed per file, debounced. Every open file of a project is checked, and with the `project` scope every file in the project's `sources` too, so importers update when an import changes. A service may report problems in other files (at an import's target, say); each diagnostic goes to the file it names. `yaffle.json` problems appear on the config file.                        |
| Quick fixes        | Code actions from the fixes the service attaches to diagnostics: did-you-mean renames, add or remove an import, remove a duplicate attribute or a formula, add `[*]`, and more. When the client sends back a published diagnostic, the server recovers the service's original object (with its fixes). Only yaffle's own diagnostics reach the service, and `context.only` is honoured. |
| Completion         | Context aware: types and keywords at a member start, attributes after `@` (per target), `$` bound values, members after `.`, layout paths, import lists, pointer storage types, clauses, top-level declarations, snippets. Snippet items become plain text for clients without snippet support.                                                                                         |
| Hover              | Types, fields (also imported), enums and members, attributes, `$` values, built-in functions, keywords. Also answers with the cursor just after a word. Markdown when the client renders it.                                                                                                                                                                                            |
| Signature help     | Built-in functions, attributes and struct arguments, with the active parameter.                                                                                                                                                                                                                                                                                                         |
| Navigation         | Go to definition, find references and document highlights (same-file references), across files.                                                                                                                                                                                                                                                                                         |
| Rename             | Fields, structs and other declarations across files, with prepare-rename. Uses versioned `documentChanges` when the client supports them.                                                                                                                                                                                                                                               |
| Symbols            | Document symbols (hierarchical, or flattened for older clients) and workspace symbols from every project.                                                                                                                                                                                                                                                                               |
| Inlay hints        | Derived values where an explicit `= …` would go (`= entries.length`), inferred transform inverses, slice assembly, `decoded` / `on disk` labels inside `@size`, and parameter names for positional struct arguments.                                                                                                                                                                    |
| Code lenses        | `size: 0x20 (32 bytes)` above fixed-size structs, and `needs: $version (u32)` above structs that read bound values. The latter runs `yaffle.showBindingSources`, which peeks the fields and parameters that bind the value.                                                                                                                                                             |
| Semantic tokens    | Full, delta and range; the legend is the service API's token types and modifiers.                                                                                                                                                                                                                                                                                                       |
| Folding            | Blocks, block comments, and runs of line comments or imports.                                                                                                                                                                                                                                                                                                                           |
| Formatting         | Whole-document formatting with the client's `tabSize` / `insertSpaces`. Files with syntax errors are left alone.                                                                                                                                                                                                                                                                        |
| On-type formatting | Typing `@` on a fresh line aligns it with the first postfix attribute of the field above (or its name, as the formatter does); Enter after an `@` continuation line goes back to the field's indentation. Pure text layout, done in the server.                                                                                                                                         |

Custom requests (types in `packages/lsp/src/protocol.ts`, also exported as `@yaffle/lsp/protocol`):

| Request                 | Params                                  | Result                                                                                                                                                                               |
| ----------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `yaffle/showIr`         | `{ textDocument }`                      | The file's IR as JSON (compiled with unsaved contents; 64-bit integers as strings) and its diagnostics.                                                                              |
| `yaffle/rootParameters` | `{ textDocument, root }`                | The parameters the root struct needs (explicit and `$` bound), so a client can ask for `args`.                                                                                       |
| `yaffle/decodeSample`   | `{ textDocument, root, sample, args? }` | Decodes a sample with the root struct and returns annotations: the field's range, a short rendering of its value, and the offset and size in the sample.                             |
| `yaffle/suggestLayout`  | `{ textDocument, root, sample, args? }` | A workspace edit (in `changes` form) with `layout { … }` rules that reproduce the sample's target order and alignment, or `null` when the sample already follows the default layout. |

`sample` is `{ uri }` (a file the server reads) or `{ base64 }`. `args` is canonical JSON
(docs/CONFORMANCE.md). Malformed params are protocol errors; anything else that goes wrong
(unknown root, a sample that doesn't decode, no compiler) comes back in the result's `error`
string, a message for the user.

### Behaviour

- **Sync.** Incremental document sync, `positionEncoding: utf-16` (the service's encoding, so
  positions pass through unchanged). Every edit reaches the service immediately; only
  diagnostics are debounced.
- **Projects.** A file belongs to the nearest `yaffle.json` above it, and each config gets its
  own service; files with none share an inferred project. Configs at workspace-folder roots are
  loaded at startup and follow workspace-folder changes. Unsaved editor contents are visible to
  every project. Non-file documents (`untitled:`) get virtual paths and join the first workspace
  project.
- **Watching.** The server registers watchers for `**/yaffle.json` and `**/*.yfl`. Config changes
  reload the project; configs appearing or disappearing move open files between projects. On-disk
  changes go only to the projects whose service read or probed the file (or, for creations and
  deletions, whose directory contains it). Files a service read from outside the workspace get
  their own watchers when the client supports relative patterns.
- **Staleness and cancellation.** Each request yields once so a pending cancellation or edit can
  arrive, then answers `RequestCancelled` if cancelled, or `ContentModified` if its document
  changed (position-based requests only). A diagnostics pass yields between files and stops as
  soon as a newer edit arrives.
- **Fault isolation.** Every service call is guarded: an exception is logged (throttled) and
  answered with an empty result, malformed results are sanitized (VS Code rejects a whole
  response over one bad range), and a service that fails to start is reported once with
  `window/showMessage`. Nothing is sent after shutdown, and a closed connection never throws.

### Architecture

| Module              | Role                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`         | `YaffleServer` / `startServer(connection, options)`: lifecycle and capabilities, document sync, projects and watching, diagnostics scheduling, the standard requests. |
| `custom.ts`         | The `yaffle/*` requests.                                                                                                                                              |
| `projects.ts`       | One service per `yaffle.json` plus the inferred project; nearest-config lookup (cached); the host that overlays unsaved contents and records what each service read.  |
| `safe.ts`           | `SafeService` (guarded service calls), `ErrorReporter` (throttled logging), loggers.                                                                                  |
| `convert.ts`        | Service ↔ LSP types, with sanitizing, and snippet → plain text.                                                                                                       |
| `diagnostics.ts`    | Published diagnostics merged across sources (each project and each config check), re-published only when they change.                                                 |
| `semanticTokens.ts` | Legend, validation, delta encoding and the per-document cache for deltas.                                                                                             |
| `uri.ts`            | URI ↔ path for both path flavours (testable on any OS), keeping the client's URI spelling.                                                                            |
| `config.ts`         | The `yaffle.*` settings, and a fallback JSONC `yaffle.json` loader.                                                                                                   |
| `attributeAlign.ts` | On-type alignment of `@` continuation lines.                                                                                                                          |
| `fs.ts`             | Injectable filesystem (`nodeFileSystem`, `MemoryFileSystem`).                                                                                                         |
| `protocol.ts`       | Custom requests, settings and command ids; dependency-free, shared with clients.                                                                                      |
| `main.ts`           | The `yaffle-lsp` executable.                                                                                                                                          |

`startServer` takes the service factory and, optionally, the compiler's `compile` (for Show IR),
its `loadProjectConfig`, a filesystem, a path flavour, a logger and initial settings. `main.ts`
wires in the compiler.

### Running

```
yaffle-lsp [--stdio | --node-ipc | --socket=<port> | --pipe=<name>] [--service <module>]
node --conditions=development packages/lsp/src/main.ts --stdio     # from the sources
```

`--stdio` is the default. `--service <module>` (or `YAFFLE_LSP_SERVICE`) runs the server on
another module exporting `createLanguageService(host)`, and optionally `compile` and
`loadProjectConfig`; the end-to-end tests use it to run on a fake service.

### Settings

Pulled with `workspace/configuration` (section `yaffle`) at startup and on change; clients
without it can push them with `didChangeConfiguration` or `initializationOptions.settings`.

| Setting                                | Default   | Effect                                                              |
| -------------------------------------- | --------- | ------------------------------------------------------------------- |
| `yaffle.diagnostics.delay`             | `250`     | Milliseconds after the last edit before checking again (0 on open). |
| `yaffle.diagnostics.scope`             | `project` | `project`: every file of the project; `openFiles`: only open files. |
| `yaffle.inlayHints.enabled`            | `true`    | Inlay hints.                                                        |
| `yaffle.codeLens.enabled`              | `true`    | Code lenses.                                                        |
| `yaffle.format.enabled`                | `true`    | Formatting.                                                         |
| `yaffle.alignAttributesOnType.enabled` | `true`    | On-type alignment of `@` lines.                                     |

## VS Code extension

- **Language** `yaffle` for `.yfl` files: comments, brackets, auto-closing pairs, a word pattern
  that keeps `$bound`, `@attr` and numbers with `_` together, indentation and on-enter rules
  (doc comments, `case:`, `@` continuation lines), and a JSON schema for `yaffle.json`.
- **Grammar** `source.yaffle`, written in `src/grammar.ts` and generated into
  `syntaxes/yaffle.tmLanguage.json` by the build (a test checks the committed file is current).
  It covers every declaration, primitives with `le`/`be`, attributes and their arguments, `$`
  values, all literals (hex and binary with `_`, floats, `x"…"`, `b64"…"`, FourCCs, escapes),
  regexes after `in`, lambdas, operators, `[*]` and layout blocks. Expressions (lengths, `=`,
  `as`, `where`, `in`, `at`, `from`, attribute arguments) are tokenized in their own regions, so
  `rows * cols` in a formula is not taken for a pointer field. Semantic tokens from the server
  refine it.
- **Snippets** for structs (plain, exported, parameterized, generic), magic constants, enums,
  bits, unions, `switch`, `if`/`else`, endianness blocks, pointers, `at`, `@via` fields, imports,
  constants, type aliases, extern codecs, functions and types, and `layout`.
- **Commands** (category `yaffle`):

  | Command                     | What it does                                                                                                                                                                                                                                                                                                                                                             |
  | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | Show IR                     | Opens a read-only `yaffle-ir:` JSONC view of the active file's IR beside it, refreshed on every `.yfl` save.                                                                                                                                                                                                                                                             |
  | Decode Sample File…         | Asks for a root struct (from the document's symbols), a sample file and the root's parameters (prefilled with the last answers; bytes as hex), then shows decoded values at the end of each field line, with a hover table of values, offsets and sizes. A status bar item clears them. Re-decodes on save; a failed re-decode keeps the values and flags them as stale. |
  | Suggest Layout from Sample… | Same questions, then applies the suggested `layout` rules.                                                                                                                                                                                                                                                                                                               |
  | Clear Sample Annotations    | Removes the decoded values.                                                                                                                                                                                                                                                                                                                                              |
  | Restart Language Server     | Restarts the server (also done when a `yaffle.server.*` setting changes).                                                                                                                                                                                                                                                                                                |
  | Show Language Server Output | Opens the server's log.                                                                                                                                                                                                                                                                                                                                                  |
  | `yaffle.showBindingSources` | Internal: the `needs: $…` code lens's peek.                                                                                                                                                                                                                                                                                                                              |

- **Settings**, besides the server's above:

  | Setting                        | Effect                                                                                                                                                                                                                                |
  | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `yaffle.server.path`           | A server to run instead of the bundled one: a JavaScript module (run with Node over IPC; `.ts` with `--conditions=development`) or an executable (started with `--stdio`). Relative paths resolve against the first workspace folder. |
  | `yaffle.server.runtime`        | The Node executable for a module server; empty for VS Code's own.                                                                                                                                                                     |
  | `yaffle.trace.server`          | Trace the LSP traffic in the output channel.                                                                                                                                                                                          |
  | `yaffle.sample.redecodeOnSave` | Decode the current sample again on every `.yfl` save (default on).                                                                                                                                                                    |

  The extension turns on `editor.formatOnType` and semantic highlighting for yaffle files.

## Building and packaging

```
npm run build -w yaffle-vscode      # grammar JSON, dist/extension.cjs, dist/server.mjs
npm run package -w yaffle-vscode    # dist/yaffle.vsix
```

esbuild bundles the extension as CommonJS (what the extension host loads, `vscode` external) and
the server with the compiler as ESM, with a `createRequire` banner because the bundled CommonJS
dependencies `require()` Node built-ins. Both bundle straight from the TypeScript sources through
the `development` condition, so no package needs a `tsc` build first. `vsce package` runs with
`--no-dependencies`: everything is bundled, so runtime libraries are devDependencies.

## Tests

```
npx vitest run --project @yaffle/lsp --project yaffle-vscode
```

- `packages/lsp/test`: the server over an in-memory JSON-RPC connection against a fake service
  (`fakeService.ts`, predictable text rules) with VS Code-like, minimal and plain-text clients and
  both path flavours; resilience against a throwing or malformed service; unit tests of the pure
  modules; `main.ts` over stdio.
- `packages/lsp/test/integration`: the same server on the real compiler and a small invented project (`project.ts`):
  every feature at every word, keystroke-by-keystroke and random edits, workspace changes,
  Windows paths, sample decoding,
  and `main.ts` over stdio.
- `packages/vscode/test`: the grammar through vscode-textmate (every construct and the
  `DESIGN.md` examples), the manifest, language configuration and snippets, building and
  `vsce package`, and the bundled extension activated against a `vscode` stand-in
  (`vscodeMock.cjs`) with the real language client and bundled server running every command.

## Known gaps

- Diagnostics are pushed; there are no pull diagnostics.
- A project created to answer a request about a file that isn't open (hover after go to
  definition, say) stays loaded until shutdown.
- A `yaffle.json` created above the workspace folders is only noticed in directories a service
  has read from.
- Imports from non-file (`untitled:`) documents don't resolve.
- No range formatting.
- The grammar is heuristic where TextMate can't know types: `Type name` decides a field
  declaration, and several fields on one line after an expression aren't always split.
- The extension isn't tested in a real VS Code (that needs a download and a display); the
  activation test uses a `vscode` stand-in with the real client and server.
- A missing executable in `yaffle.server.path` is reported by the language client itself; a
  missing module is checked up front.
