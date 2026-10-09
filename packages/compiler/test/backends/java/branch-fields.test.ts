/**
 * Fields across branches: a conditional nullable pointer tells a null value from an untaken
 * branch, and a field with different types in different branches converts per branch.
 */
import { describeJava } from "./harness.ts";

const schema = `
struct P { u8 x }

export struct Cond {
  u8 has
  if (has != 0) { P *p : u8 @nullable }
}

struct A { u8 a }
struct B { u16 b }

export struct Multi {
  u8 tag
  switch (tag) {
    case 1: u8  v
    case 2: u32 v
    case 3: char v[2]
    case 4: A   w
    case 5: B   w
  }
}
`;

const J = (s: string): string => JSON.stringify(s);

const tests: Record<string, string> = {
  "a null pointer in a taken branch is null; an untaken branch has no key": `
    json("{\\"has\\":1,\\"p\\":null}", Cond.toJson(Cond.parse(hex("0100"))));
    json("{\\"has\\":0}", Cond.toJson(Cond.parse(hex("00"))));
    json("{\\"has\\":1,\\"p\\":{\\"x\\":7}}", Cond.toJson(Cond.parse(hex("010207"))));
    eq("0100", hex(Cond.serialize(Cond.fromJson(Cond.toJson(Cond.parse(hex("0100")))))));
    json("{\\"has\\":1,\\"p\\":null}", Cond.toJson((Cond) dev.yaffle.runtime.ViewRead.materialize(Cond.view(hex("0100")))));
    json("{\\"has\\":0}", Cond.toJson((Cond) dev.yaffle.runtime.ViewRead.materialize(Cond.view(hex("00")))));
  `,
  "a field with different types in different branches": `
    for (String h : new String[] {"0105", "0278563412", "036869", "0409", "050201"}) {
      Multi m = Multi.parse(hex(h));
      Object j = Multi.toJson(m);
      eq(h, hex(Multi.serialize(Multi.fromJson(dev.yaffle.runtime.Json.parse(dev.yaffle.runtime.Json.write(j))))));
      eq(dev.yaffle.runtime.Json.write(j), dev.yaffle.runtime.Json.write(Multi.toJson((Multi) dev.yaffle.runtime.ViewRead.materialize(Multi.view(hex(h))))));
    }
    json(${J('{"tag":2,"v":305419896}')}, Multi.toJson(Multi.parse(hex("0278563412"))));
    json(${J('{"tag":3,"v":"hi"}')}, Multi.toJson(Multi.parse(hex("036869"))));
    eq("02ffffffff", hex(Multi.serialize(Multi.fromJson(dev.yaffle.runtime.Json.parse(${J('{"tag":2,"v":4294967295}')})))));
    fails("RANGE", () -> Multi.serialize(Multi.fromJson(dev.yaffle.runtime.Json.parse(${J('{"tag":1,"v":300}')}))));
  `
};

describeJava("java fields across branches", "branch-fields", { "doc.yfl": schema }, tests);
