/** Rust type declarations: structs, enums, switch enums (with accessors) and union enums. */
import { indent } from "./emit.ts";
import {
  primInfo,
  type EnumModel,
  type FieldInfo,
  type Model,
  type RMember,
  type StructModel,
  type SwitchModel,
  type UnionModel
} from "./model.ts";
import { strLit } from "./names.ts";

function docLines(doc: string | undefined): string[] {
  if (!doc) return [];
  return doc.split("\n").map(l => `/// ${l}`);
}

function memberType(m: Model, mm: RMember): string {
  if (mm.k === "field") {
    const t = m.rustType(mm.info.shape);
    return mm.optional ? `Option<${t}>` : t;
  }
  return mm.optional ? `Option<${mm.sw.enumName}>` : mm.sw.enumName;
}

function memberIdent(mm: RMember): string {
  return mm.k === "field" ? mm.info.ident : mm.sw.ident;
}

export function genStructDecl(m: Model, sm: StructModel): string[] {
  const out: string[] = [];
  out.push(...docLines(sm.ir.doc));
  out.push("#[derive(Debug, Clone, PartialEq, Default)]");
  out.push(`pub struct ${sm.name} {`);
  for (const mm of sm.members) {
    if (mm.k === "field") out.push(...indent(docLines(mm.info.ir?.doc)));
    if (mm.k === "field" && !mm.info.output)
      out.push(
        "    /// A hidden stream carrier: stored for the stream, not in the JSON.",
        "    #[doc(hidden)]"
      );
    out.push(`    pub ${memberIdent(mm)}: ${memberType(m, mm)},`);
  }
  if (m.identStructs.has(sm.ir.id))
    out.push(
      "    /// The object's identity: pointers to one object share it.",
      "    #[doc(hidden)]",
      "    pub __id: yr::Ident,"
    );
  if (sm.hasCache)
    out.push(
      "    /// Original codec output, for byte-exact rebuilds.",
      "    #[doc(hidden)]",
      "    pub __cache: yr::ViaCache,"
    );
  out.push("}");
  return out;
}

/** Adds `arm` to the arms of `key`. */
function addArm<K>(out: Map<K, string[]>, key: K, arm: string): void {
  const l = out.get(key);
  if (l) l.push(arm);
  else out.set(key, [arm]);
}

/**
 * Every field reachable inside a switch's variants, with the match arms of its accessor (`mut`:
 * of its `_mut` accessor).
 */
function reachable(sw: SwitchModel, mut: boolean): Map<FieldInfo, string[]> {
  const asRef = mut ? "as_mut" : "as_ref";
  const call = (n: string) => (mut ? `${n}_mut()` : `${n}()`);
  const out = new Map<FieldInfo, string[]>();
  for (const v of sw.variants) {
    if (sw.tuple) {
      const fm = v.members[0] as Extract<RMember, { k: "field" }>;
      addArm(out, fm.info, `Self::${v.name}(__x) => Some(__x),`);
      continue;
    }
    for (const mm of v.members) {
      if (mm.k === "field") {
        const get = mm.optional ? `__x.${asRef}()` : "Some(__x)";
        addArm(out, mm.info, `Self::${v.name} { ${mm.info.ident}: __x, .. } => ${get},`);
        continue;
      }
      for (const f of reachable(mm.sw, mut).keys()) {
        const get = mm.optional
          ? `__x.${asRef}().and_then(|__s| __s.${call(f.acc)})`
          : `__x.${call(f.acc)}`;
        addArm(out, f, `Self::${v.name} { ${mm.sw.ident}: __x, .. } => ${get},`);
      }
    }
  }
  return out;
}

/** Nested switches reachable inside a switch's variants, with the match arms of their accessors. */
function reachableSwitches(sw: SwitchModel, mut: boolean): Map<SwitchModel, string[]> {
  const asRef = mut ? "as_mut" : "as_ref";
  const call = (n: string) => (mut ? `${n}_mut()` : `${n}()`);
  const out = new Map<SwitchModel, string[]>();
  if (sw.tuple) return out;
  for (const v of sw.variants) {
    for (const mm of v.members) {
      if (mm.k !== "switch") continue;
      const pat = `Self::${v.name} { ${mm.sw.ident}: __x, .. } =>`;
      addArm(out, mm.sw, `${pat} ${mm.optional ? `__x.${asRef}()` : "Some(__x)"},`);
      for (const s of reachableSwitches(mm.sw, mut).keys()) {
        const get = mm.optional
          ? `__x.${asRef}().and_then(|__s| __s.${call(s.ident)})`
          : `__x.${call(s.ident)}`;
        addArm(out, s, `${pat} ${get},`);
      }
    }
  }
  return out;
}

/** An accessor of a switch enum (`name` or `name_mut`) returning `Option<&T>`. */
function accessor(name: string, ty: string, arms: string[], partial: boolean, mut: boolean) {
  return [
    mut
      ? `pub fn ${name}_mut(&mut self) -> Option<&mut ${ty}> {`
      : `pub fn ${name}(&self) -> Option<&${ty}> {`,
    "    match self {",
    ...indent(arms, 2),
    ...(partial ? ["        _ => None,"] : []),
    "    }",
    "}"
  ];
}

export function genSwitchDecl(m: Model, sm: StructModel, sw: SwitchModel): string[] {
  const out: string[] = [];
  out.push(`/// The \`switch\` of \`${sm.name}\`.`);
  out.push("#[derive(Debug, Clone, PartialEq)]");
  out.push(`pub enum ${sw.enumName} {`);
  for (const v of sw.variants) {
    if (sw.tuple) {
      const fm = v.members[0] as Extract<RMember, { k: "field" }>;
      out.push(`    ${v.name}(${m.rustType(fm.info.shape)}),`);
    } else if (v.members.length === 0) out.push(`    ${v.name},`);
    else
      out.push(
        `    ${v.name} { ${v.members.map(mm => `${memberIdent(mm)}: ${memberType(m, mm)}`).join(", ")} },`
      );
  }
  out.push("}");
  const first = sw.variants[0];
  out.push(`impl Default for ${sw.enumName} {`, "    fn default() -> Self {");
  if (!first) out.push("        unreachable!()");
  else if (sw.tuple) out.push(`        Self::${first.name}(Default::default())`);
  else if (first.members.length === 0) out.push(`        Self::${first.name}`);
  else
    out.push(
      `        Self::${first.name} { ${first.members.map(mm => `${memberIdent(mm)}: Default::default()`).join(", ")} }`
    );
  out.push("    }", "}");
  // Accessors, and `_mut` ones: views fill fields read on demand into a scanned value.
  const acc: string[] = [];
  const fieldsMut = reachable(sw, true);
  for (const [f, arms] of reachable(sw, false)) {
    const ty = m.rustType(f.shape);
    const partial = arms.length < sw.variants.length;
    acc.push(...accessor(f.acc, ty, arms, partial, false));
    acc.push(...accessor(f.acc, ty, fieldsMut.get(f)!, partial, true));
  }
  const switchesMut = reachableSwitches(sw, true);
  for (const [s, arms] of reachableSwitches(sw, false)) {
    acc.push(...accessor(s.ident, s.enumName, arms, true, false));
    acc.push(...accessor(s.ident, s.enumName, switchesMut.get(s)!, true, true));
  }
  if (acc.length) out.push(`impl ${sw.enumName} {`, ...indent(acc), "}");
  return out;
}

export function genEnum(m: Model, e: EnumModel): string[] {
  const st = m.rustType(e.storage);
  const pi = primInfo(e.ir.storage);
  const out: string[] = [];
  out.push("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]");
  out.push(`pub enum ${e.name} {`);
  for (const v of e.variants) out.push(`    ${v.name},`);
  if (e.unknown)
    out.push(`    /// A value that is not a member (\`@open\`).`, `    ${e.unknown}(${st}),`);
  out.push("}");
  const first = e.variants[0];
  out.push(`impl Default for ${e.name} {`, "    fn default() -> Self {");
  out.push(
    first
      ? `        Self::${first.name}`
      : e.unknown
        ? `        Self::${e.unknown}(0)`
        : "        unreachable!()"
  );
  out.push("    }", "}");
  const lit = (v: string) => `${v}${st}`;
  const seen = new Set<string>();
  const fromArms: string[] = [];
  for (const v of e.variants) {
    if (seen.has(v.value)) continue;
    seen.add(v.value);
    fromArms.push(`${lit(v.value)} => Some(Self::${v.name}),`);
  }
  fromArms.push(e.unknown ? `_ => Some(Self::${e.unknown}(v)),` : "_ => None,");
  const toArms = e.variants.map(v => `Self::${v.name} => ${lit(v.value)},`);
  if (e.unknown) toArms.push(`Self::${e.unknown}(v) => v,`);
  const nameArms = e.variants.map(v => `Self::${v.name} => Some(${strLit(v.irName)}),`);
  if (e.unknown) nameArms.push(`Self::${e.unknown}(_) => None,`);
  const byName = e.variants.map(v => `${strLit(v.irName)} => return Ok(Self::${v.name}),`);
  const big = pi.bits > 48;
  const body: string[] = [
    `/// The member for a raw value${e.unknown ? " (unknown values are kept)" : ""}.`,
    `pub fn from_raw(v: ${st}) -> Option<Self> {`,
    "    match v {",
    ...indent(fromArms, 2),
    "    }",
    "}",
    `pub fn to_raw(self) -> ${st} {`,
    ...(toArms.length
      ? ["    match self {", ...indent(toArms, 2), "    }"]
      : ["    unreachable!()"]),
    "}",
    "pub fn name(self) -> Option<&'static str> {",
    ...(nameArms.length ? ["    match self {", ...indent(nameArms, 2), "    }"] : ["    None"]),
    "}",
    "pub fn to_json(self) -> yr::Value {",
    "    match self.name() {",
    "        Some(n) => yr::Value::Str(n.to_string()),",
    `        None => yr::json::${big ? "big" : "int"}(self.to_raw()),`,
    "    }",
    "}",
    "pub fn from_json(v: &yr::Value) -> yr::Result<Self> {",
    "    if let Some(s) = v.as_str() {",
    ...(byName.length
      ? ["        match s {", ...indent(byName, 3), "            _ => {}", "        }"]
      : []),
    ...(e.unknown
      ? [
          `        if !${big} || s.parse::<i128>().is_err() { return Err(yr::YaffleError::input(format!("{s:?} is not a member of ${e.name}"))); }`,
          "    }",
          `    let raw: ${st} = yr::json::get_typed_bits(v, ${pi.bits})?;`,
          `    Self::from_raw(raw).ok_or_else(|| yr::YaffleError::input(format!("{raw} is not a member of ${e.name}")))`
        ]
      : [
          `        return Err(yr::YaffleError::input(format!("{s:?} is not a member of ${e.name}")));`,
          "    }",
          `    Err(yr::YaffleError::input(format!("{v} is not a member name of ${e.name}")))`
        ]),
    "}"
  ];
  out.push(`impl ${e.name} {`, ...indent(body), "}");
  return out;
}

export function genUnionDecl(m: Model, u: UnionModel): string[] {
  const out: string[] = [];
  out.push("#[derive(Debug, Clone, PartialEq)]");
  out.push(`pub enum ${u.name} {`);
  for (const v of u.variants) out.push(`    ${v.name}(${m.rustType(v.shape)}),`);
  out.push("}");
  const first = u.variants[0];
  out.push(
    `impl Default for ${u.name} {`,
    "    fn default() -> Self {",
    first ? `        Self::${first.name}(Default::default())` : "        unreachable!()",
    "    }",
    "}"
  );
  return out;
}
