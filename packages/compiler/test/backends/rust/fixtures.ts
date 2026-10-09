/** Shared IR fixtures: a chunk-like container (with a reference writer) and an archive. */
import { L, S, block, e, f, konst, layoutItem, len, lenOf, program, t, vt } from "./ir-builder.ts";

const u32p = (target: ReturnType<typeof t.s>, o: Parameters<typeof t.ptr>[1] = {}) =>
  t.ptr(target, { storage: "u32", ...o });
export const chunk = program(
  [
    S("Model", [
      f("n", t.u32, { derive: lenOf("data", vt.bytes) }),
      f("data", t.bytes(len.count(e.f("n"))))
    ]),
    S("Curve", [
      f("n", t.u32, { derive: lenOf("points", vt.array(vt.f32)) }),
      f("points", t.ptr(t.array(t.f32, len.count(e.f("n"))), { storage: "u32" }))
    ]),
    S("Curves", [f("x", u32p(t.s("Curve"))), f("y", u32p(t.s("Curve"))), f("a", t.f32)], {
      layout: [
        layoutItem(["x", "points"]),
        layoutItem(["y", "points"]),
        layoutItem(["x"]),
        layoutItem(["y"]),
        layoutItem("this")
      ]
    }),
    S(
      "Record",
      [
        f("model", u32p(t.s("Model"), { nullable: "0" })),
        f("curves", u32p(t.s("Curves"))),
        f("name", t.ptr(t.str(), { storage: "u32", ref: true })),
        f("flags", t.u16),
        konst("pad", t.u16, e.int(0), vt.u16)
      ],
      { layout: [layoutItem(["curves"])] }
    ),
    S(
      "Chunk",
      [
        block(
          [
            konst("tag", t.str(len.n(4)), e.str("CHNK"), vt.str),
            f("r", t.u8, { derive: lenOf("records", vt.array(vt.struct("Record"))) }),
            f("recordsOfs", t.u32, {
              derive: e.offsetof("records", vt.array(vt.struct("Record")))
            }),
            f("recPtrsOfs", t.u32, { derive: e.offsetof("recPtrs", vt.array(vt.struct("Record"))) })
          ],
          { layers: [L.padUntil(0x20)] }
        ),
        f("pool", t.array(t.str(), len.until(e.str("")))),
        f("records", t.array(t.s("Record"), len.count(e.f("r", vt.u8))), {
          placement: { offset: e.f("recordsOfs") }
        }),
        f("recPtrs", t.array(u32p(t.s("Record"), { ref: true }), len.count(e.f("r", vt.u8))), {
          placement: { offset: e.f("recPtrsOfs") }
        })
      ],
      {
        base: true,
        layers: [L.alignEnd(0x10)],
        layout: [
          layoutItem(["records", "*", "model"], 0x10),
          layoutItem(["records", "*"], 4),
          layoutItem(["records"], 8),
          layoutItem(["recPtrs"])
        ]
      }
    ),
    // A file with a prefix and a nested chunk (its own base).
    S("File", [
      f("magic", t.u32),
      f("size", t.u32, { derive: e.sizeof("chunk", vt.struct("Chunk")) }),
      f("reserved", t.bytes(len.n(8))),
      f("chunk", t.layered(t.s("Chunk"), L.size(e.f("size")))),
      f("trailer", t.ptr(t.s("Model"), { storage: "u32" }))
    ])
  ],
  ["Chunk", "File"]
);

// ─── A reference writer for the chunk-like layout ─────────────────────────────

export interface RefRecord {
  model: number[] | null;
  xs: number[];
  ys: number[];
  a: number;
  name: string;
  flags: number;
}

export function chunkBytes(
  pool: string[],
  recs: RefRecord[]
): { bytes: Buffer; offsets: Record<string, number> } {
  const buf = Buffer.alloc(4096);
  let pos = 0;
  const align = (n: number) => {
    pos = Math.ceil(pos / n) * n;
  };
  // header (0x20) + pool
  buf.write("CHNK", 0, "latin1");
  buf.writeUInt8(recs.length, 4);
  pos = 0x20;
  const poolOfs: Record<string, number> = {};
  for (const s of pool) {
    poolOfs[s] = pos;
    pos += buf.write(s + "\0", pos, "latin1");
  }
  buf.writeUInt8(0, pos++);
  // models, 0x10-aligned
  const modelOfs: number[] = [];
  for (const r of recs) {
    if (!r.model) {
      modelOfs.push(0);
      continue;
    }
    align(0x10);
    modelOfs.push(pos);
    buf.writeUInt32LE(r.model.length, pos);
    Buffer.from(r.model).copy(buf, pos + 4);
    pos += 4 + r.model.length;
  }
  // each record's curves: x.points, y.points, x, y, this (align 4)
  const curvesOfs: number[] = [];
  for (const r of recs) {
    align(4);
    const xp = pos;
    for (const v of r.xs) {
      buf.writeFloatLE(v, pos);
      pos += 4;
    }
    align(4);
    const yp = pos;
    for (const v of r.ys) {
      buf.writeFloatLE(v, pos);
      pos += 4;
    }
    align(4);
    const x = pos;
    buf.writeUInt32LE(r.xs.length, pos);
    buf.writeUInt32LE(xp, pos + 4);
    pos += 8;
    align(4);
    const y = pos;
    buf.writeUInt32LE(r.ys.length, pos);
    buf.writeUInt32LE(yp, pos + 4);
    pos += 8;
    align(4);
    curvesOfs.push(pos);
    buf.writeUInt32LE(x, pos);
    buf.writeUInt32LE(y, pos + 4);
    buf.writeFloatLE(r.a, pos + 8);
    pos += 12;
  }
  // records, 8-aligned
  align(8);
  const recordsOfs = pos;
  for (const [i, r] of recs.entries()) {
    buf.writeUInt32LE(modelOfs[i]!, pos);
    buf.writeUInt32LE(curvesOfs[i]!, pos + 4);
    buf.writeUInt32LE(poolOfs[r.name]!, pos + 8);
    buf.writeUInt16LE(r.flags, pos + 12);
    buf.writeUInt16LE(0, pos + 14);
    pos += 16;
  }
  const recPtrsOfs = pos;
  for (let i = 0; i < recs.length; i++) {
    buf.writeUInt32LE(recordsOfs + 16 * i, pos);
    pos += 4;
  }
  buf.writeUInt32LE(recordsOfs, 5);
  buf.writeUInt32LE(recPtrsOfs, 9);
  align(0x10);
  return { bytes: buf.subarray(0, pos), offsets: { recordsOfs, recPtrsOfs } };
}

export const POOL = ["alpha", "beta", "unused_gamma"];
export const RECS: RefRecord[] = [
  { model: [1, 2, 3, 4], xs: [0, 30, 45], ys: [1.5], a: 1.25, name: "beta", flags: 3 },
  { model: [9, 9], xs: [7], ys: [2.5, 3.5], a: 2.5, name: "alpha", flags: 1 }
];

const entry = S("Entry", [
  f("handler", t.u16),
  f("kind", t.u16),
  f("align", t.u32),
  f("offset", t.u64, { derive: e.offsetof("data") }),
  f("size", t.u32, { derive: lenOf("data", vt.bytes) }),
  f("reserved", t.u32),
  f("data", t.layered(t.bytes(len.count(e.f("size"))), L.align(e.f("align"))), {
    placement: { offset: e.f("offset", vt.u64) }
  })
]);

const archive = S("Archive", [
  block(
    [
      konst("tag", t.str(len.n(4), "latin1"), e.str("ARCV"), vt.str),
      f("count", t.u32, { derive: lenOf("entries", vt.array(vt.struct("Entry"))) })
    ],
    { layers: [L.padUntil(0x80)] }
  ),
  f("entries", t.array(t.s("Entry"), len.count(e.f("count"))))
]);

export const arcv = program([entry, archive], ["Archive"]);
