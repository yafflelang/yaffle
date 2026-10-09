/**
 * Rust views: lazy scans, nested views, lazily read targets, in-place patches, commit.
 * The checks are Rust unit tests inside the harness crate, run with `cargo test`.
 */
import { describe, expect, it } from "vitest";
import { testHarness } from "../../../src/backends/rust/harness.ts";
import { L, S, e, f, len, program, t } from "./ir-builder.ts";
import { POOL, RECS, chunk, chunkBytes, arcv } from "./fixtures.ts";
import { hasRust, scratch } from "./rust-utils.ts";

const misc = program(
  [
    S("Rec", [
      f("id", t.u16),
      f("name", t.str(len.n(6))),
      f("tag", t.str()),
      f("al", t.layered(t.u8, L.align(4)))
    ]),
    S("Doc", [f("n", t.u8), f("recs", t.array(t.s("Rec"), len.count(e.f("n"))))])
  ],
  ["Doc"]
);

function archiveHex(): string {
  const hdr = Buffer.alloc(0x80);
  hdr.write("ARCV", 0, "latin1");
  hdr.writeUInt32LE(2, 4);
  const ents = Buffer.alloc(2 * 0x18);
  const datas = [Buffer.from([1, 2, 3]), Buffer.from([4, 5])];
  let pos = 0x80 + ents.length;
  const placed: number[] = [];
  for (const [i, d] of datas.entries()) {
    pos = Math.ceil(pos / 0x10) * 0x10;
    placed.push(pos);
    ents.writeUInt32LE(0x10, i * 0x18 + 4);
    ents.writeBigUInt64LE(BigInt(pos), i * 0x18 + 8);
    ents.writeUInt32LE(d.length, i * 0x18 + 16);
    pos += d.length;
  }
  const file = Buffer.alloc(pos);
  hdr.copy(file);
  ents.copy(file, 0x80);
  datas.forEach((d, i) => d.copy(file, placed[i]!));
  return file.toString("hex");
}

const TESTS = (pf: string, chunkHex: string) => `
#[cfg(test)]
mod view_tests {
    use super::*;
    use yaffle_runtime as yr;

    fn unhex(s: &str) -> Vec<u8> { yr::json::unhex(s).unwrap() }

    #[test]
    fn packed_file_view_reads_lazily_and_patches_in_place() {
        let bytes = unhex("${pf}");
        let v = arcv::Archive::view(bytes.clone()).unwrap();
        assert_eq!(v.count().unwrap(), 2);
        // The scan doesn't read targets: the shallow value has placeholders.
        assert!(v.shallow().entries[0].data.is_empty());
        let entries = v.entries_views().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].align().unwrap(), 0x10);
        assert_eq!(entries[0].data().unwrap(), vec![1, 2, 3]);
        assert_eq!(entries[1].data().unwrap(), vec![4, 5]);
        assert_eq!(entries[1].span("data").unwrap().target, Some(0xc0));
        // Same-size edits patch in place.
        entries[0].set_handler(7).unwrap();
        entries[1].set_kind(1).unwrap();
        assert_eq!(entries[0].handler().unwrap(), 7);
        let patches = v.patches();
        assert_eq!(patches.len(), 2);
        assert_eq!(patches[0], yr::Patch { at: 0x80, remove: 2, insert: vec![7, 0] });
        let out = v.commit().unwrap();
        assert_eq!(out.len(), bytes.len());
        let full = arcv::Archive::parse(&out).unwrap();
        assert_eq!(full.entries[0].handler, 7);
        assert_eq!(full.entries[1].kind, 1);
        assert_eq!(v.parse().unwrap(), full);
        // The other handle sees the patch after a refresh.
        entries[1].refresh().unwrap();
        assert_eq!(entries[1].kind().unwrap(), 1);
    }

    #[test]
    fn chunk_views_follow_pointers_on_demand() {
        let bytes = unhex("${chunkHex}");
        let v = chunk::Chunk::view(bytes.clone()).unwrap();
        assert_eq!(v.pool().unwrap(), vec![${POOL.map(s => `"${s}".to_string()`).join(", ")}]);
        let recs = v.records_views().unwrap();
        assert_eq!(recs.len(), ${RECS.length});
        assert_eq!(*recs[0].name().unwrap(), "${RECS[0]!.name}");
        let model = recs[1].model_view().unwrap().expect("model");
        assert_eq!(model.data().unwrap(), vec![${RECS[1]!.model!.join(", ")}]);
        let curves = recs[0].curves_view().unwrap();
        let x = curves.x_view().unwrap();
        assert_eq!(x.n().unwrap(), ${RECS[0]!.xs.length});
        assert_eq!(*x.points().unwrap(), vec![${RECS[0]!.xs.map(v => `${v}f32`).join(", ")}]);
        assert_eq!(curves.a().unwrap(), ${RECS[0]!.a}f32);
        // Pointer arrays: views of each target.
        let ptrs = v.rec_ptrs_views().unwrap();
        assert_eq!(ptrs.len(), ${RECS.length});
        assert_eq!(ptrs[1].flags().unwrap(), ${RECS[1]!.flags});
        // Patch a record's flags and the curve's float in place.
        recs[1].set_flags(0x55).unwrap();
        curves.set_a(9.5).unwrap();
        let out = v.commit().unwrap();
        let full = chunk::Chunk::parse(&out).unwrap();
        assert_eq!(full.records[1].flags, 0x55);
        assert_eq!(full.records[0].curves.a, 9.5);
        assert_eq!(v.patches().len(), 2);
        // The rest of the file is untouched, and it still rebuilds byte for byte.
        assert_eq!(full.serialize().unwrap(), out);
    }

    #[test]
    fn replacing_targets_appends_them() {
        let bytes = unhex("${pf}");
        let v = arcv::Archive::view(bytes.clone()).unwrap();
        let entries = v.entries_views().unwrap();
        // A bigger target: appended at the end (0x10-aligned), offset and size patched in place.
        entries[0].replace_data(vec![0xab; 0x21]).unwrap();
        assert_eq!(entries[0].data().unwrap(), vec![0xab; 0x21]);
        assert_eq!(entries[0].size().unwrap(), 0x21);
        let off = entries[0].offset().unwrap() as usize;
        assert_eq!(off % 0x10, 0);
        assert!(off >= bytes.len());
        let out = v.commit().unwrap();
        assert_eq!(out.len(), off + 0x21);
        // Everything before the old end is unchanged except the entry's offset and size.
        let patches = v.patches();
        assert_eq!(patches.len(), 2);
        assert_eq!(patches[0].at, bytes.len());
        assert_eq!(patches[1].at, 0x80);
        let full = arcv::Archive::parse(&out).unwrap();
        assert_eq!(full.entries[0].data, vec![0xab; 0x21]);
        assert_eq!(full.entries[1].data, vec![4, 5]);
        // The root view still reads past the old end.
        assert_eq!(v.entries_views().unwrap()[0].data().unwrap().len(), 0x21);
    }

    #[test]
    fn replacing_pointer_targets() {
        let bytes = unhex("${chunkHex}");
        let v = chunk::Chunk::view(bytes.clone()).unwrap();
        let recs = v.records_views().unwrap();
        let model = std::rc::Rc::new(chunk::Model { n: 0, data: vec![1, 2, 3, 4, 5, 6], ..Default::default() });
        recs[0].replace_model(Some(model.clone())).unwrap();
        assert_eq!(recs[0].model_view().unwrap().unwrap().data().unwrap(), vec![1, 2, 3, 4, 5, 6]);
        let full = chunk::Chunk::parse(&v.commit().unwrap()).unwrap();
        assert_eq!(full.records[0].model.as_ref().unwrap().data, vec![1, 2, 3, 4, 5, 6]);
        assert_eq!(full.records[0].name.as_str(), "${RECS[0]!.name}");
        assert_eq!(full.records[1].model.as_ref().unwrap().data, vec![${RECS[1]!.model!.join(", ")}]);
        // Setting a nullable pointer to null.
        recs[1].replace_model(None).unwrap();
        let full = chunk::Chunk::parse(&v.commit().unwrap()).unwrap();
        assert!(full.records[1].model.is_none());
    }

    #[test]
    fn size_changes_are_rejected() {
        let mut b = vec![1u8];
        b.extend_from_slice(&[5, 0]);
        b.extend_from_slice(b"abc\\0\\0\\0");
        b.extend_from_slice(b"xy\\0");
        b.push(9);
        let v = misc::Doc::view(b.clone()).unwrap();
        let recs = v.recs_views().unwrap();
        assert_eq!(recs[0].name().unwrap(), "abc");
        assert_eq!(recs[0].al().unwrap(), 9);
        recs[0].set_name("abcdef".into()).unwrap();
        assert_eq!(recs[0].name().unwrap(), "abcdef");
        let e = recs[0].set_name("abcdefg".into()).unwrap_err();
        assert_eq!(e.code, yr::ErrorCode::Input);
        // A longer tag is a structural edit, which the in-place "ab" below replaces.
        recs[0].set_tag("longer".into()).unwrap();
        assert_eq!(recs[0].tag().unwrap(), "longer");
        recs[0].set_tag("ab".into()).unwrap();
        recs[0].set_al(3).unwrap();
        let out = v.commit().unwrap();
        let doc = misc::Doc::parse(&out).unwrap();
        assert_eq!(doc.recs[0].tag, "ab");
        assert_eq!(doc.recs[0].al, 3);
        assert_eq!(out.len(), b.len());
        // Structural edits are written by commit_with (here: shift what follows).
        recs[0].set_tag("longer".into()).unwrap();
        let out2 = v.commit_with(yr::Grow::Splice).unwrap();
        let doc2 = misc::Doc::parse(&out2).unwrap();
        assert_eq!(doc2.recs[0].tag, "longer");
        assert_eq!(doc2.recs[0].name, "abcdef");
        assert_eq!(v.materialize().unwrap(), doc2);
    }
}
`;

describe.skipIf(!hasRust)("rust views", () => {
  it("passes its Rust tests", async () => {
    const { bytes } = chunkBytes(POOL, RECS);
    const r = await testHarness({
      dir: scratch("yaffle_t_views"),
      crateName: "yaffle_t_views",
      modules: [
        { name: "arcv", program: arcv, views: true },
        { name: "chunk", program: chunk, views: true },
        { name: "misc", program: misc, views: true }
      ],
      tests: TESTS(archiveHex(), bytes.toString("hex"))
    });
    expect(r.ok, r.output.slice(0, 20000)).toBe(true);
    expect(r.passed).toBe(5);
    expect(r.output).not.toMatch(/warning/);
  }, 600_000);
});
