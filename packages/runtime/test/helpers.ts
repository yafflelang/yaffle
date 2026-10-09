import { YaffleError } from "../src/index.ts";

/** The `YaffleError` that `f` throws; fails the test when it returns or throws something else. */
export function err(f: () => unknown): YaffleError {
  try {
    f();
  } catch (e) {
    if (e instanceof YaffleError) return e;
    throw e;
  }
  throw new Error("expected a YaffleError");
}

/** The error code `f` throws, or "none" when it returns normally. */
export function code(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return (e as YaffleError).code;
  }
  return "none";
}
