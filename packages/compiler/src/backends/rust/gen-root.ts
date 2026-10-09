/** Root API: params structs and `parse` / `serialize` / `to_json` / `from_json`. */
import type { IrExpr, IrRoot } from "../../ir/index.ts";
import { indent } from "./emit.ts";
import { compile, toStored, type ExprCtx } from "./expr.ts";
import { fromJson } from "./gen-json.ts";
import { ReadGen, argAsParam } from "./gen-read.ts";
import { WriteGen } from "./gen-write.ts";
import {
  BackendError,
  endianVar,
  rootType,
  type Model,
  type ParamModel,
  type StructModel
} from "./model.ts";
import { snake, strLit } from "./names.ts";

/** The field of a root parameter in the params struct. */
export function paramField(p: ParamModel): string {
  return snake(p.pub);
}

/** Statements binding a root's parameters (`p_x`) from `params`, as readers and writers take them. */
export function paramBinds(sm: StructModel): string[] {
  return sm.params.map(p => `let ${p.v} = ${argAsParam(p, `params.${paramField(p)}`)};`);
}

/** A parameter's default: its constant default value, or the type's default. */
function defaultValue(m: Model, sm: StructModel, p: ParamModel): string {
  if (p.ir.default) {
    const fail = (): never => {
      throw new BackendError("not a constant");
    };
    const ctx: ExprCtx = {
      m,
      sm,
      mode: "eager",
      field: fail,
      param: fail,
      offset: fail,
      end: fail,
      index: fail
    };
    try {
      const code = toStored(ctx, compile(ctx, p.ir.default as IrExpr), p.shape);
      if (!code.includes("?")) return code;
      return `(|| -> yr::Result<${m.rustType(p.shape)}> { Ok(${code}) })().unwrap_or_default()`;
    } catch {
      // Not a constant: the type's default.
    }
  }
  return p.ir.origin === "endian" ? "yr::Endian::Le" : "Default::default()";
}

export function genRoot(m: Model, root: IrRoot): string[] {
  const sm = m.struct(root.struct);
  const pname = m.paramsNames.get(root.struct)!;
  const fields = sm.params.map(p => `    pub ${paramField(p)}: ${m.rustType(p.shape)},`);
  const defaults = sm.params.map(p => `${paramField(p)}: ${defaultValue(m, sm, p)}`);
  const fromArgs = sm.params.map(
    p =>
      `if let Some(__m) = __v.get(${strLit(p.pub)}) { let mut j = yr::JsonIn::new(); let _ = &mut j; __p.${paramField(p)} = (|| -> yr::Result<${m.rustType(p.shape)}> { Ok(${fromJson(m, "__m", p.shape)}) })().map_err(|e| e.in_field(${strLit(p.pub)}))?; }`
  );
  const params = [
    `/// Parameters of \`${sm.name}\` (explicit, bound and endianness parameters).`,
    "#[derive(Debug, Clone)]",
    `pub struct ${pname} {`,
    ...fields,
    "}",
    `impl Default for ${pname} {`,
    "    fn default() -> Self {",
    `        Self { ${defaults.join(", ")} }`,
    "    }",
    "}",
    `impl ${pname} {`,
    "    /// Reads parameters from a JSON object (missing ones keep their defaults).",
    "    pub fn from_json(__v: &yr::Value) -> yr::Result<Self> {",
    "        let mut __p = Self::default();",
    ...indent(fromArgs, 2),
    "        let _ = __v;",
    "        Ok(__p)",
    "    }",
    "}"
  ];

  const t = rootType(sm);
  const endian = endianVar(sm);
  const read = new ReadGen(m, sm).readType(t, { rv: "r", endian, indices: [], field: "$self" });
  const write = new WriteGen(m, sm).rootWrite(t, endian);
  const body = [
    "/// Parses bytes with default options and parameters.",
    "pub fn parse(bytes: &[u8]) -> yr::Result<Self> {",
    `    Self::parse_with(bytes, &yr::ParseOptions::default(), &${pname}::default())`,
    "}",
    `pub fn parse_with(bytes: &[u8], opts: &yr::ParseOptions, params: &${pname}) -> yr::Result<Self> {`,
    "    let __sh = yr::Shared::cell();",
    "    let mut __rd = yr::Reader::new(bytes, &__sh, opts.strict);",
    "    let r = &mut __rd;",
    ...(sm.hasCache ? ["    let mut __cache = yr::ViaCache::new();"] : []),
    ...indent(paramBinds(sm)),
    `    let mut __v: Self = (|| -> yr::Result<Self> { Ok(${read}) })()?;`,
    ...(sm.hasCache ? ["    __v.__cache.absorb(__cache);"] : []),
    "    Ok(__v)",
    "}",
    "/// Serializes with default parameters.",
    "pub fn serialize(&self) -> yr::Result<Vec<u8>> {",
    `    self.serialize_with(&${pname}::default())`,
    "}",
    `pub fn serialize_with(&self, params: &${pname}) -> yr::Result<Vec<u8>> {`,
    "    Ok(self.serialize_layout(params, None, false)?.0)",
    "}",
    "/// Serializes with sticky placements (view commits: placeables keep these positions, by path,",
    "/// when they still fit) and/or records where every placeable goes.",
    `pub fn serialize_layout(&self, params: &${pname}, sticky: Option<std::collections::HashMap<String, (u64, u64)>>, record: bool) -> yr::Result<(Vec<u8>, Vec<(String, u64, u64)>)> {`,
    "    let __arena = yr::Arena::new();",
    "    let mut __wr = yr::Writer::with_arena(&__arena);",
    "    let w = &mut __wr;",
    "    if let Some(s) = sticky { w.set_sticky(s); }",
    "    if record { w.record_places(); }",
    "    let v = self;",
    ...indent(paramBinds(sm)),
    "    w.begin_space();",
    "    let __res: yr::Result<()> = (|| -> yr::Result<()> {",
    ...indent(write, 2),
    "        Ok(())",
    "    })();",
    "    if let Err(e) = __res {",
    "        return Err(w.locate(e));",
    "    }",
    "    let __out = w.end_base()?;",
    "    Ok((__out, w.take_recorded()))",
    "}",
    "/// Canonical JSON (docs/CONFORMANCE.md §3).",
    "pub fn to_json(&self) -> yr::Value {",
    "    self.to_json_with(&mut yr::JsonOut::new())",
    "}",
    "pub fn from_json(v: &yr::Value) -> yr::Result<Self> {",
    "    yr::JsonIn::with_root(v, Self::from_json_with)",
    "}"
  ];
  return [...params, `impl ${sm.name} {`, ...indent(body), "}"];
}
