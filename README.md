<p align="center">
  <a href="https://noahcoolboy.github.io/yaffle/"><img src="docs/assets/yaffle.svg" alt="yaffle logo" height="170"></a>
</p>
<h1 align="center">yaffle</h1>
<p align="center">
  <a href="https://github.com/noahcoolboy/yaffle/actions/workflows/ci.yml"><img src="https://github.com/noahcoolboy/yaffle/actions/workflows/ci.yml/badge.svg" alt="CI" height="20"></a>
  <a href="https://noahcoolboy.github.io/yaffle/"><img src="https://img.shields.io/badge/docs-mdBook-67b528" alt="Docs" height="20"></a>
</p>

**Y**et **A**nother **F**ile-**F**ormat **L**anguage & **E**ngine: a language for binary file
formats, and a compiler that generates readers and writers for TypeScript, Rust, Python, Go, C#,
Java and C++. The language is described in [DESIGN.md](DESIGN.md); everything else is in
[docs/](docs/ARCHITECTURE.md).

## Requirements

- Node 24. It runs the TypeScript sources directly, so most packages need no build step.
- To test a target other than TypeScript, its toolchain. With nix:

  | Target | Toolchain                                               |
  | ------ | ------------------------------------------------------- |
  | Rust   | `nix shell nixpkgs#cargo nixpkgs#rustc`                 |
  | Python | `nix shell nixpkgs#python3` (3.12+)                     |
  | Go     | `nix shell nixpkgs#go`                                  |
  | C#     | `nix shell nixpkgs#dotnet-sdk_9`                        |
  | Java   | `nix shell nixpkgs#jdk21`                               |
  | C++    | a C++20 compiler (`$CXX`, default `g++`), zstd and zlib |

## Setup

```sh
npm install
alias yaffle="node --conditions=development $PWD/packages/compiler/src/cli/main.ts"
yaffle check conformance/cases/*/schema.yfl
```

## Checks

```sh
npm run typecheck
npm run lint
npm run format:check
node conformance/scripts/gen-cases.ts --check     # conformance cases match their generators
```

## Tests

```sh
npm test                                          # every vitest project
npx vitest run --project yaffle                   # compiler, language service and backends
npx vitest run --project @yaffle/runtime          # also: @yaffle/lsp, yaffle-vscode, conformance

# the conformance suite, in parse and view mode, for the targets you have toolchains for
node --max-old-space-size=12000 --conditions=development conformance/src/cli.ts --targets ts,rust
```

Conformance output goes to `conformance/.out/`; set `YAFFLE_CONFORMANCE_KEEP=1` to keep the work
directories of passing cases.

## VS Code extension

```sh
npm run build -w yaffle-vscode && npm run package -w yaffle-vscode
code --install-extension packages/vscode/dist/yaffle.vsix
```

Other editors can run the language server directly:
`node --conditions=development packages/lsp/src/main.ts --stdio`.

## CI

`.github/workflows/ci.yml` runs the checks and unit tests, then the conformance suite for each
target in parallel.

## Documentation

The docs in `docs/` build into an [mdBook](https://rust-lang.github.io/mdBook/), deployed to
GitHub Pages by `.github/workflows/docs.yml`. To preview it locally:

```sh
nix shell nixpkgs#mdbook --command mdbook serve --open
```
