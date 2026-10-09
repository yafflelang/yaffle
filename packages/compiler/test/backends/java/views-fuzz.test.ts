/**
 * Property test for Java views and surgical writes: random edits on a view, then commit, then
 * re-parse, compared with the same edits applied to a plain object serialized from scratch.
 */
import { describeJava } from "./harness.ts";

const schema = `
struct Item {
  u16 id
  u8  n
  u16 tags[n]
  str name
}

export struct Doc {
  u32   magic = 0xd0c
  u16   version
  u8    count
  Item  items[count]
  u32   nblob
  u8    blob[nblob]
  Item *extra : u32 @nullable
  str  *note : u16
  u16   tail[3]
}
`;

const helpers = `
  static final class Rng {
    int a;
    Rng(int seed) { a = seed; }
    double next() {
      a += 0x6d2b79f5;
      int t = a;
      t = (t ^ (t >>> 15)) * (t | 1);
      t ^= t + (t ^ (t >>> 7)) * (t | 61);
      return ((t ^ (t >>> 14)) & 0xffffffffL) / 4294967296.0;
    }
    int n(int k) { return (int) (next() * k); }
  }
  static java.util.List<Integer> tags(Rng r, int max) {
    java.util.List<Integer> t = new java.util.ArrayList<>();
    int n = r.n(max);
    for (int i = 0; i < n; i++) t.add(r.n(256));
    return t;
  }
  static Item item(Rng r) {
    Item it = new Item();
    it.tags = tags(r, 4);
    it.id = r.n(65536);
    it.name = "n" + "x".repeat(r.n(6));
    return it;
  }
  static Item copy(Item it) {
    Item c = new Item();
    c.id = it.id;
    c.tags = new java.util.ArrayList<>(it.tags);
    c.name = it.name;
    return c;
  }
  static Doc doc(Rng r) {
    Doc d = new Doc();
    d.version = r.n(65536);
    d.items = new java.util.ArrayList<>();
    int n = 1 + r.n(4);
    for (int i = 0; i < n; i++) d.items.add(item(r));
    byte[] b = new byte[r.n(20)];
    for (int i = 0; i < b.length; i++) b[i] = (byte) r.n(256);
    d.blob = b;
    d.extra = r.next() < 0.5 ? null : item(r);
    d.note = "note" + "!".repeat(r.n(5));
    d.tail = new java.util.ArrayList<>(java.util.List.of(1, 2, 3));
    return d;
  }
  static String edit(Rng r, Doc.View v, Doc p) {
    int k = r.n(11);
    int i = r.n(p.items.size());
    switch (k) {
      case 0: {
        int x = r.n(65536);
        v.setVersion(x);
        p.version = x;
        return "version=" + x;
      }
      case 1: {
        int x = r.n(65536);
        v.getItems().get(i).setId(x);
        p.items.get(i).id = x;
        return "items[" + i + "].id=" + x;
      }
      case 2: {
        Item it = item(r);
        v.getItems().add(Item.View.of(copy(it)));
        p.items.add(it);
        return "push";
      }
      case 3: {
        if (p.items.size() <= 1) return "noop";
        v.getItems().remove(i);
        p.items.remove(i);
        return "remove(" + i + ")";
      }
      case 4: {
        String name = "renamed" + "y".repeat(r.n(4));
        v.getItems().get(i).setName(name);
        p.items.get(i).name = name;
        return "items[" + i + "].name";
      }
      case 5: {
        java.util.List<Integer> t = tags(r, 5);
        v.getItems().get(i).setTags(new java.util.ArrayList<>(t));
        p.items.get(i).tags = t;
        return "items[" + i + "].tags";
      }
      case 6: {
        byte[] b = new byte[r.n(30)];
        for (int j = 0; j < b.length; j++) b[j] = (byte) r.n(256);
        v.setBlob(b.clone());
        p.blob = b;
        return "blob(" + b.length + ")";
      }
      case 7: {
        Item it = r.next() < 0.3 ? null : item(r);
        v.setExtra(it == null ? (Item) null : copy(it));
        p.extra = it;
        return "extra=" + (it == null ? "null" : "item");
      }
      case 8: {
        int j = r.n(3);
        int x = r.n(65536);
        v.getTail().set(j, x);
        p.tail.set(j, x);
        return "tail[" + j + "]=" + x;
      }
      case 9: {
        String note = "n" + "z".repeat(r.n(9));
        v.setNote(note);
        p.note = note;
        return "note";
      }
      default: {
        if (p.items.get(i).tags.isEmpty()) return "noop";
        int x = r.n(256);
        v.getItems().get(i).getTags().set(0, x);
        p.items.get(i).tags.set(0, x);
        return "items[" + i + "].tags[0]=" + x;
      }
    }
  }
  static String json(Doc d) {
    return dev.yaffle.runtime.Json.write(Doc.toJson(d));
  }
`;

const SEEDS = 200;

const tests: Record<string, string> = {};
for (let block = 0; block < 10; block++) {
  const from = 1 + block * (SEEDS / 10);
  const to = from + SEEDS / 10 - 1;
  tests[`seeds ${from}..${to}`] = `
    dev.yaffle.runtime.Layout.Grow[] policies = {dev.yaffle.runtime.Layout.Grow.DEFAULT, dev.yaffle.runtime.Layout.Grow.APPEND, dev.yaffle.runtime.Layout.Grow.SPLICE};
    for (int seed = ${from}; seed <= ${to}; seed++) {
      Rng r = new Rng(seed);
      Doc plain = doc(r);
      byte[] bytes = Doc.serialize(plain);
      Doc.View v = Doc.view(bytes);
      java.util.List<String> log = new java.util.ArrayList<>();
      for (int round = 0; round < 3; round++) {
        int edits = 1 + r.n(5);
        for (int e = 0; e < edits; e++) log.add(edit(r, v, plain));
        dev.yaffle.runtime.Layout.Grow policy = policies[r.n(policies.length)];
        String where = "seed " + seed + " round " + round + " (" + policy + "): " + log;
        java.util.List<dev.yaffle.runtime.Patch> patches;
        byte[] committed;
        try {
          patches = v.patches(policy);
          committed = v.commit(policy);
        } catch (RuntimeException x) {
          throw new AssertionFailed(where + ": " + x);
        }
        check(java.util.Arrays.equals(dev.yaffle.runtime.Patch.apply(bytes, patches), committed), "patches != commit: " + where);
        String want = json(Doc.parse(Doc.serialize(plain)));
        String got = json(Doc.parse(committed));
        check(want.equals(got), where + "\\nwant " + want + "\\ngot  " + got);
        String viewJson = json(v.toValue());
        check(want.equals(viewJson), "view value: " + where + "\\nwant " + want + "\\ngot  " + viewJson);
        bytes = committed;
      }
    }
  `;
}

describeJava(
  "java views: random edits match plain objects",
  "views-fuzz",
  { "doc.yfl": schema },
  tests,
  { helpers }
);
