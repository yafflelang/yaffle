/**
 * Hand-written IR for an archive: a padded header, an entry table, and each entry's data:
 *
 * ```c
 * export struct Archive {
 *   @padUntil(0x80) {
 *     char tag[4] = "ARCV"
 *     u32  count                       // entries.length
 *   }
 *   Entry entries[count]
 * }
 * struct Entry {
 *   u16 handler
 *   u16 kind
 *   u32 align
 *   u64 offset                         // offsetof(data)
 *   u32 size                           // data.length
 *   u32 reserved = 0
 *   u8  data[size] at offset @align(align)
 * }
 * ```
 */
import type { IrProgram } from "yaffle/ir";
import * as ir from "../ir.ts";

const {
  S,
  f,
  derived,
  constant,
  program,
  u16,
  u32,
  u64,
  array,
  bytes,
  count,
  ref,
  fr,
  len,
  vt,
  block,
  L,
  str,
  layered,
  placed,
  offsetof
} = ir;

export function archiveIr(): IrProgram {
  return program({
    structs: [
      S("Entry", [
        f("handler", u16),
        f("kind", u16),
        f("align", u32),
        derived("offset", u64, offsetof("data")),
        derived("size", u32, len(fr("data", vt.bytes))),
        constant("reserved", u32, 0),
        f("data", layered(bytes(count(fr("size"))), L.align(fr("align"))), {
          placement: placed(fr("offset", vt.int(64)))
        })
      ]),
      S("Archive", [
        block(
          [
            constant("tag", str(count(4), "ascii"), "ARCV"),
            derived("count", u32, len(fr("entries", vt.array(vt.struct("Entry")))))
          ],
          {
            layers: [L.padUntil(0x80)]
          }
        ),
        f("entries", array(ref("Entry"), count(fr("count"))))
      ])
    ],
    roots: ["Archive"]
  });
}
