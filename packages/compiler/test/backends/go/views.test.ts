/** Go backend: lazy views, in-place patches, structural edits, commit policies. */
import { describe, expect, it } from "vitest";
import { compileOk, hasGo, mainGo, makeModule, run } from "./harness.ts";

const d = hasGo ? describe : describe.skip;

const PACKED = `
export struct Archive {
  @padUntil(0x10) {
    char tag[4] = "ARCV"
    u32  count
  }
  Entry entries[count]
}

export struct Entry {
  u16 handler
  u16 kind
  u32 align where it % 4 == 0
  u32 offset
  u32 size
  u8  data[size] at offset
  layout { data @align(0x10) }
}
`;

const SAMPLE = `
	sample := must(gen.SerializeArchive(&gen.Archive{Entries: []*gen.Entry{
		{Align: 4, Data: []byte{1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1}},
		{Kind: 1, Align: 8, Data: []byte{2, 2, 2, 2}},
		{Kind: 1, Align: 16, Data: []byte{3, 3, 3, 3, 3, 3, 3, 3}},
	}}, nil))
	js := func(v *gen.Archive) string { return string(must(gen.ArchiveToJSON(v))) }
	report := func(err error) {
		e, ok := yaffle.AsError(err)
		if !ok {
			fmt.Println("error:", err)
			return
		}
		fmt.Println(e.Code, yaffle.FormatPath(e.Path))
	}
	_ = report
	_ = js
`;

d("go views: reading", () => {
  it("reads fields lazily and agrees with Parse", async () => {
    const mod = makeModule("views-read", compileOk(PACKED), {
      files: {
        "main.go": mainGo(`${SAMPLE}
	v := must(gen.ViewArchive(sample, nil))
	fmt.Println(must(v.Count()), must(v.Tag()))
	es := must(v.EntriesViews())
	fmt.Println(len(es), must(es[1].Size()), must(es[1].Offset()), es[1].Node.Offset())
	fmt.Println(must(es[2].Data()))
	whole := must(v.Value())
	fmt.Println(js(whole) == js(must(gen.ParseArchive(sample, nil))))
	// A broken target only fails when it is read.
	bad := append([]byte{}, sample...)
	bad[0x28] = 0xf0 // entries[1].offset
	_, err := gen.ParseArchive(bad, nil)
	report(err)
	bv := must(gen.ViewArchive(bad, nil))
	be := must(bv.EntriesViews())
	fmt.Println(must(be[1].Size()), must(be[0].Data())[0])
	_, err = be[1].Data()
	report(err)
`)
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    expect(lines).toEqual([
      "3 ARCV",
      "3 4 96 32",
      "[3 3 3 3 3 3 3 3]",
      "true",
      "EOF entries[1].data",
      "4 1",
      "EOF entries[1].data"
    ]);
  });
});

d("go views: edits", () => {
  it("patches same-size scalars in place", async () => {
    const mod = makeModule("views-inplace", compileOk(PACKED), {
      files: {
        "main.go": mainGo(`${SAMPLE}
	v := must(gen.ViewArchive(sample, nil))
	es := must(v.EntriesViews())
	if err := es[1].SetAlign(0x200); err != nil {
		panic(err)
	}
	fmt.Println(must(es[1].Align()))
	ps := must(v.Patches(yaffle.CommitOptions{}))
	for _, p := range ps {
		fmt.Printf("%d %d %x\\n", p.At, p.Remove, p.Insert)
	}
	report(es[1].SetAlign(3))
	out := must(v.Commit(yaffle.CommitOptions{}))
	p := must(gen.ParseArchive(out, nil))
	fmt.Println(len(out) == len(sample), p.Entries[1].Align, p.Entries[0].Align)
	// After a commit the root view reads the new bytes.
	es2 := must(v.EntriesViews())
	fmt.Println(must(es2[1].Align()))
`)
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    expect(lines).toEqual(["512", "36 4 00020000", "CHECK entries[1].align", "true 512 4", "512"]);
  });

  it("commits structural edits with a sticky layout (default, splice, error)", async () => {
    const mod = makeModule("views-structural", compileOk(PACKED), {
      files: {
        "main.go": mainGo(`${SAMPLE}
	grow := func(policy string) {
		v := must(gen.ViewArchive(sample, nil))
		es := must(v.EntriesViews())
		if err := es[1].SetData([]byte{9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9}); err != nil {
			panic(err)
		}
		out, err := v.Commit(yaffle.CommitOptions{Grow: policy})
		if err != nil {
			report(err)
			return
		}
		p := must(gen.ParseArchive(out, nil))
		fmt.Println(policy, len(out), p.Entries[0].Offset, p.Entries[1].Offset, p.Entries[2].Offset, p.Entries[1].Data[0], p.Entries[2].Data[0])
	}
	fmt.Println(len(sample))
	grow("")
	grow("splice")
	grow("error")
	// Replacing a whole array through its setter.
	v := must(gen.ViewArchive(sample, nil))
	es := must(v.Entries())
	es = append(es, &gen.Entry{Kind: 2, Align: 4, Data: []byte{7}})
	if err := v.SetEntries(es); err != nil {
		panic(err)
	}
	out := must(v.Commit(yaffle.CommitOptions{}))
	p := must(gen.ParseArchive(out, nil))
	fmt.Println(p.Count, p.Entries[3].Data, p.Entries[0].Offset)
`)
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    // header 0x10 + 3 * 16 = 0x40 inline; data at 0x40 (20 bytes), 0x60 (4), 0x70 (8): 0x78 total.
    expect(lines[0]).toBe("120");
    expect(lines[1]).toBe(" 140 64 128 112 9 3"); // the grown target moves to the end
    expect(lines[2]).toBe("splice 120 64 96 112 9 3"); // what follows shifts (here: into the gap)
    expect(lines[3]).toBe("DERIVE ");
    expect(lines[4]).toMatch(/^4 \[7\] /);
  });

  it("lays targets out again when a field a layout item reads changes", async () => {
    const src = `
export struct A { u8 align  u8 n  u8 o  u8 d[n] at o  layout { d @align(align) } }

struct V { u8 n  u8 po  u8 qo  u8 p[n] at po  u8 q[n] at qo }
export struct Grp { u8 a  u8 c  V vs[c]  layout { vs[*] { q @align(a)  p @align(a * 2) } } }
`;
    const mod = makeModule("views-b12", compileOk(src), {
      files: {
        "main.go": mainGo(`
	show := func(b []byte, err error) {
		if e, ok := yaffle.AsError(err); ok {
			fmt.Println(e.Code)
			return
		}
		fmt.Printf("%x\\n", b)
	}
	data := must(gen.SerializeA(&gen.A{Align: 4, D: []byte{0xaa}}, nil))
	for _, a := range []uint8{2, 8, 0} {
		v := must(gen.ViewA(data, nil))
		if err := v.SetAlign(a); err != nil {
			panic(err)
		}
		show(v.Commit(yaffle.CommitOptions{}))
	}
	g := must(gen.SerializeGrp(&gen.Grp{A: 2, Vs: []*gen.V{{P: []byte{1}, Q: []byte{2}}, {P: []byte{3}, Q: []byte{4}}}}, nil))
	for _, policy := range []string{"", "splice"} {
		v := must(gen.ViewGrp(g, nil))
		if err := v.SetA(4); err != nil {
			panic(err)
		}
		show(v.Commit(yaffle.CommitOptions{Grow: policy}))
	}
	show(gen.SerializeGrp(&gen.Grp{A: 4, Vs: []*gen.V{{P: []byte{1}, Q: []byte{2}}, {P: []byte{3}, Q: []byte{4}}}}, nil))
`)
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    expect(lines).toEqual([
      "02010400aa", // still aligned: the data stays
      "0801080000000000aa", // no longer aligned: it moves
      "RANGE",
      // sticky: q0 (8) and p1 (16) still meet the new alignments, p0 and q1 move to the end
      "040201180801101c020000000000000003000000000000000100000004",
      // splice lays everything out again, like a serialize
      "04020110080118140200000000000000010000000400000003",
      "04020110080118140200000000000000010000000400000003"
    ]);
  });

  it("recomputes checksums over edited children", async () => {
    const src = `
struct Body { u8 a  u8 b }
export struct Crc { u32 crc = crc32(body)  Body body }
`;
    const mod = makeModule("views-crc", compileOk(src), {
      files: {
        "main.go": mainGo(`
	data := must(gen.SerializeCrc(&gen.Crc{Body: &gen.Body{A: 1, B: 2}}, nil))
	v := must(gen.ViewCrc(data, nil))
	b := must(v.BodyView())
	if err := b.SetA(5); err != nil {
		panic(err)
	}
	out := must(v.Commit(yaffle.CommitOptions{}))
	want := must(gen.SerializeCrc(&gen.Crc{Body: &gen.Body{A: 5, B: 2}}, nil))
	fmt.Printf("%x %v\\n", out, string(out) == string(want))
`)
      }
    });
    const out = (await run(mod)).trim();
    expect(out).toMatch(/^[0-9a-f]{8}0502 true$/);
  });

  it("opens views of pointer targets", async () => {
    const src = `
struct Node {
  u8    v
  Node *next : u8 @nullable
}
export struct List { u8 n  Node *first : u8 }
`;
    const mod = makeModule("views-pointers", compileOk(src), {
      files: {
        "main.go": mainGo(`
	data := []byte{7, 2, 1, 4, 2, 0}
	l := must(gen.ViewList(data, nil))
	first := must(l.FirstView())
	second := must(first.NextView())
	fmt.Println(must(first.V()), must(second.V()), must(second.NextView()) == nil)
	if err := second.SetV(9); err != nil {
		panic(err)
	}
	fmt.Printf("%x\\n", must(l.Commit(yaffle.CommitOptions{})))
`)
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    expect(lines).toEqual(["1 2 true", "070201040900"]);
  });
});

d("go views: codec regions", () => {
  it("decodes a codec region only when it is read", async () => {
    const src = `
extern codec counted

struct Body { u8 a  u8 b }

export struct Packed {
  u8   version
  u8   n
  Body body @via(counted) @size(n)
  u8   tail
}
`;
    const ext = `package ext

import "yaffle.dev/yaffle"

// Decodes counts Decode calls.
var Decodes int

type counted struct{}

func (counted) Decode(in []byte, _ *yaffle.CodecCtx) ([]byte, error) {
	Decodes++
	out := make([]byte, len(in))
	for i, b := range in {
		out[i] = b ^ 0xff
	}
	return out, nil
}

func (c counted) Encode(in []byte, ctx *yaffle.CodecCtx) ([]byte, error) {
	out := make([]byte, len(in))
	for i, b := range in {
		out[i] = b ^ 0xff
	}
	return out, nil
}

// Counted is the host implementation.
var Counted yaffle.Codec = counted{}
`;
    const mod = makeModule("views-codec", compileOk(src), {
      externs: { counted: "yafflecase/ext.Counted" },
      files: {
        "ext/ext.go": ext,
        "main.go": mainGo(
          `
	data := []byte{1, 2, 0xfe, 0xfd, 9}
	v := must(gen.ViewPacked(data, nil))
	fmt.Println(must(v.Version()), must(v.Tail()), ext.Decodes)
	b := must(v.Body())
	fmt.Println(b.A, b.B, ext.Decodes)
	if err := v.SetTail(7); err != nil {
		panic(err)
	}
	fmt.Printf("%x\\n", must(v.Commit(yaffle.CommitOptions{})))
	if err := v.SetBody(&gen.Body{A: 5, B: 6}); err != nil {
		panic(err)
	}
	fmt.Printf("%x\\n", must(v.Commit(yaffle.CommitOptions{})))
`,
          ["yafflecase/ext"]
        )
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    expect(lines).toEqual(["1 9 0", "1 2 1", "0102fefd07", "0102faf907"]);
  });
});
