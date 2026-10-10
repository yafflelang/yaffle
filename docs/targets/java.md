# Java target

The Java backend (`packages/compiler/src/backends/java`) turns the IR into Java 21 sources that use
the runtime in `packages/runtime-java` (package `org.yafflelang.runtime`, no dependencies; Maven
coordinates `org.yafflelang:yaffle-runtime`). Generated code and the runtime compile with
`javac -Xlint:all -Werror`.

## Generated API

Every struct, enum and union type becomes one file in one package (`targets.java.package`,
default `yaffle.gen`). An exported struct also gets the root API:

```java
// export struct Doc(u32 version) { … }  →  yaffle/gen/Doc.java
Doc d = Doc.parse(bytes, new Doc.Options().version(2));     // Options: endian, strict, root params
byte[] out = Doc.serialize(d, new Doc.Options().version(2));
SafeResult<Doc> r = Doc.safeParse(bytes, options);          // Ok(value) | Err(YaffleException)
CompletableFuture<Doc> f = Doc.parseAsync(bytes, options);  // also serializeAsync, parseAsync(AsyncSource)
Object json = Doc.toJson(d);                                // Map/List/String/Long/Double/Boolean/null
Doc back = Doc.fromJson(json);
Doc.Options o = Doc.Options.fromJson(argsJson);

Doc.View v = Doc.view(bytes);                               // also view(Source, options)
v.getEntries().get(3).setAlign(0x200);                      // same size: patched in place
v.getEntries().add(Entry.View.of(newEntry));                // structural edit
List<Patch> ps = v.patches();                               // [{at, remove, insert}]
byte[] committed = v.commit(Layout.Grow.SPLICE);            // DEFAULT | APPEND | SPLICE | ERROR

AsyncView<Doc.View> av = Doc.viewAsync(AsyncSource.of(asyncChannel), options);
long size = av.get(w -> w.getEntries().get(3).getSize()).join();
av.set(w -> w.getEntries().get(2).setHandler(5)).join();
byte[] out2 = av.commit().join();
```

Schemas with an async codec get `parseAsync` and `serializeAsync` instead of `parse`, `safeParse`
and `serialize`. `parse` and `serialize` without options use the defaults. Errors are
`YaffleException`s with a stable `ErrorCode`, a path (field names and indices) and a byte offset
(-1 on write).

Struct classes are `public final` with public fields: one class is both the parse result and the
serialize input (derived and computed fields are filled by `parse` and ignored by `serialize`). They
implement `YValue` (`toJsonValue()`, what `==` on composite values compares) and have a nested
`View` class. `@hidden` fields are package-private `$name` fields.

### Type mapping

| yaffle                                          | Java                                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `u8` `u16` `u24` `i8` `i16` `i24` `i32`         | `int`                                                                               |
| `u32` `u40` `u48` `u56` `i40` `i48` `i56` `i64` | `long`                                                                              |
| `u64`                                           | `long` holding the unsigned bit pattern (JSON and expressions treat it as unsigned) |
| `f16`, `f64` / `f32`                            | `double` / `float`                                                                  |
| `bool`, strings                                 | `boolean`, `String`                                                                 |
| `u8` arrays, other arrays                       | `byte[]`, `List<T>` (boxed elements)                                                |
| pointers                                        | the target type (boxed when nullable)                                               |
| closed enum                                     | Java `enum` implementing `YEnum` (`value()`, `member()`, `fromValue`, `fromMember`) |
| open enum                                       | `record E(long value, String member)` with constants and `E.of(v)`                  |
| union `A \| B`                                  | `sealed interface AOrB` with one `record` per variant (named after the variants)    |
| conditional fields, optional inputs             | boxed and nullable                                                                  |
| one-way transform                               | the value in `name`, the raw value (written, and shown in JSON) in `nameRaw`        |

Switch cases flatten into the struct's fields (nullable), like the canonical JSON. A field with
different Java types in different branches is an `Object`. A conditional nullable pointer has a
presence flag, so a taken branch with a null pointer is `null` in JSON and an untaken one has no key.

Names: keywords get a `_` suffix (open-enum constants named `value`/`member` too). User types keep
their names; generated code refers to JDK, `java.lang` and runtime classes by simple name only when
no user type shadows them, and fully qualified otherwise. The options class is `Options`, or
`Options_` if a user type is called `Options`.

## Generator structure

| File                                           | Role                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `index.ts`                                     | entry point, extern resolution, `inlineRuntime`                                             |
| `code.ts`, `ctx.ts`                            | the indented code builder; per-class imports, hoisted constants, extern references          |
| `model.ts`                                     | lookups, Java names and types, field tables, static sizes, placeables, type keys            |
| `analysis.ts`                                  | IR traversals (`forEachMember`, read-side expressions, extents, `$index` use, layouts)      |
| `expr.ts`                                      | expressions with interval analysis: `long` when the result provably fits, else `BigInteger` |
| `emitter.ts`                                   | what the reader and writer share (contexts, arguments, fills, `if`/`switch`)                |
| `read.ts`, `write.ts`                          | `read`/`scan` and `write` methods per struct                                                |
| `json.ts`                                      | canonical JSON (`toJson`/`fromJson`)                                                        |
| `views.ts`, `viewclass.ts`                     | view analyses, the `INFO` descriptor and the `View` class                                   |
| `classes.ts`                                   | assembles struct, enum and union files and the root API                                     |
| `toolchain.ts`, `conformance.ts`, `harness.ts` | JDK and javac helpers, the conformance adapter and its Java harness                         |

Java lambdas only capture effectively final locals, so generated code keeps mutable state in
objects: the error path in a `Frame`, read-side extents in an `int[]`, write-side extents in
`Extent` objects created up front.

## Runtime structure

| Area            | Classes                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| reading         | `Reader` (bounds, windows, padding, strings, identity of targets, unions), `Bytes`, `Encoding`                                                  |
| writing         | `Writer` (relocation writer), `Block`, `Region`, `Placeable`, `Extent`, `Fixup`                                                                 |
| layout          | `Layout` (default order, `layout { … }` items, groups, fixed placements, sticky layout), `LayoutItem`, `LStruct`, `LArray`                      |
| values          | `Ints` (integer semantics), `Lists` (derived arrays), `Prim`, `Rt` (helpers for generated code)                                                 |
| codecs, streams | `Codecs` (host calls, codec reuse), `Streams` (join, slice, split, slice carriers), `Leb128`                                                    |
| JSON            | `Canon`, `Json`, `Hex`, `ToJsonCtx`, `FromJsonCtx`                                                                                              |
| views           | `ViewRoot`, `ViewNode`, `ViewScan`, `ViewSpace`, `Store`, `ListView`, `StructView`, `StructInfo`, `Commit`, `ViewConv`, `ViewRead`, `AsyncView` |
| entry points    | `Api`, `SafeResult`, `YaffleException`, `ErrorCode`, `Source`, `AsyncSource`                                                                    |

Serialization encodes bottom-up into blocks with fixups; each base region is laid out when it is
complete, then assembled, then the fixups run. A value decoded through a codec remembers its
encoded bytes, so serializing it unchanged reuses them (byte-exact rebuilds of lossy codecs).

## Views and async

A generated `scan` method reads a struct's scalars into a plain object and records byte ranges;
composite fields become view values: child nodes, `ListView`s, lazy bytes, lazy pointer targets,
codec regions decoded on access and lazy streams. Fields that later expressions need are read
eagerly. Setters patch the source in place when the new encoding has the same size and nothing
depends on the field; anything else is a structural edit. `commit()` returns the in-place patches
directly when it can. Otherwise it turns the view into a plain value (unchanged parts read from
the source), re-encodes it with the generated writer under the sticky layout (targets keep their
positions where the grow policy allows) and diffs the result into patches.

Byte spaces can be lazy: a `Store` loads 64 KiB blocks of a `Source` or `AsyncSource`, decodes a
`@ranged` codec region block by block, or decodes the pieces of an `arr[*].field` stream only when a
read touches them (when the pieces' lengths are known from size fields).

Generated readers and writers are synchronous. `parseAsync`, `serializeAsync` and the accesses of an
`AsyncView` run on virtual threads; an async codec's future or a missing block is awaited there,
which parks the virtual thread. Accesses of one async view run in order. The typed view
(`av.view()`) can also be used directly; reads then wait on the calling thread.

## Host interfaces

| Extern                     | Host implementation                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `extern fn f(T a, …) -> R` | `public static R f(T a, …)` (integers as their Java type, `u8[]` → `byte[]`, `char[]` → `String`) |
| `extern codec c(args)`     | a static field implementing `Codec`: `decode(byte[], CodecCtx)`, `encode(byte[], CodecCtx)`       |
| `@streaming` codec         | also `decodeStreaming(byte[], CodecCtx)` returning `Decoded(output, consumed)`                    |
| `@ranged` codec            | called on any slice of the region; `CodecCtx.position()` is the slice's offset                    |
| `extern async codec`       | `AsyncCodec`: the same methods returning `CompletableFuture`s                                     |
| `extern type X(args) : T`  | `ExternType<T>`: `size(byte[], Object...)` (-1: need more bytes), `read`, `write`                 |

`CodecCtx` carries the arguments (boxed: `u8` → `Integer`, `u64` → `Long` bit pattern, `u8[n]` →
`byte[]`) and `outputSize()` (-1 when unknown). Host exceptions become `CODEC` errors.

`targets.java.externs` in `yaffle.json` maps extern names to `path/file.java[#ITEM]` (the file is
copied into the output under its public class's name; ITEM defaults to the extern's name) or to a
class on the classpath, `com.example.Host[#ITEM]`. Relative paths resolve against
`targets.java.externsRoot` when set. `targets.java.dependencies` lists Maven jars
(`{"io.airlift:aircompressor": "2.0.2"}`) the conformance adapter and tests download.

The conformance externs are in `conformance/externs/java`.

## Tests

JDK 21 comes from `JAVA_HOME`, `PATH` or `nix shell nixpkgs#jdk21` (its location is cached).
`YAFFLE_JAVA_CACHE` (default `$TMPDIR/yaffle-java-cache`) holds the compiled runtime, keyed by a
hash of its sources, and downloaded jars; `YAFFLE_JAVA_TEST_DIR` (default
`$TMPDIR/yaffle-java-tests`) holds the test programs. Use private directories when several
checkouts run tests at once.

```sh
# conformance, parse and view mode (java, java:view)
node --max-old-space-size=12000 --conditions=development conformance/src/cli.ts --targets java
# backend tests: API, views, lazy and async views, IR features, a view property test,
# -Werror compilation of every conformance schema, and the runtime unit tests
npx vitest run --project yaffle packages/compiler/test/backends/java
# runtime unit tests on their own (a self-contained runner, no JUnit)
nix shell nixpkgs#jdk21 --command packages/runtime-java/build.sh test
```

The conformance adapter generates the case directory's program, a harness that runs every case in
one JVM, compiles both with `-Xlint:all -Werror` and judges what the harness observed. In view mode
the harness reads every field through the view (`ViewRead.materialize`) and commits without edits;
`{ file }` cases go through `viewAsync` over an `AsynchronousFileChannel`.

## Known gaps

- Piece streams whose piece lengths aren't known from size fields decode every piece on first
  access.
- A `from` stream over a single bytes field forces the whole field (a `@ranged` source region is
  still decoded block by block, but all of it).
- Derived and computed fields of an edited view node are stale until `commit()`; computed fields
  can't read derived fields of array elements.
- Fields of the same Java type but different JSON rules in different branches (`u32` and `u64`,
  both `long`) use the first branch's JSON rule.
- In views, edits inside codec regions and streams are always structural, and getters of eagerly
  read fields return detached views.
- A layout on the root struct of a codec's decoded side or a stream is ignored at that level.
- Unions are named after their variants (`AOrB`): the IR has no union names.
- `yaffle build` passes extern paths relative to the output directory without the directory
  itself; the backend falls back to the current directory and its ancestors (or
  `targets.java.externsRoot`).
