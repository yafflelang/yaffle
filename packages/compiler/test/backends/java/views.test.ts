/** Java views (tier 2): lazy reads, in-place patches, structural edits, commit policies. */
import { describeJava } from "./harness.ts";

/** An archive: a 0x80-byte header, a table of 0x18-byte entries, then each entry's aligned data. */
const archive = `
export struct Archive {
  @strict @padUntil(0x80) {
    char tag[4] = "ARCV"
    u32  count                    // written as entries.length
  }
  Entry entries[count]
}

export struct Entry {
  u16 handler
  u16 kind
  u32 align                       // alignment of the data, a power of two
  u64 offset                      // written as the position of \`data\`
  u32 size                        // written as data.length
      @padAfter(4) @strict
  u8  data[size] at offset
  layout { data @align(align) }   // aligned to the entry's own field
}
`;

const helpers = `
  static Entry entry(int kind, int n, int fill) {
    Entry e = new Entry();
    e.handler = 0;
    e.kind = kind;
    e.align = 0x100;
    byte[] d = new byte[n];
    java.util.Arrays.fill(d, (byte) fill);
    e.data = d;
    return e;
  }
  static byte[] sample() {
    Archive pf = new Archive();
    pf.entries = new java.util.ArrayList<>();
    pf.entries.add(entry(0, 0x180, 1));
    pf.entries.add(entry(1, 0x40, 2));
    pf.entries.add(entry(1, 0x100, 3));
    pf.entries.add(entry(1, 0, 0));
    return Archive.serialize(pf);
  }
  static java.util.List<Long> offsets(byte[] b) {
    java.util.List<Long> out = new java.util.ArrayList<>();
    for (Entry e : Archive.parse(b).entries) out.add(e.offset);
    return out;
  }
  static String patches(java.util.List<org.yafflelang.runtime.Patch> ps) {
    StringBuilder sb = new StringBuilder();
    for (org.yafflelang.runtime.Patch p : ps) sb.append("[").append(Integer.toHexString(p.at())).append(",").append(p.remove()).append(",").append(p.insert().length).append("]");
    return sb.toString();
  }
`;

const tests: Record<string, string> = {
  "reads fields lazily and equals the parse result": `
    byte[] bytes = sample();
    Archive.View v = Archive.view(bytes);
    eq(4L, v.getCount());
    eq("ARCV", v.getTag());
    eq(4, v.getEntries().size());
    eq(0x40L, v.getEntries().get(1).getSize());
    eq(0x300L, v.getEntries().get(1).getOffset());
    eq(3, v.getEntries().get(2).getData()[0] & 0xff);
    eq(org.yafflelang.runtime.Json.write(Archive.toJson(Archive.parse(bytes))), org.yafflelang.runtime.Json.write(Archive.toJson(v.toValue())));
    eq(0x80, v.getEntries().get(0).offset());
    eq(0x18, v.getEntries().get(1).size());
    java.util.List<Long> sizes = new java.util.ArrayList<>();
    for (Entry.View e : v.getEntries()) sizes.add(e.getSize());
    eq(java.util.List.of(0x180L, 0x40L, 0x100L, 0L), sizes);
  `,
  "errors carry the path of the field being read": `
    byte[] bad = sample();
    bad[0x80 + 0x18 + 0x14] = 7; // padding after entry 1's size (strict)
    Archive.View v = Archive.view(bad);
    eq(0x180L, v.getEntries().get(0).getSize());
    org.yafflelang.runtime.YaffleException e = fails("CHECK", () -> v.getEntries().get(1).getSize());
    path("[\\"entries\\",1,\\"size\\"]", e);
  `,
  "same-size scalar edits are patched in place": `
    byte[] bytes = sample();
    Archive.View v = Archive.view(bytes);
    v.getEntries().get(2).setHandler(0x200);
    v.getEntries().get(0).setKind(7);
    eq(0x200, v.getEntries().get(2).getHandler());
    eq("[82,2,2][b0,2,2]", patches(v.patches()));
    byte[] out = v.commit();
    check(out != bytes, "a new array");
    eq(hex(sample()), hex(bytes));
    Archive p = Archive.parse(out);
    eq(0x200, p.entries.get(2).handler);
    eq(7, p.entries.get(0).kind);
    eq(bytes.length, out.length);
    // the view is rebound to the committed bytes
    eq(0x200, v.getEntries().get(2).getHandler());
    check(v.patches().isEmpty(), "no patches after commit");
  `,
  "rejects bad values with the field's path": `
    Archive.View v = Archive.view(sample());
    org.yafflelang.runtime.YaffleException e = fails("RANGE", () -> v.getEntries().get(0).setAlign(1L << 32));
    path("[\\"entries\\",0,\\"align\\"]", e);
  `,
  "push: the table grows into padding, existing data stays, new data is appended": `
    byte[] bytes = sample();
    Archive.View v = Archive.view(bytes);
    v.getEntries().add(Entry.View.of(entry(1, 3, 9)));
    eq(5, v.getEntries().size());
    byte[] out = v.commit();
    Archive p = Archive.parse(out);
    eq(5L, p.count);
    eq(java.util.List.of(0x100L, 0x300L, 0x400L, 0x500L, 0x500L), offsets(out));
    eq(hex(new byte[] {9, 9, 9}), hex(p.entries.get(4).data));
    eq(hex(java.util.Arrays.copyOfRange(bytes, 0x100, 0x500)), hex(java.util.Arrays.copyOfRange(out, 0x100, 0x500)));
  `,
  "growing a target appends it by default; splice shifts what follows; error rejects": `
    byte[] bytes = sample();
    Archive.View v = Archive.view(bytes);
    byte[] d = new byte[0x50];
    java.util.Arrays.fill(d, (byte) 8);
    v.getEntries().get(1).setData(d);
    byte[] out = org.yafflelang.runtime.Patch.apply(bytes, v.patches());
    Archive p = Archive.parse(out);
    eq(0x500L, p.entries.get(1).offset);
    eq(0x400L, p.entries.get(2).offset);
    eq(8, p.entries.get(1).data[1]);

    Archive.View v2 = Archive.view(bytes);
    v2.getEntries().get(1).setData(new byte[0x150]);
    byte[] out2 = v2.commit(org.yafflelang.runtime.Layout.Grow.SPLICE);
    eq(java.util.List.of(0x100L, 0x300L, 0x500L, 0x600L), offsets(out2));

    Archive.View v3 = Archive.view(bytes);
    v3.getEntries().get(1).setData(new byte[0x150]);
    fails("DERIVE", () -> v3.commit(org.yafflelang.runtime.Layout.Grow.ERROR));
  `,
  "removing elements": `
    Archive.View v = Archive.view(sample());
    v.getEntries().remove(1);
    Archive p = Archive.parse(v.commit());
    eq(3L, p.count);
    eq(0x180L, p.entries.get(0).size);
    eq(0x100L, p.entries.get(1).size);
    eq(0L, p.entries.get(2).size);
  `,
  "setters on struct views and replacing a whole element": `
    Archive.View v = Archive.view(sample());
    v.getEntries().get(0).setHandler(3).setKind(4);
    Entry n = entry(1, 2, 1);
    n.handler = 1;
    n.align = 0x10;
    v.getEntries().set(3, Entry.View.of(n));
    Archive p = Archive.parse(v.commit());
    eq(3, p.entries.get(0).handler);
    eq(4, p.entries.get(0).kind);
    eq(1, p.entries.get(3).handler);
    eq(0x10L, p.entries.get(3).align);
    eq(2L, p.entries.get(3).size);
  `,
  "edits of a detached view show in its plain value": `
    Entry.View d = Entry.View.of(entry(1, 4, 5));
    d.setKind(9);
    eq(9, d.getKind());
    eq(9, d.toValue().kind);
    eq(4, d.getData().length);
  `
};

describeJava("java views", "views", { "archive.yfl": archive }, tests, { helpers });
