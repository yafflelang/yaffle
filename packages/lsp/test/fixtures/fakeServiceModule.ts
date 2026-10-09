/** A `--service` module for end-to-end tests: the fake service, plus a fake `compile`. */
import type { LanguageService, ProjectHost } from "yaffle/service";
import { FakeService } from "../fakeService.ts";

export function createLanguageService(host: ProjectHost): LanguageService {
  return new FakeService(host, process.platform === "win32" ? "win32" : "posix");
}

export function compile(entries: string[]): { program: unknown; diagnostics: [] } {
  return { program: { fake: true, entries }, diagnostics: [] };
}
