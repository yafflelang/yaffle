/**
 * Root API emitter: for each exported struct, methods on its dataclass (`X.parse`,
 * `X.safe_parse`, `X.parse_async`, `x.serialize()`, `x.serialize_async()`, `x.to_json()`,
 * `X.from_json`, `X.options_from_json`, `X.view`, `X.view_async`) plus module-level root reader
 * and writer functions. Root parameters become keyword arguments.
 */
import type { IrParam, IrRoot, IrStruct } from "../../ir/index.ts";
import { pyStr, pyTuple, type Code } from "./code.ts";
import { detachedCtx, type ExprCompiler } from "./expr.ts";
import type { JsonEmitter } from "./json.ts";
import type { Model } from "./model.ts";
import type { ModuleCtx } from "./module.ts";
import type { Names } from "./names.ts";
import type { ReadEmitter } from "./read.ts";
import type { TypeEmitter } from "./types.ts";
import type { WriteEmitter } from "./write.ts";

export interface ApiDeps {
  model: Model;
  names: Names;
  x: ExprCompiler;
  types: TypeEmitter;
  mod: ModuleCtx;
  reader: ReadEmitter;
  writer: WriteEmitter;
  json: JsonEmitter;
}

export class ApiEmitter {
  private readonly model: Model;
  private readonly names: Names;
  private readonly x: ExprCompiler;
  private readonly types: TypeEmitter;
  private readonly mod: ModuleCtx;
  private readonly reader: ReadEmitter;
  private readonly writer: WriteEmitter;
  private readonly json: JsonEmitter;

  constructor(deps: ApiDeps) {
    this.model = deps.model;
    this.names = deps.names;
    this.x = deps.x;
    this.types = deps.types;
    this.mod = deps.mod;
    this.reader = deps.reader;
    this.writer = deps.writer;
    this.json = deps.json;
  }

  /** Module-level root reader and writer functions. */
  emitFunctions(code: Code, s: IrStruct): void {
    const cls = this.names.structClass(s.id);
    const params = this.types.params(s);
    const sig = (head: string): string => [head, ...params].join(", ");
    const a = s.async ? "async " : "";
    const suffix = s.async ? "async_" : "";
    code.block(`${a}def _read_root_${suffix}${cls}(${sig("_r: _rt.Reader")}) -> ${cls}`, () => {
      code.line(`_le = endian == "le"`);
      code.line(`return ${this.reader.rootRead(code, s, s.async)}`);
    });
    code.line("");
    code.block(
      `${a}def _write_root_${suffix}${cls}(${sig("_w: _rt.Writer, _value: _t.Any")}) -> _t.Any`,
      () => {
        code.line(`_le = endian == "le"`);
        code.line(`return ${this.writer.rootWrite(code, s, "_value", s.async) ?? "None"}`);
      }
    );
    code.line("");
  }

  /** Methods of a root's dataclass. */
  emitMethods(code: Code, root: IrRoot): void {
    const s = this.model.struct(root.struct);
    const cls = this.names.structClass(s.id);
    const params = s.params.filter(p => p.origin !== "endian" && p.origin !== "outer");
    const isAsync = s.async;
    const layout = s.base ? "None" : this.writer.layoutConst(s);
    const option = (p: IrParam): string => this.names.option(p);
    const kw = (withStrict: boolean): string => {
      const parts = ['endian: _t.Literal["le", "be"] = "le"'];
      if (withStrict) parts.push("strict: bool = False");
      for (const p of params) {
        const hint = this.types.valueType(p.type);
        parts.push(p.default ? `${option(p)}: ${hint} | None = None` : `${option(p)}: ${hint}`);
      }
      return parts.join(", ");
    };
    /** Emits the locals from the options (endian, parameter defaults); returns the root args. */
    const prelude = (): string[] => {
      code.line(`endian = _rt.endian_option(endian)`);
      for (const p of params) {
        if (!p.default) continue;
        const d = this.x.compile(p.default, { ...detachedCtx(), ...this.mod.exprBase() });
        code.line(`if ${option(p)} is None: ${option(p)} = ${this.x.to(d, p.type)}`);
      }
      return s.params.map(p =>
        p.origin === "endian" ? "endian" : p.origin === "outer" ? "None" : option(p)
      );
    };
    const forward = [
      "endian=endian",
      "strict=strict",
      ...params.map(p => `${option(p)}=${option(p)}`)
    ].join(", ");
    const asyncSuffix = isAsync ? "async_" : "";
    const readFn = `_read_root_${asyncSuffix}${cls}`;
    const writeFn = `_write_root_${asyncSuffix}${cls}`;
    const read = (args: string[]): string => `lambda _r: ${readFn}(${["_r", ...args].join(", ")})`;
    const write = (args: string[]): string =>
      `lambda _w: ${writeFn}(${["_w", "self", ...args].join(", ")})`;
    const method = (head: string, body: () => void, classmethod = true): void => {
      if (classmethod) code.line("@classmethod");
      code.block(head, body);
      code.line("");
    };
    const doc = (text: string): void => {
      code.line(`"""${text}"""`);
    };

    if (!isAsync) {
      method(`def parse(cls, source: _rt.Source, *, ${kw(true)}) -> ${cls}`, () => {
        doc(`Parses a ${root.name} from bytes or a sync source.`);
        code.line(`return _rt.parse_with(source, strict, ${read(prelude())})`);
      });
      method(
        `def safe_parse(cls, source: _rt.Source, *, ${kw(true)}) -> _rt.SafeResult[${cls}]`,
        () => {
          doc("Like `parse`, but returns a SafeResult instead of raising YaffleError.");
          code.line(`return _rt.safe(lambda: cls.parse(source, ${forward}))`);
        }
      );
    }
    method(`async def parse_async(cls, source: _rt.Source, *, ${kw(true)}) -> ${cls}`, () => {
      doc(`Parses a ${root.name} from bytes or any (sync or async) source.`);
      code.line(
        `return _t.cast(${cls}, await _rt.parse_with_async(source, strict, ${read(prelude())}))`
      );
    });
    method(
      `async def safe_parse_async(cls, source: _rt.Source, *, ${kw(true)}) -> _rt.SafeResult[${cls}]`,
      () => code.line(`return await _rt.safe_async(lambda: cls.parse_async(source, ${forward}))`)
    );
    if (!isAsync) {
      method(
        `def serialize(self, *, ${kw(false)}) -> bytes`,
        () => {
          doc(
            "Encodes this value (derived and computed fields are recomputed; inputs are checked)."
          );
          code.line(`return _rt.serialize_with(${layout}, ${write(prelude())})`);
        },
        false
      );
    }
    method(
      `async def serialize_async(self, *, ${kw(false)}) -> bytes`,
      () => {
        const w = write(prelude());
        code.line(
          isAsync
            ? `return await _rt.serialize_with_async(${layout}, ${w})`
            : `return _rt.serialize_with(${layout}, ${w})`
        );
      },
      false
    );
    // Views: sync over bytes and sync sources, async over async sources (and for async roots).
    const spec = (args: string[]): string => {
      const writer = `lambda _w, _value: ${writeFn}(${["_w", "_value", ...args].join(", ")})`;
      const [sync, async] = isAsync ? ["None", writer] : [writer, "None"];
      return `_rt.RootSpec(${this.mod.structFn(s.id, "view")}, ${pyTuple(args)}, strict, ${layout}, ${sync}, ${async}, cls.to_json)`;
    };
    method(`def view(cls, source: _rt.Source, *, ${kw(true)}) -> _t.Any`, () => {
      doc(
        isAsync
          ? `An async view of a ${root.name} (it reaches an async codec): awaitable chains.`
          : `A lazy, editable view of a ${root.name}: sync over bytes and sync sources, async over async sources.`
      );
      code.line(`return _rt.open_view(source, ${spec(prelude())})`);
    });
    method(`def view_async(cls, source: _rt.Source, *, ${kw(true)}) -> _rt.AsyncChain`, () => {
      doc(`An async view of a ${root.name} over any source: every chain is awaitable.`);
      code.line(`return _rt.open_async_view(source, ${spec(prelude())})`);
    });
    method(
      `def to_json(self) -> _t.Any`,
      () => {
        doc("Canonical JSON.");
        code.line(`return ${this.mod.structFn(s.id, "to_json")}(self, _rt.ToJsonCtx(), "")`);
      },
      false
    );
    method(`def from_json(cls, json: _t.Any) -> ${cls}`, () => {
      doc("A value from canonical JSON (shared targets via `$ref`).");
      code.line(`return ${this.mod.structFn(s.id, "from_json")}(json, _rt.FromJsonCtx(), "")`);
    });
    code.line("@classmethod");
    code.block(`def options_from_json(cls, json: _t.Any) -> dict[str, _t.Any]`, () => {
      doc("Keyword arguments for parse/serialize from canonical JSON root arguments.");
      code.line(`_s = {} if json is None else _rt.object_from_json(json)`);
      code.line(`_o: dict[str, _t.Any] = {}`);
      code.line(`_c = _rt.FromJsonCtx()`);
      code.line(`if "endian" in _s: _o["endian"] = _rt.endian_option(_s["endian"])`);
      code.line(`if "strict" in _s: _o["strict"] = _rt.bool_from_json(_s["strict"])`);
      for (const p of params) {
        const key = pyStr(p.boundName ?? p.name);
        const v = this.json.valueFromJson(p.type, `_s[${key}]`, `_rt.ptr("", ${key})`);
        code.line(`if ${key} in _s: _o[${pyStr(option(p))}] = ${v}`);
      }
      code.line("return _o");
    });
  }
}
