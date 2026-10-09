/**
 * Python backend: externs, codecs (reuse, streaming, async), async sources, the inlined runtime,
 * and mypy --strict on generated code.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimePackageRoot } from "../../../src/backends/python/index.ts";
import { cacheDir } from "../../../src/backends/python/python.ts";
import { HAVE_PYTHON, PRELUDE, REPO, generate, program, py } from "./harness.ts";

const d = describe.skipIf(!HAVE_PYTHON);
const ext = (name: string): string => join(REPO, "conformance/externs/python", `${name}.py`);

const CODECS = `
extern codec xor(u8 key) @ranged
extern codec rle
extern codec rlez @streaming
extern async codec axor(u8 key)
extern fn sum8(u8 data[]) -> u8
extern type VarInt(u8 maxBytes) : u64

struct Inner { u8 a  u16 b }
export struct Packed {
  u8    size
  Inner body @via(rle) @size(size)
  u8    sum = sum8(bytesof(body))
  VarInt(4) big
  uleb128   small
}
export struct Stream { u8 data[] @via(rlez)  u8 after }
export struct Async { u8 n  u8 data[n] @via(axor(0x0f)) }
`;

function externs(): Record<string, string> {
  return {
    xor: ext("xor"),
    rle: ext("rle"),
    rlez: ext("rlez"),
    axor: ext("axor"),
    sum8: ext("sum8"),
    VarInt: ext("varint")
  };
}

d("Python backend: externs and codecs", () => {
  it("runs codecs, extern fns and extern types; reuses non-canonical encodings", async () => {
    const gen = generate("feat_codecs", program(CODECS), { externs: externs() });
    const out = await py(
      gen,
      `${PRELUDE}
from ${gen.pkg}.schema import Packed, Inner, Stream
# rle with a non-canonical run split (1 x 05, 1 x 05) that a fresh encode would merge
data = bytes.fromhex("06" "0105" "0105" "0100" "0d" "ac02" "05")
p = Packed.parse(data)
again = p.serialize()
fresh = Packed.from_json(p.to_json()).serialize()
p2 = Packed.parse(data)
p2.body.b = 1
edited = p2.serialize()
s = Stream.parse(bytes.fromhex("030700" "09"))
print(json.dumps({"json": p.to_json(), "reuse": again.hex(), "fresh": fresh.hex(), "edited": edited.hex(),
                  "stream": s.to_json(), "sout": s.serialize().hex()}))
`
    );
    expect(out).toEqual({
      json: { size: 6, body: { a: 5, b: 5 }, sum: 13, big: "300", small: "5" },
      reuse: "06010501050100" + "0d" + "ac02" + "05",
      fresh: "040205" + "0100" + "08" + "ac02" + "05",
      edited: "06" + "0105" + "0101" + "0100" + "09" + "ac02" + "05",
      stream: { data: "070707", after: 9 },
      sout: "030700" + "09"
    });
  });

  it("host failures are CODEC errors", async () => {
    const gen = generate("feat_codec_err", program(CODECS), { externs: externs() });
    const out = await py(
      gen,
      `${PRELUDE}
from ${gen.pkg}.schema import Packed, Stream
print(json.dumps([
  err(lambda: Packed.parse(bytes.fromhex("02" "0005" "00" "00" "00"))),
  err(lambda: Stream.parse(bytes.fromhex("0307"))),
]))
`
    );
    expect(out).toEqual([
      { code: "CODEC", path: ["body"] },
      { code: "CODEC", path: ["data"] }
    ]);
  });

  it("async codecs: parse_async / serialize_async; the sync API is not generated", async () => {
    const gen = generate("feat_async", program(CODECS), { externs: externs() });
    const out = await py(
      gen,
      `${PRELUDE}
from ${gen.pkg}.schema import Async
async def main():
    a = await Async.parse_async(bytes.fromhex("02" "f0f1"))
    out = await a.serialize_async()
    r = await Async.safe_parse_async(bytes.fromhex("05" "00"))
    return {"json": a.to_json(), "out": out.hex(), "sync": hasattr(Async, "parse"),
            "err": [r.ok, r.error.code, r.error.path]}
print(json.dumps(asyncio.run(main())))
`
    );
    expect(out).toEqual({
      json: { n: 2, data: "fffe" },
      out: "02f0f1",
      sync: false,
      err: [false, "EOF", ["data"]]
    });
  });

  it("async sources (read returns a coroutine) and file sources", async () => {
    const gen = generate("feat_sources", program(`export struct P { u16 a  u8 rest[] }`));
    const file = join(cacheDir(), "tests", "feat_sources", "data.bin");
    const out = await py(
      gen,
      `${PRELUDE}
from ${gen.pkg}.schema import P
class Src:
    def __init__(self, b): self.b, self.size = b, len(b)
    async def read(self, off, n):
        await asyncio.sleep(0)
        return self.b[off:off + n]
open(${JSON.stringify(file)}, "wb").write(bytes.fromhex("0100aabb"))
async def main():
    return (await P.parse_async(Src(bytes.fromhex("0200cc")))).to_json()
with rt.file_source(${JSON.stringify(file)}) as f:
    fs = P.parse(f).to_json()
sync_err = err(lambda: P.parse(Src(b"\\x00\\x00")))
print(json.dumps({"async": asyncio.run(main()), "file": fs, "syncerr": sync_err}))
`
    );
    expect(out).toEqual({
      async: { a: 2, rest: "cc" },
      file: { a: 1, rest: "aabb" },
      syncerr: { code: "INPUT", path: [] }
    });
  });

  it("inlineRuntime: the package runs without yaffle_runtime installed", async () => {
    const gen = generate(
      "feat_inline",
      program({
        "/m/schema.yfl": `import { Pt } from "./sub/common.yfl"\nexport struct Shape { u8 n  Pt pts[n] }`,
        "/m/sub/common.yfl": `export struct Pt { i16 x  i16 y }`
      }),
      { inlineRuntime: true }
    );
    const out = await py(
      gen,
      `
import json, sys
from ${gen.pkg}.schema import Shape
s = Shape.parse(bytes.fromhex("01" "0100" "ffff"))
print(json.dumps({"json": s.to_json(), "rt": "yaffle_runtime" in sys.modules,
                  "out": s.serialize().hex()}))
`,
      { isolated: true }
    );
    expect(out).toEqual({ json: { n: 1, pts: [{ x: 1, y: -1 }] }, rt: false, out: "010100ffff" });
  });
});

/** mypy (resolved once through nix if not on PATH; the tests skip when unavailable). */
function findMypy(): string[] | undefined {
  try {
    execFileSync("mypy", ["--version"], { stdio: "ignore" });
    return ["mypy"];
  } catch {
    if (process.env.YAFFLE_PYTHON_MYPY !== "1") return undefined;
    return ["nix", "shell", "nixpkgs#python3Packages.mypy", "--command", "mypy"];
  }
}

const MYPY = HAVE_PYTHON ? findMypy() : undefined;

describe.skipIf(!MYPY)("Python backend: mypy --strict", () => {
  it("generated code and the runtime type-check", () => {
    const gen = generate(
      "feat_mypy",
      program(CODECS + "\n" + `export struct Extra { u8 n  u16 xs[n] }`),
      {
        externs: externs()
      }
    );
    const env = {
      ...process.env,
      MYPYPATH: runtimePackageRoot(),
      MYPY_CACHE_DIR: join(cacheDir(), "mypy")
    };
    const [cmd, ...args] = MYPY!;
    const out = execFileSync(cmd!, [...args, "--strict", "-p", gen.pkg, "-p", "yaffle_runtime"], {
      cwd: gen.dir,
      env: { ...env, MYPYPATH: `${runtimePackageRoot()}` },
      encoding: "utf8"
    });
    expect(out).toMatch(/Success/);
    expect(existsSync(join(gen.dir, gen.pkg, "schema.py"))).toBe(true);
  }, 600_000);
});
