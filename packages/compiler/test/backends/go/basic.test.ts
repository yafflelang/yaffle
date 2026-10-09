/** Go backend: generated API end to end (compile yaffle → generate Go → build → run). */
import { describe, expect, it } from "vitest";
import { compileOk, hasGo, mainGo, makeModule, run, vet } from "./harness.ts";

const d = hasGo ? describe : describe.skip;

const TABLE = `
enum Kind : u16 { Sys = 0, Gpu = 1 }

struct Entry {
  Kind kind
  u16  flags
  u32  size
  if (flags != 0) { u8 extra }
  u8   data[size]
}

export struct Table {
  char tag[4] = "TABL"
  u8   count
  Entry entries[count]
  str  name
}
`;

d("go: structs, enums, conditionals", () => {
  it("parses, edits, serializes and converts to and from JSON", async () => {
    const mod = makeModule("basic-table", compileOk(TABLE), {
      files: {
        "main.go": mainGo(`
	data := []byte("TABL\\x02" + "\\x01\\x00\\x00\\x00\\x02\\x00\\x00\\x00\\xaa\\xbb" + "\\x00\\x00\\x01\\x00\\x01\\x00\\x00\\x00\\x07\\xcc" + "hi\\x00")
	t := must(gen.ParseTable(data, nil))
	fmt.Println(t.Count, len(t.Entries), t.Entries[0].Kind, t.Entries[0].Kind == gen.KindGpu, t.Name)
	fmt.Println(t.Entries[0].Extra == nil, *t.Entries[1].Extra)
	j := must(gen.TableToJSON(t))
	fmt.Println(string(j))
	back := must(gen.TableFromJSON(j))
	out := must(gen.SerializeTable(back, nil))
	fmt.Println(string(out) == string(data))
	t.Entries = append(t.Entries, &gen.Entry{Kind: gen.KindSys, Data: []byte{1, 2, 3}})
	t.Name = "longer"
	out = must(gen.SerializeTable(t, nil))
	fmt.Printf("%x\\n", out)
`)
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    expect(lines[0]).toBe("2 2 Gpu true hi");
    expect(lines[1]).toBe("true 7");
    expect(JSON.parse(lines[2]!)).toEqual({
      tag: "TABL",
      count: 2,
      entries: [
        { kind: "Gpu", flags: 0, size: 2, data: "aabb" },
        { kind: "Sys", flags: 1, size: 1, extra: 7, data: "cc" }
      ],
      name: "hi"
    });
    expect(lines[3]).toBe("true");
    expect(lines[4]).toBe(
      "5441424c03" +
        "0100000002000000aabb" +
        "0000010001000000" +
        "07cc" +
        "0000000003000000010203" +
        "6c6f6e67657200"
    );
    expect(await vet(mod)).toBe("");
  });

  it("reports errors with code, path and offset", async () => {
    const mod = makeModule("basic-errors", compileOk(TABLE), {
      files: {
        "main.go": mainGo(`
	report := func(err error) {
		e, ok := yaffle.AsError(err)
		if !ok {
			fmt.Println("no yaffle error:", err)
			return
		}
		fmt.Println(e.Code, yaffle.FormatPath(e.Path), e.Offset)
	}
	_, err := gen.ParseTable([]byte("TABL\\x02\\x01\\x00\\x00\\x00\\x02\\x00\\x00\\x00\\xaa"), nil)
	report(err)
	_, err = gen.ParseTable([]byte("XXXX\\x00a\\x00"), nil)
	report(err)
	_, err = gen.ParseTable([]byte("TABL\\x01\\x05\\x00\\x00\\x00\\x00\\x00\\x00\\x00"), nil)
	report(err)
	_, err = gen.SerializeTable(&gen.Table{Entries: []*gen.Entry{{Flags: 1}}}, nil)
	report(err)
	_, err = gen.TableFromJSON([]byte(\`{"entries": [{"kind": "Nope", "flags": 0, "data": ""}], "name": ""}\`))
	report(err)
	_, err = gen.TableFromJSON([]byte(\`{"entries": [], "name": 3}\`))
	report(err)
`)
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    expect(lines).toEqual([
      "EOF entries[0].data 13",
      "CHECK tag 0",
      "CHECK entries[0].kind 5",
      "INPUT entries[0].extra -1",
      "INPUT entries[0].kind -1",
      "INPUT name -1"
    ]);
  });
});

d("go: pointers and identity", () => {
  it("shares targets, follows cycles and writes $refs", async () => {
    const src = `
struct Node {
  u8    v
  Node *next : u8 @nullable
}
export struct List { Node *first : u8  Node *again : u8 }
`;
    const mod = makeModule("basic-pointers", compileOk(src), {
      files: {
        "main.go": mainGo(`
	// first -> node at 2 (v=1, next=4); node at 4 (v=2, next=2): a cycle; again -> node at 4
	l := must(gen.ParseList([]byte{2, 4, 1, 4, 2, 2}, nil))
	fmt.Println(l.First.Next.Next == l.First, l.Again == l.First.Next)
	fmt.Println(string(must(gen.ListToJSON(l))))
	n := &gen.Node{V: 9}
	n.Next = n
	fmt.Printf("%x\\n", must(gen.SerializeList(&gen.List{First: n, Again: n}, nil)))
`)
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    expect(lines[0]).toBe("true true");
    expect(JSON.parse(lines[1]!)).toEqual({
      first: { v: 1, next: { v: 2, next: { $ref: "/first" } } },
      again: { $ref: "/first/next" }
    });
    expect(lines[2]).toBe("0202" + "0902");
  });
});

d("go: names", () => {
  it("keeps Go keywords, builtins and generated locals apart from user names", async () => {
    const src = `
struct String(u8 len) {
  u8  type
  u8  r
  u8  v[len]
  u8  fr
}
export struct Error {
  u8 len
  u8 x16
  String(len) range
  u8 _private @hidden = 0
}
`;
    const mod = makeModule("basic-names", compileOk(src), {
      files: {
        "main.go": mainGo(`
	e := must(gen.ParseError([]byte{2, 5, 1, 2, 3, 4, 6, 0}, nil))
	fmt.Println(e.Len, e.X16, e.Range.Type, e.Range.R, e.Range.V, e.Range.Fr)
	fmt.Printf("%x\\n", must(gen.SerializeError(e, nil)))
`)
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    expect(lines[0]).toBe("2 5 1 2 [3 4] 6");
    expect(lines[1]).toBe("0205010203040600");
    expect(await vet(mod)).toBe("");
  });
});

d("go: options", () => {
  it("passes root parameters, endian and strict through the options struct", async () => {
    const src = `
export struct Blob(u8 n, u32 $tag) {
  u16 v
  u8  data[n]
  if ($tag > 1) { u8 extra }
  u8  pad @padAfter(1) @strict
}
`;
    const mod = makeModule("basic-options", compileOk(src), {
      files: {
        "main.go": mainGo(`
	b := must(gen.ParseBlob([]byte{1, 2, 9, 8, 7, 5, 0}, &gen.BlobOptions{N: 2, Tag: 2, Endian: yaffle.BE}))
	fmt.Println(b.V, b.Data, *b.Extra, b.Pad)
	_, err := gen.ParseBlob([]byte{1, 2, 9, 8, 7, 5, 1}, &gen.BlobOptions{N: 2, Tag: 2, Strict: true})
	e, _ := yaffle.AsError(err)
	fmt.Println(e.Code, yaffle.FormatPath(e.Path))
	o := must(gen.BlobOptionsFromJSON([]byte(\`{"n": 2, "tag": 1, "endian": "be"}\`)))
	b2 := must(gen.ParseBlob([]byte{1, 2, 9, 8, 5, 0}, o))
	fmt.Println(b2.V, b2.Extra == nil)
`)
      }
    });
    const lines = (await run(mod)).trim().split("\n");
    expect(lines).toEqual(["258 [9 8] 7 5", "CHECK pad", "258 true"]);
  });
});

d("go: checksums", () => {
  it("computes content fixups after arrays and in nested structs", async () => {
    const src = `
struct Inner { u16 xs[2]  u16 ys[2]  u32 crc = crc32(ys) }
export struct Sums {
  u16   a[2]
  u16   b[2]
  Inner inner
  u32   crc = crc32(b)
  u32   all = adler32(encode(inner))
}
`;
    const mod = makeModule("basic-crc", compileOk(src), {
      files: {
        "main.go": mainGo(
          `
	out := must(gen.SerializeSums(&gen.Sums{A: []uint16{1, 2}, B: []uint16{3, 4}, Inner: &gen.Inner{Xs: []uint16{5, 6}, Ys: []uint16{7, 8}}}, nil))
	le := binary.LittleEndian
	fmt.Println(le.Uint32(out[16:]) == crc32.ChecksumIEEE(out[12:16]))
	fmt.Println(le.Uint32(out[20:]) == crc32.ChecksumIEEE(out[4:8]))
	fmt.Println(le.Uint32(out[24:]) == adler32.Checksum(out[8:20]), len(out))
`,
          ["encoding/binary", "hash/adler32", "hash/crc32"]
        )
      }
    });
    expect((await run(mod)).trim().split("\n")).toEqual(["true", "true", "true 28"]);
  });
});
