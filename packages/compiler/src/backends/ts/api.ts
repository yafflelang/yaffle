/**
 * Root API emitter: for each exported struct, `X.parse`, `X.safeParse`, `X.parseAsync`,
 * `X.serialize`, `X.serializeAsync`, `X.view`, `X.toJson`, `X.fromJson`, `X.optionsFromJson`.
 * Root parameters become options.
 */
import type { IrRoot } from "../../ir/index.ts";
import { Code, ident, prop, propKey, str, typeName } from "./code.ts";
import { constCtx } from "./expr.ts";
import type { JsonEmitter } from "./json.ts";
import type { Model } from "./model.ts";
import type { ModuleCtx } from "./module.ts";
import type { ReadEmitter } from "./read.ts";
import type { TypeEmitter } from "./types.ts";
import type { WriteEmitter } from "./write.ts";

export class ApiEmitter {
  readonly model: Model;
  readonly types: TypeEmitter;
  readonly mod: ModuleCtx;
  readonly reader: ReadEmitter;
  readonly writer: WriteEmitter;
  readonly json: JsonEmitter;

  constructor(
    model: Model,
    types: TypeEmitter,
    mod: ModuleCtx,
    reader: ReadEmitter,
    writer: WriteEmitter,
    json: JsonEmitter
  ) {
    this.model = model;
    this.types = types;
    this.mod = mod;
    this.reader = reader;
    this.writer = writer;
    this.json = json;
  }

  emitRoot(code: Code, root: IrRoot): void {
    const s = this.model.struct(root.struct);
    const sname = this.model.structName(s.id);
    const api = typeName(root.name);
    const T = this.mod.useType(s.module, sname);
    const TIn = this.mod.useType(s.module, `${sname}Input`);
    const opts = `${api}Options`;
    const params = s.params.filter(p => p.origin !== "endian" && p.origin !== "outer");
    const isAsync = s.async;
    const x = this.reader.x;

    code.block(`export interface ${opts} extends $rt.BaseOptions`, () => {
      for (const p of params) {
        const optional = p.default !== undefined ? "?" : "";
        code.line(
          `${propKey(p.boundName ?? p.name)}${optional}: ${this.types.valueType(p.type, "in")};`
        );
      }
    });
    code.line("");

    // Root parameters as locals, from the options; returns the struct's argument list.
    const prelude = (): string[] => {
      code.line(`const endian: $rt.Endian = $o.endian ?? "le";`);
      code.line(`const $le = endian === "le";`);
      code.line(`void $le;`);
      for (const p of params) {
        const key = p.boundName ?? p.name;
        let v = prop("$o", key);
        if (p.default) v = `(${v} ?? ${x.to(x.compile(p.default, constCtx(this.mod)), p.type)})`;
        else v = `$rt.req(${v}, ${str(key)})`;
        if (p.type.kind === "int" && p.type.bits > 48) v = `$rt.big(${v})`;
        code.line(`const ${ident(p.name)} = ${v};`);
      }
      return s.params.map(p => ident(p.name));
    };

    // Async structs (reaching an async codec) only have async readers and writers.
    const readFn = isAsync ? `readRootAsync_${api}` : `readRoot_${api}`;
    const writeFn = isAsync ? `writeRootAsync_${api}` : `writeRoot_${api}`;
    const promise = (t: string): string => (isAsync ? `Promise<${t}>` : t);
    const fnHead = isAsync ? "async function" : "function";
    code.block(`${fnHead} ${readFn}($r: $rt.Reader, $o: ${opts}): ${promise(T)}`, () => {
      prelude();
      code.line(`return ${this.reader.rootRead(code, s, isAsync)};`);
    });
    code.block(
      `${fnHead} ${writeFn}($w: $rt.Writer, $value: ${TIn}, $o: ${opts}): ${promise("$rt.LStruct | void")}`,
      () => {
        prelude();
        const l = this.writer.rootWrite(code, s, "$value", isAsync);
        code.line(l ? `return ${l};` : "return;");
      }
    );
    const layout = s.base ? "undefined" : this.writer.layoutConst(s);

    // View spec: the root's descriptor, arguments and writer (for $commit).
    code.block(`function viewSpec_${api}($o: ${opts}): $rt.ViewSpec`, () => {
      const args = prelude();
      code.line("return {");
      code.indent(() => {
        code.line(`info: ${this.mod.structFn(s.id, "$view")},`);
        code.line(`args: [${args.join(", ")}],`);
        code.line(`strict: $o.strict ?? false,`);
        code.line(`layout: ${layout},`);
        if (isAsync) {
          // Async formats commit structural edits through async views (`await $commit()`).
          code.line(
            `write: () => $rt.fail("INPUT", "this format has async codecs: commit through an async view"),`
          );
          code.line(`writeAsync: ($w, $value) => ${writeFn}($w, $value as ${TIn}, $o),`);
        } else {
          code.line(`write: ($w, $value) => ${writeFn}($w, $value as ${TIn}, $o),`);
        }
      });
      code.line("};");
    });

    const method = (head: string, body: string): void => {
      code.block(head, () => code.line(body), ",");
    };
    const withOptions = (body: string): string => `const $o = $rt.options(options);\n${body}`;
    code.line(
      `/** ${s.doc ? s.doc.replace(/\*\//g, "*\\/") : `Entry points for ${root.name}.`} */`
    );
    code.block(
      `export const ${api} =`,
      () => {
        if (!isAsync) {
          method(
            `parse(source: $rt.SyncInput, options?: ${opts}): ${T}`,
            withOptions(`return $rt.parseWith(source, $o, ($r) => ${readFn}($r, $o));`)
          );
          method(
            `safeParse(source: $rt.SyncInput, options?: ${opts}): $rt.SafeResult<${T}>`,
            `return $rt.safe(() => ${api}.parse(source, options));`
          );
        }
        method(
          `parseAsync(source: $rt.Source, options?: ${opts}): Promise<${T}>`,
          withOptions(`return $rt.parseWithAsync(source, $o, ($r) => ${readFn}($r, $o));`)
        );
        method(
          `safeParseAsync(source: $rt.Source, options?: ${opts}): Promise<$rt.SafeResult<${T}>>`,
          `return $rt.safeAsync(() => ${api}.parseAsync(source, options));`
        );
        const serialize = `$rt.serializeWith${isAsync ? "Async" : ""}(${layout}, ($w) => ${writeFn}($w, value, $o))`;
        if (!isAsync) {
          method(
            `serialize(value: ${TIn}, options?: ${opts}): Uint8Array`,
            withOptions(`return ${serialize};`)
          );
        }
        method(
          `serializeAsync(value: ${TIn}, options?: ${opts}): Promise<Uint8Array>`,
          withOptions(
            isAsync ? `return ${serialize};` : `return Promise.resolve().then(() => ${serialize});`
          )
        );
        if (!isAsync) {
          code.line(
            `/** A lazy view: sync for byte arrays and sync sources, async for async sources. */`
          );
          code.line(
            `view: ((source: $rt.Source, options?: ${opts}) => $rt.openView(source, viewSpec_${api}($rt.options(options)))) as {`
          );
          code.indent(() => {
            // The sync overload comes last, so inference from `typeof X.view` sees it.
            code.line(`(source: $rt.AsyncSource, options?: ${opts}): $rt.AsyncView<${T}>;`);
            code.line(`(source: $rt.SyncInput, options?: ${opts}): $rt.View<${T}>;`);
          });
          code.line("},");
        }
        method(
          `viewAsync(source: $rt.Source, options?: ${opts}): $rt.AsyncView<${T}>`,
          `return $rt.openAsyncView(source, viewSpec_${api}($rt.options(options))) as $rt.AsyncView<${T}>;`
        );
        if (isAsync) {
          method(
            `view(source: $rt.Source, options?: ${opts}): $rt.AsyncView<${T}>`,
            `return ${api}.viewAsync(source, options);`
          );
        }
        method(
          `toJson(value: ${T}): unknown`,
          `return ${this.mod.structFn(s.id, "toJson")}(value, new $rt.ToJsonCtx(), "");`
        );
        method(
          `fromJson(json: unknown): ${TIn}`,
          `return ${this.mod.structFn(s.id, "fromJson")}(json, new $rt.FromJsonCtx(), "");`
        );
        code.block(
          `optionsFromJson(json: unknown): ${opts}`,
          () => {
            code.line(`const $s = json === undefined ? {} : $rt.objectFromJson(json);`);
            code.line(`const $o: { [key: string]: unknown } = {};`);
            code.line(`const $c = new $rt.FromJsonCtx();`);
            code.line(`void $c;`);
            code.line(`if ($s.endian !== undefined) $o.endian = $rt.stringFromJson($s.endian);`);
            code.line(`if ($s.strict !== undefined) $o.strict = $rt.boolFromJson($s.strict);`);
            for (const p of params) {
              const key = p.boundName ?? p.name;
              const j = prop("$s", key);
              code.line(
                `if (${j} !== undefined) ${prop("$o", key)} = ${this.json.valueFromJson(p.type, j, `$rt.ptr("", ${str(key)})`)};`
              );
            }
            code.line(`return $o as unknown as ${opts};`);
          },
          ","
        );
        code.line(`/** Static information about the format. */`);
        code.line(`info: { name: ${str(root.name)}, async: ${isAsync} },`);
      },
      ";"
    );
  }
}
