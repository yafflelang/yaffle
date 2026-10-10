/**
 * The yaffle TextMate grammar (scope `source.yaffle`), authored in TypeScript so regexes are
 * readable: `scripts/build.ts` writes it to `syntaxes/yaffle.tmLanguage.json`, and a test checks
 * the committed JSON is up to date.
 *
 * Structure: declarations (struct/union/enum/bits/type/extern/const/import/layout) and fields
 * live in `#statements`; everything that is an expression (lengths, `= formulas`, `as`, `where`,
 * `in`, `at`, `from`, attribute arguments) is tokenized by `#expression` inside its own region,
 * so `rows * cols` in a formula is never mistaken for a pointer field declaration.
 */

export interface Capture {
  name?: string;
  patterns?: Rule[];
}

export interface Rule {
  comment?: string;
  name?: string;
  contentName?: string;
  match?: string;
  begin?: string;
  end?: string;
  captures?: Record<string, Capture>;
  beginCaptures?: Record<string, Capture>;
  endCaptures?: Record<string, Capture>;
  patterns?: Rule[];
  include?: string;
}

export interface Grammar {
  $schema: string;
  name: string;
  scopeName: string;
  fileTypes: string[];
  patterns: Rule[];
  repository: Record<string, Rule>;
}

const inc = (name: string): Rule => ({ include: `#${name}` });
const s = (r: RegExp): string => r.source;

/** Identifier. */
const ID = String.raw`[A-Za-z_][A-Za-z0-9_]*`;

/** Words that can never be a type or a field name. */
const RESERVED = [
  "struct",
  "union",
  "enum",
  "bits",
  "type",
  "extern",
  "codec",
  "const",
  "import",
  "export",
  "layout",
  "switch",
  "case",
  "default",
  "if",
  "else",
  "at",
  "from",
  "as",
  "in",
  "where",
  "until",
  "fn",
  "async",
  "virtual"
].join("|");

const PRIMITIVE = String.raw`\b(?:[ui](?:8|16|24|32|40|48|56|64)|f(?:16|32|64)|bool|char(?:16|32)?|str(?:16|32)?)(?:le|be)?\b`;
const BUILTIN_TYPE = String.raw`\b(?:uleb128|sleb128)\b`;

/** One level of nested generic arguments: `<T>`, `<Span<T>, u8>`. */
const GENERIC_ARGS = String.raw`<(?:[^<>]|<[^<>]*>)*>`;
/** Two levels of nested parentheses: `(16)`, `(n: f(x))`. */
const CALL_ARGS = String.raw`\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)`;
/** Words that end a declaration, so they can never be its name (`type`, `bits`… can be). */
const CLAUSE_WORDS = "in|as|where|at|from|until";
/** What may follow a declared field or parameter name. */
const AFTER_NAME = String.raw`(?=\s*(?:[\[:=@;,)}]|\?=|\/\/|\/\*|$)|\s+(?:in|as|where|at|from)\b|\s+[A-Za-z_$*])`;

/** Type, optional generic args, optional type args, optional pointer star, then the name. */
function declaration(nameScope: string): Rule {
  return {
    comment: `A declaration: Type<Args>(args) *name — the name is a ${nameScope}`,
    match: [
      String.raw`\b(?!(?:${RESERVED})\b)((?:${ID}\s*\.\s*)*${ID})`, // 1 type
      String.raw`(\s*${GENERIC_ARGS})?`, // 2 generic args
      String.raw`(\s*${CALL_ARGS})?`, // 3 type args
      String.raw`\s*(\*\s*)?`, // 4 pointer
      String.raw`(?!(?:${CLAUSE_WORDS})\b)(\$?${ID})`, // 5 name
      AFTER_NAME
    ].join(""),
    captures: {
      "1": { patterns: [inc("type-name")] },
      "2": { patterns: [inc("type-arguments")] },
      "3": { patterns: [inc("call-parens")] },
      "4": { name: "keyword.operator.pointer.yaffle" },
      "5": {
        patterns: [inc("bound-values"), { match: s(/.+/), name: nameScope }]
      }
    }
  };
}

/**
 * The start of another field on the same line (`u32 tag = 'ARCV'  u64 big = 1`): two identifiers
 * in a row never occur inside an expression. The pair must be followed by what ends a
 * declaration, so in `rows * cols u8 y` the field is `u8 y`. (Pointer fields are left out:
 * `rows * cols` is an expression.)
 */
const NEXT_FIELD = String.raw`(?=\s+(?!(?:${CLAUSE_WORDS})\b)${ID}(?:\s*${GENERIC_ARGS})?(?:\s*${CALL_ARGS})?\s+\$?(?!(?:${CLAUSE_WORDS})\b)${ID}(?:\s*(?:[\[:=@;,)}]|\?=|\/\/|\/\*|$)|\s+(?:${CLAUSE_WORDS})\b))`;

/**
 * End of a one-line clause: before an attribute, `;`, `}`, a comment, the next field, or at end
 * of line.
 */
const CLAUSE_END = String.raw`(?=[@;}]|\/\/|\/\*)|${NEXT_FIELD}|$`;

function clause(keyword: string, scope: string): Rule {
  return {
    begin: String.raw`\b(${keyword})\b`,
    beginCaptures: { "1": { name: scope } },
    end: CLAUSE_END,
    name: `meta.clause.${keyword}.yaffle`,
    patterns: [inc("expression")]
  };
}

export const grammar: Grammar = {
  $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
  name: "yaffle",
  scopeName: "source.yaffle",
  fileTypes: ["yfl"],
  patterns: [inc("statements")],
  repository: {
    statements: {
      patterns: [
        inc("comments"),
        inc("import"),
        inc("export"),
        inc("const"),
        inc("extern"),
        inc("struct"),
        inc("union"),
        inc("enum"),
        inc("bits"),
        inc("type-declaration"),
        inc("layout"),
        inc("control"),
        inc("attributes"),
        inc("field-clauses"),
        inc("virtual"),
        inc("field-declaration"),
        inc("block"),
        inc("brackets"),
        inc("parens"),
        inc("strings"),
        inc("numbers"),
        inc("bound-values"),
        inc("primitive-types"),
        { match: s(/(:)(?!:)/), captures: { "1": { name: "punctuation.separator.colon.yaffle" } } },
        { match: s(/\*/), name: "keyword.operator.pointer.yaffle" },
        { match: s(/;/), name: "punctuation.terminator.statement.yaffle" },
        { match: s(/,/), name: "punctuation.separator.comma.yaffle" },
        { match: String.raw`\b${ID}\b`, name: "entity.name.type.yaffle" }
      ]
    },

    // -----------------------------------------------------------------------------------------
    // Comments

    comments: {
      patterns: [
        {
          name: "comment.block.documentation.yaffle",
          begin: s(/\/\*\*(?!\/)/),
          end: s(/\*\//),
          beginCaptures: { "0": { name: "punctuation.definition.comment.begin.yaffle" } },
          endCaptures: { "0": { name: "punctuation.definition.comment.end.yaffle" } }
        },
        {
          name: "comment.block.yaffle",
          begin: s(/\/\*/),
          end: s(/\*\//),
          beginCaptures: { "0": { name: "punctuation.definition.comment.begin.yaffle" } },
          endCaptures: { "0": { name: "punctuation.definition.comment.end.yaffle" } }
        },
        {
          name: "comment.line.double-slash.yaffle",
          begin: s(/\/\//),
          end: "$",
          beginCaptures: { "0": { name: "punctuation.definition.comment.yaffle" } }
        }
      ]
    },

    // -----------------------------------------------------------------------------------------
    // Declarations

    import: {
      name: "meta.import.yaffle",
      begin: s(/\b(import)\b/),
      beginCaptures: { "1": { name: "keyword.control.import.yaffle" } },
      end: s(/$|;/),
      endCaptures: { "0": { name: "punctuation.terminator.statement.yaffle" } },
      patterns: [
        inc("comments"),
        {
          begin: s(/\{/),
          end: s(/\}/),
          beginCaptures: { "0": { name: "punctuation.definition.block.begin.yaffle" } },
          endCaptures: { "0": { name: "punctuation.definition.block.end.yaffle" } },
          patterns: [
            inc("comments"),
            {
              match: String.raw`\b(as)\s+(${ID})`,
              captures: {
                "1": { name: "keyword.control.as.yaffle" },
                "2": { name: "variable.other.readwrite.alias.yaffle" }
              }
            },
            { match: String.raw`\b${ID}\b`, name: "variable.other.readwrite.alias.yaffle" },
            { match: s(/,/), name: "punctuation.separator.comma.yaffle" }
          ]
        },
        {
          match: String.raw`(\*)\s*\b(as)\s+(${ID})`,
          captures: {
            "1": { name: "constant.language.import-export-all.yaffle" },
            "2": { name: "keyword.control.as.yaffle" },
            "3": { name: "entity.name.namespace.yaffle" }
          }
        },
        { match: s(/\bfrom\b/), name: "keyword.control.from.yaffle" },
        inc("string-double")
      ]
    },

    export: {
      match: s(/\bexport\b/),
      name: "keyword.control.export.yaffle"
    },

    const: {
      name: "meta.const.yaffle",
      begin: String.raw`\b(const)\s+(${ID})\s+(${ID})`,
      beginCaptures: {
        "1": { name: "storage.modifier.const.yaffle" },
        "2": { patterns: [inc("type-name")] },
        "3": { name: "variable.other.constant.yaffle" }
      },
      end: s(/(?=;|\/\/|\/\*)|$/),
      patterns: [{ match: s(/=/), name: "keyword.operator.assignment.yaffle" }, inc("expression")]
    },

    extern: {
      patterns: [
        { match: s(/\bextern\b/), name: "storage.modifier.extern.yaffle" },
        { match: s(/\basync\b/), name: "storage.modifier.async.yaffle" },
        {
          comment: "extern fn name(params) -> Type",
          name: "meta.function.yaffle",
          begin: String.raw`\b(fn)\s+(${ID})`,
          beginCaptures: {
            "1": { name: "storage.type.function.yaffle" },
            "2": { name: "entity.name.function.yaffle" }
          },
          end: s(/(?=;|\/\/|\/\*)|$/),
          patterns: [
            inc("comments"),
            inc("parameters"),
            { match: s(/->/), name: "keyword.operator.arrow.yaffle" },
            inc("attributes"),
            inc("brackets"),
            inc("type-name")
          ]
        },
        {
          comment: "extern codec name(params) @attrs",
          name: "meta.codec.yaffle",
          begin: String.raw`\b(codec)\s+(${ID})`,
          beginCaptures: {
            "1": { name: "storage.type.codec.yaffle" },
            "2": { name: "entity.name.function.codec.yaffle" }
          },
          end: s(/(?=;|\/\/|\/\*)|$/),
          patterns: [inc("comments"), inc("parameters"), inc("attributes")]
        }
      ]
    },

    struct: {
      comment: "The struct header; its `{ … }` body is a #block.",
      name: "meta.struct.yaffle",
      begin: String.raw`\b(struct)\s+(${ID})`,
      beginCaptures: {
        "1": { name: "storage.type.struct.yaffle" },
        "2": { name: "entity.name.type.struct.yaffle" }
      },
      end: s(/(?=\{|;)|$/),
      patterns: [inc("comments"), inc("type-parameters"), inc("parameters"), inc("attributes")]
    },

    union: {
      name: "meta.union.yaffle",
      begin: String.raw`\b(union)\s+(${ID})`,
      beginCaptures: {
        "1": { name: "storage.type.union.yaffle" },
        "2": { name: "entity.name.type.union.yaffle" }
      },
      end: s(/(?<=\})|(?=;)/),
      patterns: [
        inc("comments"),
        inc("type-parameters"),
        inc("parameters"),
        inc("attributes"),
        {
          name: "meta.union.body.yaffle",
          begin: s(/\{/),
          end: s(/\}/),
          beginCaptures: { "0": { name: "punctuation.definition.block.begin.yaffle" } },
          endCaptures: { "0": { name: "punctuation.definition.block.end.yaffle" } },
          patterns: [
            inc("comments"),
            inc("attributes"),
            inc("type-arguments"),
            inc("call-parens"),
            { match: s(/[,;]/), name: "punctuation.separator.comma.yaffle" },
            inc("type-name")
          ]
        }
      ]
    },

    enum: {
      name: "meta.enum.yaffle",
      begin: String.raw`\b(enum)\s+(${ID})`,
      beginCaptures: {
        "1": { name: "storage.type.enum.yaffle" },
        "2": { name: "entity.name.type.enum.yaffle" }
      },
      end: s(/(?<=\})|(?=;)/),
      patterns: [
        inc("comments"),
        { match: s(/:/), name: "punctuation.separator.colon.yaffle" },
        inc("attributes"),
        {
          name: "meta.enum.body.yaffle",
          begin: s(/\{/),
          end: s(/\}/),
          beginCaptures: { "0": { name: "punctuation.definition.block.begin.yaffle" } },
          endCaptures: { "0": { name: "punctuation.definition.block.end.yaffle" } },
          patterns: [
            inc("comments"),
            inc("attributes"),
            {
              begin: s(/=/),
              beginCaptures: { "0": { name: "keyword.operator.assignment.yaffle" } },
              end: s(/(?=[,}]|\/\/|\/\*)|$/),
              patterns: [inc("expression")]
            },
            { match: s(/,/), name: "punctuation.separator.comma.yaffle" },
            { match: String.raw`\b${ID}\b`, name: "variable.other.enummember.yaffle" }
          ]
        },
        inc("type-name")
      ]
    },

    bits: {
      match: s(/\b(bits)\b/),
      captures: { "1": { name: "storage.type.bits.yaffle" } }
    },

    "type-declaration": {
      comment: "type Name<T>(params) = Type …  and  extern type Name(params) : T @size(n)",
      name: "meta.type.declaration.yaffle",
      begin: String.raw`\b(type)\s+(${ID})`,
      beginCaptures: {
        "1": { name: "storage.type.type.yaffle" },
        "2": { name: "entity.name.type.alias.yaffle" }
      },
      end: s(/(?=;|\/\/|\/\*)|$/),
      patterns: [
        inc("comments"),
        inc("type-parameters"),
        inc("parameters"),
        { match: s(/:/), name: "punctuation.separator.colon.yaffle" },
        {
          begin: s(/=/),
          beginCaptures: { "0": { name: "keyword.operator.assignment.yaffle" } },
          end: s(/(?=;|\/\/|\/\*)|$/),
          patterns: [
            inc("comments"),
            inc("attributes"),
            inc("field-clauses"),
            inc("brackets"),
            inc("type-arguments"),
            inc("call-parens"),
            inc("type-name")
          ]
        },
        inc("attributes"),
        inc("type-name")
      ]
    },

    layout: {
      name: "meta.layout.yaffle",
      begin: s(/\b(layout)\s*(\{)/),
      beginCaptures: {
        "1": { name: "keyword.other.layout.yaffle" },
        "2": { name: "punctuation.definition.block.begin.yaffle" }
      },
      end: s(/\}/),
      endCaptures: { "0": { name: "punctuation.definition.block.end.yaffle" } },
      patterns: [inc("layout-items")]
    },

    "layout-items": {
      patterns: [
        inc("comments"),
        inc("attributes"),
        inc("wildcard"),
        {
          comment: "A per-element group: volumes[*] { pieces[*]  portals[*].points }",
          name: "meta.layout.group.yaffle",
          begin: s(/\{/),
          end: s(/\}/),
          beginCaptures: { "0": { name: "punctuation.definition.block.begin.yaffle" } },
          endCaptures: { "0": { name: "punctuation.definition.block.end.yaffle" } },
          patterns: [inc("layout-items")]
        },
        { match: s(/\bthis\b/), name: "variable.language.this.yaffle" },
        { match: s(/\./), name: "punctuation.accessor.yaffle" },
        { match: s(/,/), name: "punctuation.separator.comma.yaffle" },
        inc("brackets"),
        { match: String.raw`\b${ID}\b`, name: "variable.other.property.yaffle" }
      ]
    },

    virtual: {
      comment: "virtual u40 size = (sizeHigh << 32) | sizeLow",
      match: String.raw`\b(virtual)\b(?=\s+${ID})`,
      captures: { "1": { name: "storage.modifier.virtual.yaffle" } }
    },

    control: {
      patterns: [
        { match: s(/\b(if)\b/), captures: { "1": { name: "keyword.control.if.yaffle" } } },
        { match: s(/\b(else)\b/), captures: { "1": { name: "keyword.control.else.yaffle" } } },
        { match: s(/\b(switch)\b/), captures: { "1": { name: "keyword.control.switch.yaffle" } } },
        {
          name: "meta.case.yaffle",
          begin: s(/\b(case)\b/),
          beginCaptures: { "1": { name: "keyword.control.case.yaffle" } },
          end: s(/:(?!:)/),
          endCaptures: { "0": { name: "punctuation.separator.case.yaffle" } },
          patterns: [inc("expression")]
        },
        {
          match: s(/\b(default)\s*(:)/),
          captures: {
            "1": { name: "keyword.control.default.yaffle" },
            "2": { name: "punctuation.separator.case.yaffle" }
          }
        }
      ]
    },

    block: {
      name: "meta.block.yaffle",
      begin: s(/\{/),
      end: s(/\}/),
      beginCaptures: { "0": { name: "punctuation.definition.block.begin.yaffle" } },
      endCaptures: { "0": { name: "punctuation.definition.block.end.yaffle" } },
      patterns: [inc("statements")]
    },

    // -----------------------------------------------------------------------------------------
    // Fields and parameters

    "field-declaration": declaration("variable.other.member.yaffle"),

    "parameter-declaration": declaration("variable.parameter.yaffle"),

    "field-clauses": {
      comment: "Read-side expressions after a field: = formula, as, where, in, at, from",
      patterns: [
        inc("regex-in"),
        clause("in", "keyword.other.in.yaffle"),
        clause("as", "keyword.other.as.yaffle"),
        clause("where", "keyword.other.where.yaffle"),
        clause("at", "keyword.other.at.yaffle"),
        clause("from", "keyword.other.from.yaffle"),
        {
          name: "meta.clause.default.yaffle",
          begin: s(/\?=/),
          beginCaptures: { "0": { name: "keyword.operator.assignment.default.yaffle" } },
          end: CLAUSE_END,
          patterns: [inc("expression")]
        },
        {
          name: "meta.clause.formula.yaffle",
          begin: s(/(?<![=!<>?])=(?![=>])/),
          beginCaptures: { "0": { name: "keyword.operator.assignment.yaffle" } },
          end: CLAUSE_END,
          patterns: [inc("expression")]
        }
      ]
    },

    "type-parameters": {
      name: "meta.type-parameters.yaffle",
      begin: s(/</),
      end: s(/>/),
      beginCaptures: { "0": { name: "punctuation.definition.typeparameters.begin.yaffle" } },
      endCaptures: { "0": { name: "punctuation.definition.typeparameters.end.yaffle" } },
      patterns: [
        inc("comments"),
        { match: s(/,/), name: "punctuation.separator.comma.yaffle" },
        { match: String.raw`\b${ID}\b`, name: "entity.name.type.parameter.yaffle" }
      ]
    },

    "type-arguments": {
      name: "meta.type-arguments.yaffle",
      begin: s(/</),
      end: s(/>/),
      beginCaptures: { "0": { name: "punctuation.definition.typeparameters.begin.yaffle" } },
      endCaptures: { "0": { name: "punctuation.definition.typeparameters.end.yaffle" } },
      patterns: [
        inc("type-arguments"),
        { match: s(/,/), name: "punctuation.separator.comma.yaffle" },
        inc("numbers"),
        inc("type-name")
      ]
    },

    parameters: {
      name: "meta.parameters.yaffle",
      begin: s(/\(/),
      end: s(/\)/),
      beginCaptures: { "0": { name: "punctuation.definition.parameters.begin.yaffle" } },
      endCaptures: { "0": { name: "punctuation.definition.parameters.end.yaffle" } },
      patterns: [
        inc("comments"),
        inc("attributes"),
        inc("parameter-declaration"),
        inc("brackets"),
        { match: s(/,/), name: "punctuation.separator.comma.yaffle" },
        inc("type-name")
      ]
    },

    "type-name": {
      patterns: [
        inc("primitive-types"),
        {
          match: String.raw`\b(${ID})\s*(\.)`,
          captures: {
            "1": { name: "entity.name.namespace.yaffle" },
            "2": { name: "punctuation.accessor.yaffle" }
          }
        },
        { match: String.raw`\b${ID}\b`, name: "entity.name.type.yaffle" }
      ]
    },

    "primitive-types": {
      patterns: [
        { match: PRIMITIVE, name: "support.type.primitive.yaffle" },
        { match: BUILTIN_TYPE, name: "support.type.builtin.yaffle" }
      ]
    },

    // -----------------------------------------------------------------------------------------
    // Attributes

    attributes: {
      patterns: [
        {
          name: "meta.attribute.yaffle",
          begin: String.raw`(@)(${ID})\s*(\()`,
          beginCaptures: {
            "1": { name: "punctuation.definition.decorator.yaffle" },
            "2": { name: "entity.name.function.decorator.yaffle" },
            "3": { name: "punctuation.definition.arguments.begin.yaffle" }
          },
          end: s(/\)/),
          endCaptures: { "0": { name: "punctuation.definition.arguments.end.yaffle" } },
          patterns: [inc("attribute-arguments")]
        },
        {
          name: "meta.attribute.yaffle",
          match: String.raw`(@)(${ID})`,
          captures: {
            "1": { name: "punctuation.definition.decorator.yaffle" },
            "2": { name: "entity.name.function.decorator.yaffle" }
          }
        }
      ]
    },

    "attribute-arguments": {
      comment: "@align(4, 0xff, strict, from: file, offset: 0x19)",
      patterns: [
        {
          match: s(/(?<=[(,])\s*(strict)\s*(?=[,)])/),
          captures: { "1": { name: "keyword.other.strict.yaffle" } }
        },
        {
          match: s(/(?<=[(,])\s*(from)\s*(:)\s*(file|base)\b/),
          captures: {
            "1": { name: "variable.parameter.named.yaffle" },
            "2": { name: "punctuation.separator.colon.yaffle" },
            "3": { name: "constant.language.origin.yaffle" }
          }
        },
        inc("call-arguments")
      ]
    },

    // -----------------------------------------------------------------------------------------
    // Expressions

    expression: {
      patterns: [
        inc("comments"),
        inc("strings"),
        inc("numbers"),
        inc("bound-values"),
        { match: s(/\bit\b/), name: "variable.language.it.yaffle" },
        { match: s(/\bthis\b/), name: "variable.language.this.yaffle" },
        { match: s(/\b(?:true|false)\b/), name: "constant.language.boolean.yaffle" },
        { match: s(/\bnull\b/), name: "constant.language.null.yaffle" },
        {
          comment: "A lambda: r => r.model != null",
          match: String.raw`\b(${ID})\s*(=>)`,
          captures: {
            "1": { name: "variable.parameter.lambda.yaffle" },
            "2": { name: "storage.type.function.arrow.yaffle" }
          }
        },
        { match: s(/\b(?:le|be)\b/), name: "constant.language.endian.yaffle" },
        { match: s(/\buntil\b/), name: "keyword.control.until.yaffle" },
        inc("regex-in"),
        { match: s(/\bin\b/), name: "keyword.other.in.yaffle" },
        { match: s(/\bas\b/), name: "keyword.other.as.yaffle" },
        inc("function-call"),
        inc("wildcard"),
        inc("brackets"),
        inc("parens"),
        inc("operators"),
        {
          match: String.raw`(\.)\s*(${ID})`,
          captures: {
            "1": { name: "punctuation.accessor.yaffle" },
            "2": { name: "variable.other.property.yaffle" }
          }
        },
        inc("primitive-types"),
        { match: s(/\b[A-Z][A-Z0-9_]+\b/), name: "variable.other.constant.yaffle" },
        { match: String.raw`\b${ID}\b`, name: "variable.other.readwrite.yaffle" },
        { match: s(/,/), name: "punctuation.separator.comma.yaffle" }
      ]
    },

    "function-call": {
      name: "meta.function-call.yaffle",
      begin: String.raw`\b(${ID})\s*(\()`,
      beginCaptures: {
        "1": {
          patterns: [
            {
              match: s(
                /\b(?:sizeof|offsetof|bytesof|encode|crc32|crc16|adler32|min|max|sum|abs|round|map|filter|indicesWhere|sortedBy|unique|concat)\b/
              ),
              name: "support.function.builtin.yaffle"
            },
            { match: PRIMITIVE, name: "support.type.primitive.yaffle" },
            { match: s(/.+/), name: "entity.name.function.yaffle" }
          ]
        },
        "2": { name: "punctuation.definition.arguments.begin.yaffle" }
      },
      end: s(/\)/),
      endCaptures: { "0": { name: "punctuation.definition.arguments.end.yaffle" } },
      patterns: [inc("call-arguments")]
    },

    "call-parens": {
      begin: s(/\(/),
      end: s(/\)/),
      beginCaptures: { "0": { name: "punctuation.definition.arguments.begin.yaffle" } },
      endCaptures: { "0": { name: "punctuation.definition.arguments.end.yaffle" } },
      patterns: [inc("call-arguments")]
    },

    "call-arguments": {
      patterns: [
        {
          comment: "Named argument: Blob(n: 32)",
          match: String.raw`(?<=[(,])\s*(${ID})\s*(:)(?!:)`,
          captures: {
            "1": { name: "variable.parameter.named.yaffle" },
            "2": { name: "punctuation.separator.colon.yaffle" }
          }
        },
        inc("expression")
      ]
    },

    brackets: {
      name: "meta.brackets.yaffle",
      begin: s(/\[/),
      end: s(/\]/),
      beginCaptures: { "0": { name: "punctuation.definition.brackets.begin.yaffle" } },
      endCaptures: { "0": { name: "punctuation.definition.brackets.end.yaffle" } },
      patterns: [inc("expression")]
    },

    parens: {
      name: "meta.parens.yaffle",
      begin: s(/\(/),
      end: s(/\)/),
      beginCaptures: { "0": { name: "punctuation.definition.parens.begin.yaffle" } },
      endCaptures: { "0": { name: "punctuation.definition.parens.end.yaffle" } },
      patterns: [inc("expression")]
    },

    wildcard: {
      comment: "arr[*] in layout paths and streams",
      match: s(/(\[)\s*(\*)\s*(\])/),
      captures: {
        "1": { name: "punctuation.definition.brackets.begin.yaffle" },
        "2": { name: "keyword.operator.wildcard.yaffle" },
        "3": { name: "punctuation.definition.brackets.end.yaffle" }
      }
    },

    operators: {
      patterns: [
        { match: s(/=>/), name: "storage.type.function.arrow.yaffle" },
        { match: s(/->/), name: "keyword.operator.arrow.yaffle" },
        { match: s(/\.\./), name: "keyword.operator.range.yaffle" },
        { match: s(/==|!=|<=|>=/), name: "keyword.operator.comparison.yaffle" },
        { match: s(/&&|\|\||!/), name: "keyword.operator.logical.yaffle" },
        { match: s(/<<|>>/), name: "keyword.operator.bitwise.shift.yaffle" },
        { match: s(/[<>]/), name: "keyword.operator.comparison.yaffle" },
        { match: s(/[&|^~]/), name: "keyword.operator.bitwise.yaffle" },
        { match: s(/[+\-*/%]/), name: "keyword.operator.arithmetic.yaffle" },
        { match: s(/\?=/), name: "keyword.operator.assignment.default.yaffle" },
        { match: s(/=/), name: "keyword.operator.assignment.yaffle" },
        { match: s(/[?:]/), name: "keyword.operator.ternary.yaffle" }
      ]
    },

    "bound-values": {
      patterns: [
        {
          match: s(/(\$)(endian|offset|end|index)\b/),
          name: "variable.language.bound.yaffle",
          captures: { "1": { name: "punctuation.definition.variable.yaffle" } }
        },
        {
          match: String.raw`(\$)${ID}`,
          name: "variable.other.bound.yaffle",
          captures: { "1": { name: "punctuation.definition.variable.yaffle" } }
        }
      ]
    },

    // -----------------------------------------------------------------------------------------
    // Literals

    numbers: {
      patterns: [
        {
          match: s(/\b0[xX][0-9A-Fa-f](?:[0-9A-Fa-f_]*[0-9A-Fa-f])?\b/),
          name: "constant.numeric.hex.yaffle"
        },
        { match: s(/\b0[bB][01](?:[01_]*[01])?\b/), name: "constant.numeric.binary.yaffle" },
        {
          match: s(
            /\b[0-9](?:[0-9_]*[0-9])?(?:\.[0-9](?:[0-9_]*[0-9])?(?:[eE][+-]?[0-9]+)?|[eE][+-]?[0-9]+)\b/
          ),
          name: "constant.numeric.float.yaffle"
        },
        { match: s(/\b[0-9](?:[0-9_]*[0-9])?\b/), name: "constant.numeric.decimal.yaffle" }
      ]
    },

    strings: {
      patterns: [
        inc("string-hex"),
        inc("string-base64"),
        inc("string-double"),
        inc("string-fourcc")
      ]
    },

    "string-double": {
      name: "string.quoted.double.yaffle",
      begin: s(/"/),
      end: s(/"|$/),
      beginCaptures: { "0": { name: "punctuation.definition.string.begin.yaffle" } },
      endCaptures: { "0": { name: "punctuation.definition.string.end.yaffle" } },
      patterns: [inc("string-escapes")]
    },

    "string-fourcc": {
      comment: "Four-character codes: 'ARCV'",
      name: "string.quoted.single.fourcc.yaffle",
      begin: s(/'/),
      end: s(/'|$/),
      beginCaptures: { "0": { name: "punctuation.definition.string.begin.yaffle" } },
      endCaptures: { "0": { name: "punctuation.definition.string.end.yaffle" } },
      patterns: [inc("string-escapes")]
    },

    "string-escapes": {
      patterns: [
        {
          match: s(/\\(?:[nrt0\\"'abfv]|x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]{1,6}\}|u[0-9A-Fa-f]{4})/),
          name: "constant.character.escape.yaffle"
        },
        { match: s(/\\./), name: "invalid.illegal.escape.yaffle" }
      ]
    },

    "string-hex": {
      comment: 'Hex bytes: x"5f2a 91c3"',
      name: "string.quoted.double.hex.yaffle",
      begin: s(/\b(x)(")/),
      end: s(/"|$/),
      beginCaptures: {
        "1": { name: "storage.type.string.yaffle" },
        "2": { name: "punctuation.definition.string.begin.yaffle" }
      },
      endCaptures: { "0": { name: "punctuation.definition.string.end.yaffle" } },
      patterns: [{ match: s(/[^0-9A-Fa-f\s"_]/), name: "invalid.illegal.hex.yaffle" }]
    },

    "string-base64": {
      comment: 'Base64 bytes: b64"…"',
      name: "string.quoted.double.base64.yaffle",
      begin: s(/\b(b64)(")/),
      end: s(/"|$/),
      beginCaptures: {
        "1": { name: "storage.type.string.yaffle" },
        "2": { name: "punctuation.definition.string.begin.yaffle" }
      },
      endCaptures: { "0": { name: "punctuation.definition.string.end.yaffle" } },
      patterns: [{ match: s(/[^A-Za-z0-9+/=\s"]/), name: "invalid.illegal.base64.yaffle" }]
    },

    "regex-in": {
      comment: "A regex literal after `in`: str ver in /v\\d\\.\\d{1,2}/",
      begin: s(/\b(in)\s+(\/)(?![/*])/),
      beginCaptures: {
        "1": { name: "keyword.other.in.yaffle" },
        "2": { name: "string.regexp.yaffle punctuation.definition.string.begin.yaffle" }
      },
      end: s(/(\/)([A-Za-z]*)|$/),
      endCaptures: {
        "1": { name: "string.regexp.yaffle punctuation.definition.string.end.yaffle" },
        "2": { name: "string.regexp.yaffle keyword.other.flag.regexp" }
      },
      contentName: "string.regexp.yaffle",
      patterns: [inc("regexp")]
    },

    regexp: {
      patterns: [
        { match: s(/\\[dDwWsSbB]/), name: "constant.character.character-class.regexp" },
        { match: s(/\\./), name: "constant.character.escape.backslash.regexp" },
        {
          name: "constant.other.character-class.set.regexp",
          begin: s(/(\[)(\^)?/),
          beginCaptures: {
            "1": { name: "punctuation.definition.character-class.regexp" },
            "2": { name: "keyword.operator.negation.regexp" }
          },
          end: s(/\]/),
          endCaptures: { "0": { name: "punctuation.definition.character-class.regexp" } },
          patterns: [{ match: s(/\\./), name: "constant.character.escape.backslash.regexp" }]
        },
        { match: s(/[*+?]\??|\{\d+(?:,\d*)?\}\??/), name: "keyword.operator.quantifier.regexp" },
        { match: s(/[\^$]/), name: "keyword.control.anchor.regexp" },
        { match: s(/\|/), name: "keyword.operator.or.regexp" },
        { match: s(/\((?:\?:)?|\)/), name: "punctuation.definition.group.regexp" },
        { match: s(/\./), name: "constant.character.wildcard.regexp" }
      ]
    }
  }
};
