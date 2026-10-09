/**
 * Projects: one language service per `yaffle.json`, plus an "inferred" project for files with no
 * config above them. A file belongs to the project of the nearest `yaffle.json` upwards from it
 * (like tsserver's configured projects), so a workspace can hold several independent projects.
 */
import type { Diagnostic, LanguageService, ProjectConfig, ProjectHost } from "yaffle/service";
import type { ConfigHost, LoadProjectConfig } from "./config.ts";
import { type FileSystem, withOverlay } from "./fs.ts";
import { type ErrorReporter, type Logger, SafeService } from "./safe.ts";
import { isPathInside, pathApi, pathKey, type Platform } from "./uri.ts";
import { errorMessage } from "./util.ts";

export const CONFIG_FILE_NAME = "yaffle.json";

export type ServiceFactory = (host: ProjectHost) => LanguageService;

/**
 * The host a project's service reads through. It overlays unsaved editor contents (for files
 * open in *another* project) and records every path the service touched, so on-disk changes
 * can be routed to the services that care and watched when outside the workspace.
 */
class TrackingHost implements ProjectHost {
  private readonly fs: FileSystem;
  private readonly files: ConfigHost;
  private readonly platform: Platform;
  /** Every path read or probed, by key. */
  readonly seen = new Map<string, string>();

  constructor(fs: FileSystem, overlay: (path: string) => string | undefined, platform: Platform) {
    this.fs = fs;
    this.files = withOverlay(fs, overlay);
    this.platform = platform;
  }

  private note(path: string): void {
    if (typeof path !== "string") return;
    const key = pathKey(path, this.platform);
    if (!this.seen.has(key)) this.seen.set(key, path);
  }

  readFile(path: string): string | undefined {
    this.note(path);
    return this.files.readFile(path);
  }

  fileExists(path: string): boolean {
    this.note(path);
    return this.files.fileExists(path);
  }

  readDirectory(path: string): string[] | undefined {
    return this.fs.readDirectory(path);
  }

  hasSeen(path: string): boolean {
    return this.seen.has(pathKey(path, this.platform));
  }
}

export interface ProjectContext {
  fs: FileSystem;
  platform: Platform;
  logger: Logger;
  reporter: ErrorReporter;
  createService: ServiceFactory;
  loadProjectConfig: LoadProjectConfig;
  /** Text of a document open in the editor (any project), if open. */
  openText(path: string): string | undefined;
  /** Called when a service fails to start. */
  onServiceFailure(project: Project, error: unknown): void;
  /** Called after a project is created and its config loaded. */
  onProjectCreated(project: Project): void;
}

export class Project {
  /** pathKey of the config file, or "" for the inferred project. */
  readonly key: string;
  readonly configPath: string | undefined;
  readonly rootDir: string | undefined;
  readonly service: SafeService;
  /** Files open in the editor that belong to this project (key → path). */
  readonly openFiles = new Map<string, string>();
  config: ProjectConfig | undefined;
  configDiagnostics: Diagnostic[] = [];
  /** Diagnostics scheduling, owned by the server. */
  timer: ReturnType<typeof setTimeout> | undefined;
  generation = 0;
  /** Ask the client to refresh inlay hints, lenses and tokens after the next pass. */
  needsRefresh = false;
  disposed = false;
  private readonly ctx: ProjectContext;
  private readonly host: TrackingHost;

  constructor(ctx: ProjectContext, configPath: string | undefined) {
    this.ctx = ctx;
    this.configPath = configPath;
    this.key = configPath === undefined ? "" : pathKey(configPath, ctx.platform);
    this.rootDir = configPath === undefined ? undefined : pathApi(ctx.platform).dirname(configPath);
    this.host = new TrackingHost(ctx.fs, ctx.openText, ctx.platform);
    let inner: LanguageService | undefined;
    try {
      inner = ctx.createService(this.host);
      if (!inner || typeof inner !== "object")
        throw new Error("the service factory returned nothing");
    } catch (error) {
      inner = undefined;
      ctx.reporter.report(`createLanguageService (${this.label})`, error);
      ctx.onServiceFailure(this, error);
    }
    this.service = new SafeService(inner, ctx.reporter, this.label);
    this.loadConfig();
  }

  get label(): string {
    return this.configPath ?? "inferred project";
  }

  /** (Re)read yaffle.json and hand it to the service. */
  loadConfig(): void {
    if (this.configPath === undefined) {
      this.config = undefined;
      this.configDiagnostics = [];
    } else {
      const configPath = this.configPath;
      const result = this.readConfig(configPath);
      this.config = result.config;
      this.configDiagnostics = result.diagnostics.map(d => ({ ...d, path: d.path || configPath }));
    }
    this.service.setProject(this.config, this.rootDir);
  }

  /** The loader's result; a loader that throws becomes a diagnostic on the config file. */
  private readConfig(configPath: string): { config?: ProjectConfig; diagnostics: Diagnostic[] } {
    try {
      const result = this.ctx.loadProjectConfig(
        configPath,
        withOverlay(this.ctx.fs, this.ctx.openText)
      );
      return Array.isArray(result?.diagnostics) ? result : { ...result, diagnostics: [] };
    } catch (error) {
      this.ctx.reporter.report(`loadProjectConfig (${configPath})`, error);
      return {
        diagnostics: [
          {
            path: configPath,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            severity: "error",
            code: "invalid-config",
            message: `Cannot load yaffle.json: ${errorMessage(error)}`
          }
        ]
      };
    }
  }

  /** Whether this project's service has read or probed a path. */
  touches(path: string): boolean {
    return this.host.hasSeen(path);
  }

  /** Every path this project's service has read or probed. */
  touchedPaths(): Iterable<string> {
    return this.host.seen.values();
  }

  /** Whether a path is inside the project's directory. */
  contains(path: string): boolean {
    return this.rootDir !== undefined && isPathInside(path, this.rootDir, this.ctx.platform);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.service.dispose();
  }
}

/** Finds and caches the nearest yaffle.json for files, and owns the projects. */
export class ProjectManager {
  private readonly ctx: ProjectContext;
  private readonly projects = new Map<string, Project>();
  /** Directory key → config path found from it (null: none). */
  private readonly lookupCache = new Map<string, string | null>();

  constructor(ctx: ProjectContext) {
    this.ctx = ctx;
  }

  all(): Project[] {
    return [...this.projects.values()];
  }

  get(key: string): Project | undefined {
    return this.projects.get(key);
  }

  /** The nearest yaffle.json at or above the file's directory. */
  private findConfig(filePath: string): string | undefined {
    const api = pathApi(this.ctx.platform);
    const visited: string[] = [];
    let dir = api.dirname(filePath);
    let found: string | null = null;
    for (;;) {
      const key = pathKey(dir, this.ctx.platform);
      const cached = this.lookupCache.get(key);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      visited.push(key);
      const candidate = api.join(dir, CONFIG_FILE_NAME);
      if (this.ctx.fs.fileExists(candidate)) {
        found = candidate;
        break;
      }
      const parent = api.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const key of visited) this.lookupCache.set(key, found);
    return found ?? undefined;
  }

  /** Forget cached config lookups (a yaffle.json was created or deleted). */
  invalidateLookups(): void {
    this.lookupCache.clear();
  }

  /** The project for a config path (created on first use). */
  ensureProject(configPath: string | undefined): Project {
    const key = configPath === undefined ? "" : pathKey(configPath, this.ctx.platform);
    let project = this.projects.get(key);
    if (!project) {
      project = new Project(this.ctx, configPath);
      this.projects.set(key, project);
      this.ctx.logger.info(`yaffle: loaded ${project.label}`);
      this.ctx.onProjectCreated(project);
    }
    return project;
  }

  /** The project a file belongs to. */
  projectFor(filePath: string): Project {
    return this.ensureProject(this.findConfig(filePath));
  }

  remove(project: Project): void {
    if (this.projects.get(project.key) === project) this.projects.delete(project.key);
    project.dispose();
  }

  disposeAll(): void {
    for (const project of this.projects.values()) project.dispose();
    this.projects.clear();
  }
}
