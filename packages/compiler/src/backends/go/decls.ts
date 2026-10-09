/** Declarations: constants, enums (with their JSON converters), struct types, unions, placeholders. */
import type { IrConst, IrExtern, IrStruct } from "../../ir/index.ts";
import { Code, alignRows, exported, goStr } from "./code.ts";
import { bytesLiteral, formatFloat, formatInt } from "./expr.ts";
import { primGo, type Model, type UnionInfo } from "./model.ts";

export function emitConst(code: Code, model: Model, c: IrConst): void {
  const name = model.names.take(exported(c.name));
  const v = c.value;
  code.line(`// ${name} is the constant ${c.name}.`);
  switch (v.kind) {
    case "int": {
      const t = c.type.kind === "int" ? model.goValueType(c.type) : "int64";
      code.line(`const ${name} ${t} = ${formatInt(BigInt(v.value))}`);
      break;
    }
    case "float":
      code.line(`const ${name} = ${formatFloat(v.value)}`);
      break;
    case "bool":
      code.line(`const ${name} = ${v.value}`);
      break;
    case "string":
      code.line(`const ${name} = ${goStr(v.value)}`);
      break;
    case "bytes":
      code.line(`var ${name} = ${bytesLiteral(v.hex)}`);
      break;
    case "endian":
      code.line(`const ${name} = ${v.value === "be" ? "yaffle.BE" : "yaffle.LE"}`);
      break;
    case "enum":
      code.line(`const ${name} = ${model.enumMember(v.enum, v.member)}`);
      break;
  }
}

export function emitEnum(code: Code, model: Model, id: string): void {
  const e = model.enum(id);
  const name = model.enumName(id);
  const bits = Number(e.storage.slice(1));
  const signed = e.storage[0] === "i";
  const member = (m: string): string => model.enumMember(id, m);
  // Distinct values (aliases share a case).
  const seen = new Set<string>();
  const distinct = e.members.filter(m => !seen.has(m.value) && seen.add(m.value));
  /** `switch e { case …: … }` over the distinct members, then fallback. */
  const memberSwitch = (
    body: (m: (typeof e.members)[number]) => string,
    fallback: () => void
  ): void => {
    if (distinct.length) {
      code.line("switch e {");
      for (const m of distinct) {
        code.line(`case ${member(m.name)}:`);
        code.indent(() => code.line(body(m)));
      }
      code.line("}");
    }
    fallback();
  };
  const number = bits > 48 ? (signed ? "j.IntStr" : "j.UintStr") : signed ? "j.Int" : "j.Uint";
  const toNumber = `${number}(${signed ? "int64" : "uint64"}(e))`;

  code.line("");
  code.line(
    `// ${name} is the enum ${e.name}${e.open ? " (open: unknown values pass through)" : ""}.`
  );
  code.line(`type ${name} ${primGo(e.storage)}`);
  if (e.members.length) {
    code.line("");
    code.line(`// Members of ${name}.`);
    code.line("const (");
    code.indent(() => {
      const rows = e.members.map(m => [member(m.name), name, `= ${formatInt(BigInt(m.value))}`]);
      for (const l of alignRows(rows)) code.line(l);
    });
    code.line(")");
  }
  code.line("");
  code.line(`// IsKnown reports whether e is a member of ${name}.`);
  code.block(`func (e ${name}) IsKnown() bool`, () => {
    if (distinct.length) {
      code.line("switch e {");
      code.line(`case ${distinct.map(m => member(m.name)).join(", ")}:`);
      code.indent(() => code.line("return true"));
      code.line("}");
    }
    code.line("return false");
  });
  code.line("");
  code.line(`// String returns the member name, or the number of an unknown value.`);
  code.block(`func (e ${name}) String() string`, () =>
    memberSwitch(
      m => `return ${goStr(m.name)}`,
      () =>
        code.line(
          signed ? `return yaffle.FormatInt(int64(e))` : `return yaffle.FormatUint(uint64(e))`
        )
    )
  );
  code.line("");
  code.block(`func toJSON${name}(j *yaffle.JSONWriter, e ${name})`, () => {
    if (!distinct.length) {
      code.line(toNumber);
      return;
    }
    code.line("switch e {");
    for (const m of distinct) {
      code.line(`case ${member(m.name)}:`);
      code.indent(() => code.line(`j.Str(${goStr(m.name)})`));
    }
    code.line("default:");
    code.indent(() => code.line(toNumber));
    code.line("}");
  });
  code.line("");
  code.block(`func fromJSON${name}(j any) ${name}`, () => {
    if (e.members.length) {
      code.block("if s, ok := j.(string); ok", () => {
        code.line("switch s {");
        for (const m of e.members) {
          code.line(`case ${goStr(m.name)}:`);
          code.indent(() => code.line(`return ${member(m.name)}`));
        }
        code.line("}");
      });
    }
    if (!e.open) {
      code.line(`yaffle.FailMsg(yaffle.INPUT, yaffle.Describe(j)+" is not a member of the enum")`);
      code.line("return 0");
      return;
    }
    const str = bits > 48 ? "true" : "false";
    if (signed) {
      const lo = -(1n << BigInt(bits - 1));
      const hi = (1n << BigInt(bits - 1)) - 1n;
      code.line(
        `return ${name}(yaffle.JInt(j, ${lo}, ${formatInt(hi)}, ${str}, ${goStr(e.storage)}))`
      );
    } else {
      const hi = (1n << BigInt(bits)) - 1n;
      code.line(`return ${name}(yaffle.JUint(j, ${formatInt(hi)}, ${str}, ${goStr(e.storage)}))`);
    }
  });
}

export function emitStructType(code: Code, model: Model, s: IrStruct): void {
  const name = model.structName(s.id);
  const rows: string[][] = [];
  for (const g of model.goFieldsOf(s)) {
    rows.push([g.go, g.type]);
    if (g.raw) rows.push([g.raw.go, g.raw.type]);
  }
  rows.push(["yfl", "yaffle.Meta"]);
  const doc = s.doc ? s.doc.split("\n")[0]!.trim() : `the struct ${s.name} (${s.module})`;
  code.line(`// ${name} is ${doc.replace(/^[A-Z]/, c => c.toLowerCase())}`.replace(/\.?$/, "."));
  code.block(`type ${name} struct`, () => {
    for (const l of alignRows(rows)) code.line(l);
  });
}

export function emitUnionType(code: Code, u: UnionInfo): void {
  code.line(`// ${u.go} is a union: Type names the variant that is set.`);
  code.block(`type ${u.go} struct`, () => {
    for (const l of alignRows([["Type", "string"], ...u.variants.map(v => [v.go, v.type])]))
      code.line(l);
  });
}

/** A placeholder for an extern without a Go implementation: using it fails with INPUT. */
export function emitMissingExtern(code: Code, model: Model, xt: IrExtern, name: string): void {
  code.line(
    `// ${name} stands in for extern ${xt.name}, which has no Go implementation in yaffle.json.`
  );
  if (xt.kind === "codec") {
    code.line(`var ${name} = yaffle.MissingCodec(${goStr(xt.name)})`);
  } else if (xt.kind === "type") {
    code.line(
      `var ${name} = yaffle.MissingType[${model.goValueType(xt.valueType)}](${goStr(xt.name)})`
    );
  } else {
    const params = xt.params.map((p, i) => `p${i} ${model.goValueType(p.type)}`).join(", ");
    const ret = model.goValueType(xt.returns);
    code.block(`func ${name}(${params}) ${ret}`, () => {
      code.line(`yaffle.MissingExtern(${goStr(xt.name)})`);
      code.line(`var zero ${ret}`);
      code.line("return zero");
    });
  }
}
