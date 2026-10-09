/**
 * Java views read only what they need: `from` streams decode only the pieces a read touches,
 * `@ranged` codec regions decode only the blocks a read touches, random-access sources load only
 * the blocks a read touches, and async views complete accesses as futures.
 */
import { describeJava } from "./harness.ts";

const schema = `
extern codec cnt               // identity, counting decodes
extern codec rx(u8 key) @ranged // xor, recording the positions it decodes

struct Frag {
  u32 exp
  u32 comp
  u8  data[] @size(exp) @via(cnt) @size(comp) @hidden
}

struct Body {
  u32 a
  u8  pad[0x2fff8]
  u32 b
}

export struct Pieces {
  u32  n
  Frag frags[n]
  Body body from frags[*].data
}

struct Big {
  u8  head[0x40000]
  u32 tail
}

export struct Ranged {
  u32 len
  Big big @via(rx(0x5a)) @size(len)
}

struct Entry {
  u32 ofs
  u32 size
  u8  data[size] at ofs
}

export struct Table {
  u32   n
  Entry entries[n]
}
`;

const helpers = `
  static int decodes;
  static final java.util.List<Long> positions = new java.util.ArrayList<>();
  static final java.util.List<Long> reads = new java.util.ArrayList<>();

  public static final dev.yaffle.runtime.Codec CNT = new dev.yaffle.runtime.Codec() {
    @Override public byte[] decode(byte[] in, dev.yaffle.runtime.CodecCtx ctx) { decodes++; return in.clone(); }
    @Override public byte[] encode(byte[] in, dev.yaffle.runtime.CodecCtx ctx) { return in.clone(); }
  };

  public static final dev.yaffle.runtime.Codec RX = new dev.yaffle.runtime.Codec() {
    byte[] x(byte[] in, dev.yaffle.runtime.CodecCtx ctx) {
      byte[] o = new byte[in.length];
      for (int i = 0; i < in.length; i++) o[i] = (byte) (in[i] ^ (int) ctx.longArg(0));
      return o;
    }
    @Override public byte[] decode(byte[] in, dev.yaffle.runtime.CodecCtx ctx) { positions.add(ctx.position()); return x(in, ctx); }
    @Override public byte[] encode(byte[] in, dev.yaffle.runtime.CodecCtx ctx) { return x(in, ctx); }
  };

  static void u32(java.io.ByteArrayOutputStream o, long v) {
    for (int i = 0; i < 4; i++) o.write((int) (v >>> (8 * i)));
  }

  /** Pieces of 0x10000 bytes each: the body's a = 0x11111111 and b = 0x22222222. */
  static byte[] pieces() {
    byte[] body = new byte[0x30000];
    java.nio.ByteBuffer.wrap(body).order(java.nio.ByteOrder.LITTLE_ENDIAN).putInt(0, 0x11111111).putInt(0x2fffc, 0x22222222);
    for (int i = 4; i < 0x2fffc; i++) body[i] = (byte) i;
    java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
    u32(o, 3);
    for (int k = 0; k < 3; k++) {
      u32(o, 0x10000);
      u32(o, 0x10000);
      o.write(body, k * 0x10000, 0x10000);
    }
    return o.toByteArray();
  }

  static byte[] ranged() {
    byte[] plain = new byte[0x40004];
    for (int i = 0; i < plain.length; i++) plain[i] = (byte) (i * 7);
    java.nio.ByteBuffer.wrap(plain).order(java.nio.ByteOrder.LITTLE_ENDIAN).putInt(0x40000, 0x0badf00d);
    java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
    u32(o, plain.length);
    for (byte b : plain) o.write(b ^ 0x5a);
    return o.toByteArray();
  }

  static Table table() {
    Table t = new Table();
    t.entries = new java.util.ArrayList<>();
    for (int k = 0; k < 4; k++) {
      Entry e = new Entry();
      e.data = new byte[0x20000];
      java.util.Arrays.fill(e.data, (byte) (k + 1));
      t.entries.add(e);
    }
    return t;
  }

  static dev.yaffle.runtime.Source counting(byte[] b) {
    return new dev.yaffle.runtime.Source() {
      @Override public long size() { return b.length; }
      @Override public byte[] read(long off, int len) { reads.add(off); return java.util.Arrays.copyOfRange(b, (int) off, (int) off + len); }
    };
  }

  static dev.yaffle.runtime.AsyncSource countingAsync(byte[] b) {
    return new dev.yaffle.runtime.AsyncSource() {
      @Override public long size() { return b.length; }
      @Override public java.util.concurrent.CompletableFuture<byte[]> read(long off, int len) {
        reads.add(off);
        return java.util.concurrent.CompletableFuture.supplyAsync(() -> java.util.Arrays.copyOfRange(b, (int) off, (int) off + len));
      }
    };
  }
`;

const tests: Record<string, string> = {
  "a stream decodes only the pieces a read touches": `
    decodes = 0;
    Pieces.View v = Pieces.view(pieces());
    eq(3, v.getFrags().size());
    eq(0x10000L, v.getFrags().get(1).getExp());
    eq(0, decodes);
    eq(0x11111111L, v.getBody().getA());
    eq(2, decodes);                       // scanning Body reads a (piece 0) and b (piece 2)
    eq(0x22222222L, v.getBody().getB());
    eq(2, decodes);
    eq(0x2fff8, v.getBody().getPad().length);
    eq(3, decodes);
    eq(dev.yaffle.runtime.Json.write(Pieces.toJson(Pieces.parse(pieces()))), dev.yaffle.runtime.Json.write(Pieces.toJson((Pieces) dev.yaffle.runtime.ViewRead.materialize(v))));
  `,
  "a stream piece shorter than its size field fails when touched": `
    byte[] b = pieces();
    b[4] = 0x10;                          // frag 0 says exp = 0x10010 (more than it decodes)
    Pieces.View v = Pieces.view(b);
    path("[\\"frags\\",0,\\"data\\"]", fails("EOF", () -> v.getBody().getA()));
  `,
  "a ranged region decodes only the blocks a read touches": `
    positions.clear();
    Ranged.View v = Ranged.view(ranged());
    eq(0x0badf00dL, v.getBig().getTail());
    eq("[262144]", positions.toString());
    eq((byte) 7, v.getBig().getHead()[1]);
    eq("[262144, 0]", positions.toString()); // the missing blocks are decoded as one run
  `,
  "a source-backed view loads only the blocks it reads": `
    byte[] b = Table.serialize(table());
    reads.clear();
    Table.View v = Table.view(counting(b), null);
    eq(0x20000L, v.getEntries().get(2).getSize());
    eq("[0]", reads.toString());
    eq((byte) 3, v.getEntries().get(2).getData()[0]);
    eq("[0, 262144]", reads.toString()); // the entry's blocks, read as one run
    eq(hex(b), hex(v.commit()));
  `,
  "a source-backed view edits in place and commits": `
    byte[] b = Table.serialize(table());
    Table.View v = Table.view(counting(b), null);
    v.getEntries().get(1).getData();
    v.getEntries().get(3).getSize();
    byte[] out = v.commit();
    eq(hex(b), hex(out));
    Table.View w = Table.view(counting(b), null);
    w.getEntries().get(0).setData(new byte[] {1, 2, 3});
    Table p = Table.parse(w.commit());
    eq(3L, p.entries.get(0).size);
    eq(hex(new byte[] {1, 2, 3}), hex(p.entries.get(0).data));
    eq(0x20000L, p.entries.get(3).size);
  `,
  "an async view completes accesses as futures": `
    byte[] b = Table.serialize(table());
    reads.clear();
    dev.yaffle.runtime.AsyncView<Table.View> av = Table.viewAsync(countingAsync(b), null);
    java.util.concurrent.CompletableFuture<Long> size = av.get(v -> v.getEntries().get(2).getSize());
    eq(0x20000L, size.join());
    eq("[0]", reads.toString());
    av.set(v -> v.getEntries().get(2).setData(new byte[] {9})).join();
    byte[] out = av.commit().join();
    Table p = Table.parse(out);
    eq(1L, p.entries.get(2).size);
    eq(9, (int) p.entries.get(2).data[0]);
    eq(0x20000L, av.get(v -> v.getEntries().get(3).getSize()).join());
  `,
  "async views run accesses in order": `
    byte[] b = Table.serialize(table());
    dev.yaffle.runtime.AsyncView<Table.View> av = Table.viewAsync(countingAsync(b), null);
    java.util.List<java.util.concurrent.CompletableFuture<Long>> fs = new java.util.ArrayList<>();
    for (int k = 0; k < 4; k++) {
      final int i = k;
      fs.add(av.get(v -> v.getEntries().get(i).getOfs()));
    }
    java.util.concurrent.CompletableFuture<Object> before = av.materialize();
    av.set(v -> v.getEntries().get(0).setData(new byte[] {5})).join();
    for (int k = 1; k < 4; k++) check(fs.get(k).join() > fs.get(k - 1).join(), "offsets increase");
    eq(dev.yaffle.runtime.Json.write(Table.toJson(Table.parse(b))), dev.yaffle.runtime.Json.write(Table.toJson((Table) before.join())));
    Table after = (Table) av.materialize().join();
    eq(1, after.entries.get(0).data.length); // (derived sizes refresh on commit)
  `,
  "parseAsync reads an async source": `
    byte[] b = Table.serialize(table());
    Table t = Table.parseAsync(countingAsync(b), null).join();
    eq(4, t.entries.size());
  `,
  "an async source failure fails the access": `
    dev.yaffle.runtime.AsyncSource bad = new dev.yaffle.runtime.AsyncSource() {
      @Override public long size() { return 100; }
      @Override public java.util.concurrent.CompletableFuture<byte[]> read(long off, int len) {
        return java.util.concurrent.CompletableFuture.failedFuture(new java.io.UncheckedIOException(new java.io.IOException("disk")));
      }
    };
    dev.yaffle.runtime.AsyncView<Table.View> av = Table.viewAsync(bad, null);
    try {
      av.get(v -> v.getN()).join();
      check(false, "expected a failure");
    } catch (java.util.concurrent.CompletionException e) {
      check(String.valueOf(e.getCause()).contains("disk"), String.valueOf(e.getCause()));
    }
  `
};

describeJava(
  "java views: lazy streams, ranged regions, sources, async",
  "views-lazy",
  { "doc.yfl": schema },
  tests,
  {
    helpers,
    externs: { cnt: "yaffle.gen.Tests#CNT", rx: "yaffle.gen.Tests#RX" }
  }
);
