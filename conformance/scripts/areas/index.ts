/** Registry of case generators: one module per conformance/cases/<area>/ directory. */
import type { Area } from "../lib.ts";
import alignOrigin from "./align-origin.ts";
import arrays from "./arrays.ts";
import bitfields from "./bitfields.ts";
import codecs from "./codecs.ts";
import conditionals from "./conditionals.ts";
import constraints from "./constraints.ts";
import derivedArrays from "./derived-arrays.ts";
import endianness from "./endianness.ts";
import enums from "./enums.ts";
import features from "./features.ts";
import formulas from "./formulas.ts";
import generics from "./generics.ts";
import layoutFields from "./layout-fields.ts";
import layoutGroups from "./layout-groups.ts";
import layout from "./layout.ts";
import modulesGeneric from "./modules-generic.ts";
import modules from "./modules.ts";
import padding from "./padding.ts";
import params from "./params.ts";
import pointers from "./pointers.ts";
import primitives from "./primitives.ts";
import slicesWrite from "./slices-write.ts";
import streamsHidden from "./streams-hidden.ts";
import streamsSlices from "./streams-slices.ts";
import streams from "./streams.ts";
import strictFill from "./strict-fill.ts";
import strings from "./strings.ts";
import transforms from "./transforms.ts";
import virtualFields from "./virtual.ts";

export const areas: Area[] = [
  primitives,
  endianness,
  strings,
  arrays,
  constraints,
  formulas,
  transforms,
  enums,
  padding,
  pointers,
  layout,
  conditionals,
  codecs,
  params,
  generics,
  bitfields,
  modules,
  modulesGeneric,
  streams,
  streamsHidden,
  streamsSlices,
  layoutGroups,
  alignOrigin,
  strictFill,
  layoutFields,
  virtualFields,
  derivedArrays,
  slicesWrite,
  features
];
