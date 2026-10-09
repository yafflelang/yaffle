import type { Backend } from "./backend.ts";
import { tsBackend } from "./ts/index.ts";
import { rustBackend } from "./rust/index.ts";
import { pythonBackend } from "./python/index.ts";
import { goBackend } from "./go/index.ts";
import { csharpBackend } from "./csharp/index.ts";
import { javaBackend } from "./java/index.ts";
import { cppBackend } from "./cpp/index.ts";

export type { Backend, BackendOptions, GeneratedFile } from "./backend.ts";

/** Registry of all backends. Adding a backend = one import + one entry here. */
export const backends: Record<string, Backend> = {
  [tsBackend.name]: tsBackend,
  [rustBackend.name]: rustBackend,
  [pythonBackend.name]: pythonBackend,
  [goBackend.name]: goBackend,
  [csharpBackend.name]: csharpBackend,
  [javaBackend.name]: javaBackend,
  [cppBackend.name]: cppBackend
};
