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
npx vitest run --project @yafflelang/runtime          # also: @yafflelang/lsp, yaffle-vscode, conformance

# the conformance suite, in parse and view mode, for the targets you have toolchains for
node --max-old-space-size=12000 --conditions=development conformance/src/cli.ts --targets ts,rust
```

Conformance output goes to `conformance/.out/`; work directories are kept only for failing cases.

## VS Code extension

```sh
npm run build -w yaffle-vscode && npm run package -w yaffle-vscode
code --install-extension packages/vscode/dist/yaffle.vsix
```

Other editors can run the language server directly:
`node --conditions=development packages/lsp/src/main.ts --stdio`.
