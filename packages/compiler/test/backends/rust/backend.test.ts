/** Rust backend: naming, packaging (module / crate / inlined runtime), errors. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { backends } from "../../../src/backends/index.ts";
import { rustBackend, runtimeSources } from "../../../src/backends/rust/index.ts";
import { BackendError } from "../../../src/backends/rust/model.ts";
import { NameSet, camel, ident, snake, strLit } from "../../../src/backends/rust/names.ts";
import { cargo } from "../../../src/backends/rust/toolchain.ts";
import { L, S, codec, e, f, len, lenOf, program, t, vt } from "./ir-builder.ts";
import { hasRust, scratch } from "./rust-utils.ts";

const simple = program(
  [
    S("Item", [f("type", t.u8), f("self", t.u16)]),
    S("Doc", [
      f("count", t.u8, { derive: lenOf("items", vt.array(vt.struct("Item"))) }),
      f("items", t.array(t.s("Item"), len.count(e.f("count", vt.u8)))),
      f("fooBar", t.str())
    ])
  ],
  ["Doc"]
);

describe("rust names", () => {
  it("escapes keywords and converts case", () => {
    expect(snake("fooBar")).toBe("foo_bar");
    expect(snake("HTTPServer")).toBe("http_server");
    expect(snake("type")).toBe("r#type");
    expect(snake("self")).toBe("self_");
    expect(camel("ARCV")).toBe("Arcv");
    expect(camel("0ABC")).toBe("V0Abc");
    expect(camel("hello_world")).toBe("HelloWorld");
    expect(ident("a-b")).toBe("a_b");
    expect(strLit('a"\\\n\u0001')).toBe('"a\\"\\\\\\n\\u{1}"');
    const ns = new NameSet(["x"]);
    expect(ns.take("x")).toBe("x2");
    expect(ns.take("y")).toBe("y");
  });
});

describe("rust backend packaging", () => {
  it("is registered", () => {
    expect(backends["rust"]).toBe(rustBackend);
  });

  it("emits one module by default", () => {
    const files = rustBackend.generate(simple, { externs: {} });
    expect(files.map(f => f.path)).toEqual(["mod.rs"]);
    const src = files[0]!.contents;
    expect(src).toContain("pub struct Doc {");
    expect(src).toContain("pub r#type: u8,");
    expect(src).toContain("pub self_: u16,");
    expect(src).toContain("pub foo_bar: String,");
    expect(src).toContain("use ::yaffle_runtime as yr;");
    expect(src).toContain("pub fn parse(bytes: &[u8]) -> yr::Result<Self>");
  });

  it("emits a crate, optionally with the runtime inlined", () => {
    const crate = rustBackend.generate(simple, {
      externs: {},
      targetOptions: { crate: { name: "docs", runtimePath: "../runtime" } }
    });
    expect(crate.map(f => f.path)).toEqual(["Cargo.toml", "src/lib.rs"]);
    expect(crate[0]!.contents).toContain('yaffle-runtime = { path = "../runtime" }');
    const inline = rustBackend.generate(simple, {
      externs: {},
      inlineRuntime: true,
      targetOptions: { crate: { name: "docs" } }
    });
    expect(inline.map(f => f.path)).toContain("src/yaffle_runtime/mod.rs");
    expect(inline.map(f => f.path)).toContain("src/yaffle_runtime/write.rs");
    expect(inline[0]!.contents).not.toContain("yaffle-runtime");
    expect(inline.find(f => f.path === "src/lib.rs")!.contents).toContain(
      "use crate::yaffle_runtime as yr;"
    );
    for (const s of runtimeSources()) expect(s.contents).not.toContain("#[cfg(test)]");
    const mod = rustBackend.generate(simple, { externs: {}, inlineRuntime: true });
    expect(mod[0]!.path).toBe("mod.rs");
    expect(mod[0]!.contents).toContain("pub mod yaffle_runtime;");
    expect(mod[0]!.contents).toContain("use self::yaffle_runtime as yr;");
  });

  it("requires extern implementations", () => {
    const p = program([S("X", [f("d", t.layered(t.bytes(len.rest), L.via("zstd")))])], ["X"], {
      externs: [codec("zstd")]
    });
    expect(() => rustBackend.generate(p, { externs: {} })).toThrow(BackendError);
    expect(() => rustBackend.generate(p, { externs: { zstd: "crate::z::Zstd" } })).not.toThrow();
  });

  it("mounts extern files as modules and adds dependencies to the crate", () => {
    const p = program([S("X", [f("d", t.layered(t.bytes(len.rest), L.via("zstd")))])], ["X"], {
      externs: [codec("zstd")]
    });
    // Module mode: paths relative to the output directory, items by `#ITEM` or the extern name.
    const mod = rustBackend.generate(p, { externs: { zstd: "../externs/zstd.rs#ZSTD" } });
    expect(mod[0]!.contents).toContain('#[path = "../externs/zstd.rs"]\npub mod ext_zstd;');
    expect(mod[0]!.contents).toContain("self::ext_zstd::ZSTD");
    const nested = rustBackend.generate(p, {
      externs: { zstd: "./zstd.rs" },
      targetOptions: { fileName: "gen/formats.rs" }
    });
    expect(nested[0]!.contents).toContain('#[path = "../zstd.rs"]');
    expect(nested[0]!.contents).toContain("self::ext_zstd::zstd");
    // Crate mode: src/lib.rs is one level down; dependencies go to Cargo.toml.
    const crate = rustBackend.generate(p, {
      externs: { zstd: "./externs/zstd.rs#ZSTD" },
      targetOptions: {
        crate: { name: "x", runtimePath: "../runtime" },
        dependencies: { zstd: "0.13", miniz_oxide: { version: "0.8", default_features: false } }
      }
    });
    expect(crate[0]!.contents).toContain('zstd = "0.13"');
    expect(crate[0]!.contents).toContain(
      'miniz_oxide = { version = "0.8", default_features = false }'
    );
    const lib = crate.find(x => x.path === "src/lib.rs")!.contents;
    expect(lib).toContain('#[path = "../externs/zstd.rs"]');
    expect(lib).toContain("crate::ext_zstd::ZSTD");
  });

  it.skipIf(!hasRust)(
    "builds a dependency-free crate with the runtime inlined, without warnings",
    async () => {
      const dir = scratch("inline-crate");
      const files = rustBackend.generate(simple, {
        externs: {},
        inlineRuntime: true,
        targetOptions: { crate: { name: "yaffle_t_inline" } }
      });
      for (const file of files) {
        mkdirSync(dirname(join(dir, file.path)), { recursive: true });
        writeFileSync(join(dir, file.path), file.contents);
      }
      mkdirSync(join(dir, "tests"), { recursive: true });
      writeFileSync(
        join(dir, "tests/roundtrip.rs"),
        `use yaffle_t_inline::*;
#[test]
fn roundtrip() {
    let bytes = [2u8, 1, 2, 0, 3, 4, 0, b'h', b'i', 0];
    let doc = Doc::parse(&bytes).unwrap();
    assert_eq!(doc.items.len(), 2);
    assert_eq!(doc.items[1].self_, 4);
    assert_eq!(doc.foo_bar, "hi");
    assert_eq!(doc.serialize().unwrap(), bytes);
    let json = doc.to_json();
    assert_eq!(Doc::from_json(&json).unwrap(), doc);
    let built = Doc { items: vec![Item { r#type: 9, self_: 1 }], foo_bar: "x".into(), ..Default::default() };
    assert_eq!(built.serialize().unwrap(), vec![1, 9, 1, 0, b'x', 0]);
    let err = Doc::parse(&[5, 1]).unwrap_err();
    assert_eq!(err.code, yaffle_t_inline::yaffle_runtime::ErrorCode::Eof);
}
`
      );
      const r = await cargo(dir, ["test", "--quiet", "--message-format", "short"]);
      expect(r.code, r.stderr + r.stdout).toBe(0);
      expect(r.stderr).not.toMatch(/warning/);
      expect(r.stdout).toMatch(/1 passed/);
    },
    600_000
  );
});
