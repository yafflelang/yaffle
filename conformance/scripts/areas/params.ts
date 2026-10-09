/** Cases for conformance/cases/params. */
import { area, parse, parseOnly, perr, ser, serr, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

add(
  parse("positional and named arguments", "Uses", "aabb ccddee", {
    a: { data: "aabb" },
    b: { data: "ccddee" }
  }),
  ser("arguments on write", "Uses", { a: { data: "0102" }, b: { data: "030405" } }, "0102 030405"),
  serr(
    "argument-sized array with the wrong length",
    "Uses",
    { a: { data: "01" }, b: { data: "030405" } },
    "DERIVE",
    ["a", "data"]
  ),
  perr("argument-sized array eof", "Uses", "aabb cc", "EOF", ["b", "data"]),
  parse("struct-typed parameter", "WithHeader", "02 00 aabb", {
    h: { size: 2, kind: 0 },
    body: { x: "aabb" }
  }),
  parse("struct-typed parameter in a condition", "WithHeader", "01 01 aa 0300", {
    h: { size: 1, kind: 1 },
    body: { x: "aa", extra: 3 }
  }),
  ser(
    "struct-typed parameter on write",
    "WithHeader",
    { h: { size: 1, kind: 0 }, body: { x: "ff" } },
    "01 00 ff"
  ),
  serr(
    "struct-typed parameter disagrees with the array",
    "WithHeader",
    { h: { size: 3, kind: 0 }, body: { x: "ff" } },
    "DERIVE",
    ["body", "x"]
  ),
  parse("root parameter", "RootParam", "010203", { data: "010203" }, { args: { n: 3 } }),
  parse("root parameter zero", "RootParam", "", { data: "" }, { args: { n: 0 } }),
  ser("root parameter on write", "RootParam", { data: "0a0b" }, "0a0b", { args: { n: 2 } }),
  serr("root parameter disagrees on write", "RootParam", { data: "0a0b" }, "DERIVE", ["data"], {
    args: { n: 3 }
  })
);

add(
  parse("bound value read deep inside", "Bound", "02 07 09", {
    version: 2,
    m: { leaf: { extra: 7, v: 9 } }
  }),
  parse("bound value condition false", "Bound", "01 09", { version: 1, m: { leaf: { v: 9 } } }),
  ser("bound value on write", "Bound", { version: 3, m: { leaf: { extra: 1, v: 2 } } }, "03 01 02"),
  parse("nearest binding wins", "Shadow", "01 02 07 08 09", {
    version: 1,
    i: { version: 2, l: { extra: 7, v: 8 } },
    outer: { v: 9 }
  }),
  parse("nearest binding wins the other way", "Shadow", "02 01 08 07 09", {
    version: 2,
    i: { version: 1, l: { v: 8 } },
    outer: { extra: 7, v: 9 }
  }),
  parse(
    "bound root parameter",
    "RootBound",
    "07 08",
    { l: { extra: 7, v: 8 } },
    { args: { version: 2 } }
  ),
  parse("bound root parameter false", "RootBound", "08", { l: { v: 8 } }, { args: { version: 1 } }),
  ser("bound root parameter on write", "RootBound", { l: { extra: 1, v: 2 } }, "01 02", {
    args: { version: 5 }
  })
);

add(
  parse("lexical outer field", "Lexical", "02 03 aabb ccdd eeff", {
    n: 2,
    count: 3,
    items: [{ vals: "aabb" }, { vals: "ccdd" }, { vals: "eeff" }]
  }),
  ser(
    "lexical outer field on write",
    "Lexical",
    { n: 1, items: [{ vals: "01" }, { vals: "02" }] },
    "01 02 01 02"
  ),
  serr("lexical outer field disagrees", "Lexical", { n: 2, items: [{ vals: "01" }] }, "DERIVE", [
    "items",
    0,
    "vals"
  ]),
  parseOnly("offset and end", "Offsets", "05 aa bbcc 07", { a: 5, b: "aa", rest: "bbcc", last: 7 }),
  parseOnly("offset and end with nothing in between", "Offsets", "05 aa 07", {
    a: 5,
    b: "aa",
    rest: "",
    last: 7
  }),
  perr("end minus offset negative", "Offsets", "05 aa", "RANGE", ["rest"]),
  ser("offset-sized array on write", "OffsetSized", { a: 1, b: "ff", c: 2 }, "01 ff 02"),
  serr("offset-sized array disagrees", "OffsetSized", { a: 1, b: "ffff", c: 2 }, "DERIVE", ["b"]),
  parse("offset-sized array parse", "OffsetSized", "01 ff 02", { a: 1, b: "ff", c: 2 }),
  parse("index", "Indexed", "00 01 00 02 0000", {
    cells: [
      { idx: 0, pad: "" },
      { idx: 1, pad: "00" },
      { idx: 2, pad: "0000" }
    ]
  }),
  perr("index check fails", "Indexed", "00 02 00 02 0000", "CHECK", ["cells", 1, "idx"]),
  ser(
    "index on write",
    "Indexed",
    {
      cells: [
        { idx: 0, pad: "" },
        { idx: 1, pad: "ff" },
        { idx: 2, pad: "eeee" }
      ]
    },
    "00 01 ff 02 eeee"
  ),
  serr(
    "index-sized array disagrees",
    "Indexed",
    {
      cells: [
        { idx: 0, pad: "00" },
        { idx: 1, pad: "ff" },
        { idx: 2, pad: "eeee" }
      ]
    },
    "DERIVE",
    ["cells", 0, "pad"]
  ),
  parse("offset inside a base counts from the base", "OffsetInBase", "09 01 ee", {
    pre: 9,
    b: { a: 1, skip: "ee" }
  }),
  ser(
    "offset inside a base on write",
    "OffsetInBase",
    { pre: 9, b: { a: 1, skip: "ee" } },
    "09 01 ee"
  )
);

add(
  parse("bound value read by every element", "BoundArray", "02 aabb ccdd", {
    k: 2,
    es: [{ data: "aabb" }, { data: "ccdd" }]
  }),
  ser(
    "bound value read by every element on write",
    "BoundArray",
    { k: 1, es: [{ data: "01" }, { data: "02" }] },
    "01 01 02"
  ),
  serr(
    "bound value disagrees with an element",
    "BoundArray",
    { k: 2, es: [{ data: "aa" }, { data: "ccdd" }] },
    "DERIVE"
  )
);

export default area(
  "params",
  "Positional/named/struct parameters, root parameters, lexical nesting, $bound values and shadowing, $offset/$end/$index.",
  cases
);
