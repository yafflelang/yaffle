/** Canonical JSON (docs/CONFORMANCE.md §3): `to_json_with` / `from_json_with`. */

import { indent } from "./emit.ts";
import { compile, eqExpr, literal, tmp, type ExprCtx } from "./expr.ts";
import {
  BackendError,
  localPlace,
  walkExpr,
  type FieldInfo,
  type Model,
  type RMember,
  type Shape,
  type StructModel,
  type SwitchModel,
  type UnionModel
} from "./model.ts";
import { strLit } from "./names.ts";

/** Does a shared target of this shape show up as `$ref` (its JSON is an object or array)? */
function objectLike(s: Shape): boolean {
  return s.k === "struct" || s.k === "union" || s.k === "array";
}

/** A stored value → `yr::Value` (uses `j: &mut yr::JsonOut`). */
export function toJson(m: Model, place: string, s: Shape): string {
  switch (s.k) {
    case "int":
      // Up to 48 bits: a JSON number; wider: a decimal string.
      return s.bits <= 32 || s.bits === 40 || s.bits === 48
        ? `yr::json::int(${place})`
        : `yr::json::big(${place})`;
    case "float":
      return `yr::json::float(${place} as f64)`;
    case "bool":
      return `yr::Value::Bool(${place})`;
    case "string":
      return `yr::Value::Str(${place}.clone())`;
    case "bytes":
      return `yr::json::bytes(&${place})`;
    case "endian":
      return `yr::Value::Str(${place}.as_str().to_string())`;
    case "struct":
    case "union":
      return `${place}.to_json_with(j)`;
    case "enum":
      return `${place}.to_json()`;
    case "array":
      if (m.sharedShape(s.elem))
        return `yr::Value::Array(${place}.iter().enumerate().map(|(__i, __e)| { j.push_index(__i); let __v = ${toJson(m, "(*__e)", s.elem)}; j.pop(); __v }).collect())`;
      return `yr::Value::Array(${place}.iter().map(|__e| ${toJson(m, "(*__e)", s.elem)}).collect())`;
    case "box":
      return toJson(m, `(*${place})`, s.inner);
    case "rc":
      if (objectLike(s.inner))
        return `j.shared(&${place}, ${strLit(m.rustType(s.inner))}, |j| ${toJson(m, `(*${place})`, s.inner)})`;
      return toJson(m, `(*${place})`, s.inner);
    case "option": {
      const o = tmp("o");
      return `match &${place} { Some(${o}) => ${toJson(m, `(*${o})`, s.inner)}, None => yr::Value::Null }`;
    }
    case "oneway":
      // Canonical JSON keeps the raw value, so it stays lossless.
      return toJson(m, `${place}.raw`, s.raw);
    case "extern":
      return toJson(m, place, s.value);
  }
}

/** A `&yr::Value` expression → a stored value (uses `j: &mut yr::JsonIn`, `?`). */
export function fromJson(m: Model, v: string, s: Shape): string {
  switch (s.k) {
    case "int":
      if (s.rust === "i128") return `yr::json::get_int(${v})?`;
      if ([8, 16, 32, 64].includes(s.bits))
        return `yr::json::get_typed_bits::<${s.rust}>(${v}, ${s.bits})?`;
      return s.signed
        ? `(yr::int::to_sbits(yr::json::get_int_bits(${v}, ${s.bits})?, ${s.bits})? as ${s.rust})`
        : `(yr::int::to_ubits(yr::json::get_int_bits(${v}, ${s.bits})?, ${s.bits})? as ${s.rust})`;
    case "float":
      return `(yr::json::get_float(${v})? as ${s.rust})`;
    case "bool":
      return `yr::json::get_bool(${v})?`;
    case "string":
      return `yr::json::get_string(${v})?`;
    case "bytes":
      return `yr::json::get_bytes(${v})?`;
    case "endian":
      return `yr::json::get_endian(${v})?`;
    case "struct":
      return `${m.struct(s.id).name}::from_json_with(${v}, j)?`;
    case "union":
      return `${s.name}::from_json_with(${v}, j)?`;
    case "enum":
      return `${m.enum(s.id).name}::from_json(${v})?`;
    case "array": {
      const t = m.rustType(s.elem);
      const arr = tmp("arr");
      const out = tmp("out");
      const i = tmp("i");
      const x = tmp("x");
      return `{ let ${arr} = yr::json::get_array(${v})?; let mut ${out}: Vec<${t}> = Vec::with_capacity(${arr}.len()); for (${i}, ${x}) in ${arr}.iter().enumerate() { j.push_index(${i}); let __r = (|| -> yr::Result<${t}> { Ok(${fromJson(m, x, s.elem)}) })(); j.pop(); ${out}.push(yr::ResultExt::ri(__r, ${i})?); } ${out} }`;
    }
    case "box":
      return `Box::new(${fromJson(m, v, s.inner)})`;
    case "rc": {
      const x = tmp("x");
      return `j.shared(${v}, ${identStub(m, s.inner)}, |${x}: &yr::Value, j: &mut yr::JsonIn| -> yr::Result<${m.rustType(s.inner)}> { Ok(${fromJson(m, x, s.inner)}) })?`;
    }
    case "option": {
      const o = tmp("o");
      return `{ let ${o} = ${v}; if ${o}.is_null() { None } else { Some(${fromJson(m, o, s.inner)}) } }`;
    }
    case "oneway":
      return `yr::OneWay { value: Default::default(), raw: ${fromJson(m, v, s.raw)} }`;
    case "extern":
      return fromJson(m, v, s.value);
  }
}

/** `Some(<stub maker>)` for a pointer target with an identity, else `None`. */
export function identStub(m: Model, s: Shape): string {
  if (s.k === "struct" && m.identStructs.has(s.id))
    return `Some(|__i: yr::Ident| ${m.struct(s.id).name} { __id: __i, ..Default::default() })`;
  return "None";
}

// ─── Structs ─────────────────────────────────────────────────────────────────

function pushField(m: Model, f: FieldInfo, place: string): string[] {
  const conv = toJson(m, place, f.shape);
  if (m.sharedShape(f.shape))
    return [
      `j.push(${strLit(f.name)});`,
      `{ let __v = ${conv}; __o.push((${strLit(f.name)}.to_string(), __v)); }`,
      "j.pop();"
    ];
  return [`__o.push((${strLit(f.name)}.to_string(), ${conv}));`];
}

function toJsonMembers(m: Model, members: RMember[], obj: (ident: string) => string): string[] {
  const out: string[] = [];
  for (const mm of members) {
    if (mm.k === "field") {
      // Hidden stream carriers are stored but not in the JSON.
      if (!mm.info.output) continue;
      if (mm.optional) {
        const x = tmp("f");
        out.push(
          `if let Some(${x}) = &${obj(mm.info.ident)} {`,
          ...indent(pushField(m, mm.info, `(*${x})`)),
          "}"
        );
      } else out.push(...pushField(m, mm.info, obj(mm.info.ident)));
    } else {
      const sw = mm.sw;
      const s = tmp("sw");
      const arms: string[] = [];
      for (const v of sw.variants) {
        if (sw.tuple) {
          const fm = v.members[0] as Extract<RMember, { k: "field" }>;
          arms.push(
            `${sw.enumName}::${v.name}(__x) => {`,
            ...indent(pushField(m, fm.info, "(*__x)")),
            "}"
          );
        } else if (v.members.length === 0) arms.push(`${sw.enumName}::${v.name} => {}`);
        else {
          const binds = v.members.map(
            (x, i) => `${x.k === "field" ? x.info.ident : x.sw.ident}: __b${i}`
          );
          const names = new Map(
            v.members.map((x, i) => [x.k === "field" ? x.info.ident : x.sw.ident, `(*__b${i})`])
          );
          arms.push(
            `${sw.enumName}::${v.name} { ${binds.join(", ")} } => {`,
            ...indent(toJsonMembers(m, v.members, id => names.get(id)!)),
            "}"
          );
        }
      }
      if (mm.optional)
        out.push(
          `if let Some(${s}) = &${obj(sw.ident)} {`,
          `    match ${s} {`,
          ...indent(arms, 2),
          "    }",
          "}"
        );
      else out.push(`match &${obj(sw.ident)} {`, ...indent(arms), "}");
    }
  }
  return out;
}

/** Fields of a member group that must be present in JSON (required inputs, not optional). */
function requiredNames(members: RMember[]): string[] {
  const out: string[] = [];
  for (const mm of members) {
    if (mm.k === "field" && !mm.optional && mm.info.input === "required") out.push(mm.info.name);
  }
  return out;
}

function allNames(members: RMember[]): string[] {
  const out: string[] = [];
  for (const mm of members) {
    if (mm.k === "field") {
      if (mm.info.output) out.push(mm.info.name);
    } else for (const v of mm.sw.variants) out.push(...allNames(v.members));
  }
  return out;
}

/** `from_json_with` of a struct: one local per field, read from the JSON object `__v`. */
class FromJsonGen {
  private m: Model;
  private sm: StructModel;
  private declared = new Set<FieldInfo>();
  private optionalLocals = new Set<FieldInfo>();

  constructor(m: Model, sm: StructModel) {
    this.m = m;
    this.sm = sm;
  }

  /** Expressions over the fields read so far (switch discriminants). */
  private ctx(): ExprCtx {
    const sm = this.sm;
    const no = (): never => {
      throw new BackendError("not available in from_json");
    };
    return {
      m: this.m,
      sm,
      mode: "json",
      field: name => {
        const f = sm.fields.get(name);
        if (!f || !this.declared.has(f)) return no();
        return { kind: "place", place: localPlace(f, this.optionalLocals.has(f)), shape: f.shape };
      },
      param: no,
      offset: no,
      end: no,
      index: no
    };
  }

  private field(f: FieldInfo, optional: boolean): string[] {
    const t = this.m.rustType(f.shape);
    if (!f.output)
      return [`let ${f.local}: ${optional ? `Option<${t}>` : t} = Default::default();`];
    const conv = fromJson(this.m, "__m", f.shape);
    const name = strLit(f.name);
    const read = `{ j.push(${name}); let __r = (|| -> yr::Result<${t}> { Ok(${conv}) })(); j.pop(); yr::ResultExt::wf(__r, ${name}) }`;
    if (optional) {
      const guard = f.shape.k === "option" ? "" : " if !__m.is_null()";
      return [
        `let ${f.local}: Option<${t}> = match __v.get(${name}) { Some(__m)${guard} => Some(${read}?), _ => None };`
      ];
    }
    if (f.input === "required" && this.m.streamArrays.has(`${this.sm.ir.id}.${f.name}`))
      // A stream's pieces: absent means the writer splits the content (`@split(fit)`).
      return [
        `let ${f.local}: ${t} = match __v.get(${name}) { Some(__m) if !__m.is_null() => ${read}?, _ => Default::default() };`
      ];
    if (f.input === "required")
      return [`let ${f.local}: ${t} = { let __m = yr::json::required(__v, ${name})?; ${read}? };`];
    // Derived and constant fields: taken from the JSON when present (and valid), else defaulted.
    return [
      `let ${f.local}: ${t} = match __v.get(${name}) { Some(__m) => ${read}.unwrap_or_default(), None => Default::default() };`
    ];
  }

  /** The statements reading a member group, and the struct (or variant) initializers. */
  members(members: RMember[]): { lines: string[]; inits: string[] } {
    const lines: string[] = [];
    const inits: string[] = [];
    for (const mm of members) {
      if (mm.k === "field") {
        if (!this.declared.has(mm.info)) {
          lines.push(...this.field(mm.info, mm.optional));
          this.declared.add(mm.info);
          if (mm.optional) this.optionalLocals.add(mm.info);
        }
        inits.push(`${mm.info.ident}: ${mm.info.local}`);
      } else {
        const { lines: l, value } = this.switch_(mm.sw, mm.optional);
        lines.push(...l);
        inits.push(`${mm.sw.ident}: ${value}`);
      }
    }
    return { lines, inits };
  }

  /** The case index chosen by the discriminant over the fields read so far, if it compiles. */
  private discriminant(sw: SwitchModel): string | undefined {
    let ok = true;
    walkExpr(sw.ir.discriminant, x => {
      if (x.kind === "param" || x.kind === "builtinValue" || x.kind === "it") ok = false;
    });
    if (!ok) return undefined;
    try {
      const ctx = this.ctx();
      const d = compile(ctx, sw.ir.discriminant);
      const dv = tmp("d");
      const conds = sw.ir.cases.map(
        (c, i) =>
          `if ${c.values.map(v => eqExpr({ code: dv, t: d.t }, literal(ctx, v))).join(" || ") || "false"} { ${i} }`
      );
      return `(|| -> yr::Result<i32> { let ${dv} = ${d.code}; Ok(${conds.length ? conds.join(" else ") + " else { -1 }" : "-1"}) })().unwrap_or(-1)`;
    } catch {
      return undefined;
    }
  }

  private switch_(sw: SwitchModel, optional: boolean): { lines: string[]; value: string } {
    const lines: string[] = [];
    const cv = tmp("case");
    const disc = this.discriminant(sw);
    if (disc) {
      lines.push(`let ${cv}: i32 = ${disc};`);
    } else {
      // The case whose fields are present (all required ones, then the most present).
      const scores = sw.variants.map(v => {
        const req = requiredNames(v.members).map(n => `__v.get(${strLit(n)}).is_some()`);
        const all = allNames(v.members).map(n => `(__v.get(${strLit(n)}).is_some() as i32)`);
        return `if ${req.length ? req.join(" && ") : "true"} { ${all.length ? all.join(" + ") : "0"} } else { -1 }`;
      });
      lines.push(
        `let ${cv}: i32 = { let __scores = [${scores.join(", ")}]; let __idx = [${sw.variants.map(v => v.caseIndex).join(", ")}]; let mut __best = 0usize; for __k in 1..__scores.len() { if __scores[__k] > __scores[__best] { __best = __k; } } if __scores.is_empty() || __scores[__best] < 0 { -2 } else { __idx[__best] } };`
      );
    }
    const arms: string[] = [];
    for (const v of sw.variants) {
      const saved = new Set(this.declared);
      const { lines: l, inits } = this.members(v.members);
      this.declared = saved;
      let value: string;
      if (sw.tuple) {
        const fm = v.members[0] as Extract<RMember, { k: "field" }>;
        value = `${sw.enumName}::${v.name}(${fm.info.local})`;
      } else if (v.members.length === 0) value = `${sw.enumName}::${v.name}`;
      else value = `${sw.enumName}::${v.name} { ${inits.join(", ")} }`;
      arms.push(
        `${v.caseIndex} => {`,
        ...indent(l),
        `    ${optional ? `Some(${value})` : value}`,
        "}"
      );
    }
    arms.push(
      optional
        ? "_ => None,"
        : `_ => return Err(yr::YaffleError::new(yr::ErrorCode::Check, "no switch case matches the JSON value")),`
    );
    const sv = tmp("swv");
    lines.push(`let ${sv} = match ${cv} {`, ...indent(arms), "};");
    return { lines, value: sv };
  }
}

export function genStructJson(m: Model, sm: StructModel): string[] {
  const out: string[] = [];
  const ident = m.identStructs.has(sm.ir.id);
  out.push("pub fn to_json_with(&self, j: &mut yr::JsonOut) -> yr::Value {");
  if (ident)
    out.push("    if let Some(__r) = j.ident_ref(self.__id) {", "        return __r;", "    }");
  out.push(`    let mut __o: Vec<(String, yr::Value)> = Vec::with_capacity(${sm.members.length});`);
  out.push(...indent(toJsonMembers(m, sm.members, id => `self.${id}`)));
  out.push("    let _ = &j;", "    yr::Value::Object(__o)", "}");
  const g = new FromJsonGen(m, sm);
  const { lines, inits } = g.members(sm.members);
  out.push("pub fn from_json_with(__v: &yr::Value, j: &mut yr::JsonIn) -> yr::Result<Self> {");
  if (ident)
    out.push(
      "    if let Some(__r) = j.inline_ref(__v, |__i| Self { __id: __i, ..Default::default() }, Self::from_json_with)? {",
      "        return Ok(__r);",
      "    }"
    );
  out.push("    yr::json::get_object(__v)?;", "    let _ = &j;");
  if (ident) out.push("    let __id = j.begin_ident();");
  out.push(...indent(lines));
  if (ident) {
    out.push("    j.end_ident();");
    inits.push("__id");
  }
  if (sm.hasCache) inits.push("__cache: Default::default()");
  out.push(`    Ok(Self { ${inits.join(", ")} })`, "}");
  return out;
}

export function genUnionJson(m: Model, u: UnionModel): string[] {
  const out: string[] = [];
  out.push(`impl ${u.name} {`);
  out.push(
    "    pub fn to_json_with(&self, j: &mut yr::JsonOut) -> yr::Value {",
    "        let _ = &j;",
    "        match self {"
  );
  for (const v of u.variants) {
    out.push(
      `            Self::${v.name}(__x) => yr::json::obj(vec![("type", yr::Value::Str(${strLit(v.irName)}.to_string())), ("value", { j.push("value"); let __v = ${toJson(m, "(*__x)", v.shape)}; j.pop(); __v })]),`
    );
  }
  out.push("        }", "    }");
  out.push("    pub fn from_json_with(__v: &yr::Value, j: &mut yr::JsonIn) -> yr::Result<Self> {");
  out.push('        let __t = yr::json::get_string(yr::json::required(__v, "type")?)?;');
  out.push('        let __m = yr::json::required(__v, "value")?;');
  out.push(
    '        j.push("value");',
    "        let __r = (|| -> yr::Result<Self> {",
    "            Ok(match __t.as_str() {"
  );
  for (const v of u.variants)
    out.push(
      `                ${strLit(v.irName)} => Self::${v.name}(${fromJson(m, "__m", v.shape)}),`
    );
  out.push(
    `                _ => return Err(yr::YaffleError::input(format!("unknown union variant {__t}"))),`
  );
  out.push("            })", "        })();", "        j.pop();", "        __r", "    }", "}");
  return out;
}
