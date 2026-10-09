/**
 * The yaffle-specific requests (see protocol.ts). Malformed params are protocol errors;
 * everything else that goes wrong is answered in the result's `error`, a message for the user.
 */
import {
  type CancellationToken,
  type Connection,
  ErrorCodes,
  ResponseError
} from "vscode-languageserver";
import type * as svc from "yaffle/service";
import type { ConfigHost } from "./config.ts";
import { type ConvertContext, toLspChanges, toLspRange } from "./convert.ts";
import type { FileSystem } from "./fs.ts";
import {
  DecodeSampleMethod,
  type DecodeSampleResult,
  type IrDiagnostic,
  RootParametersMethod,
  type RootParameterDto,
  type RootParametersResult,
  ShowIrMethod,
  type ShowIrResult,
  SuggestLayoutMethod,
  type SuggestLayoutResult
} from "./protocol.ts";
import type { ErrorReporter, Logger, SafeService } from "./safe.ts";
import type { UriMapper } from "./uri.ts";
import { errorMessage, isRecord } from "./util.ts";

/** The compiler's `compile` signature (used by `yaffle/showIr`). */
export type CompileFunction = (
  entryFiles: string[],
  host: ConfigHost
) => { program?: unknown; diagnostics: svc.Diagnostic[] };

/** A request's document, resolved to its path and its project's service. */
export interface RequestTarget {
  uri: string;
  path: string;
  service: SafeService;
}

export type Reply<R> = R | ResponseError<void> | Promise<R | ResponseError<void>>;

/** What the custom requests need from the server. */
export interface CustomRequestContext {
  /** Run a request on a document, with cancellation and fault isolation. */
  run<R>(
    method: string,
    uri: string,
    token: CancellationToken,
    fallback: R,
    fn: (target: RequestTarget) => Reply<R>
  ): Promise<R | ResponseError<void>>;
  uris: UriMapper;
  fs: FileSystem;
  /** Text files with the editor's unsaved contents. */
  files: ConfigHost;
  compile: CompileFunction | undefined;
  reporter: ErrorReporter;
  logger: Logger;
  convertContext(): ConvertContext;
}

interface SampleInput {
  uri: string;
  root: string;
  bytes: Uint8Array;
  args?: Record<string, unknown>;
}

export function registerCustomRequests(
  connection: Connection,
  context: CustomRequestContext
): void {
  const requests = new CustomRequests(context);
  connection.onRequest(ShowIrMethod, (params: unknown, token) => requests.showIr(params, token));
  connection.onRequest(DecodeSampleMethod, (params: unknown, token) =>
    requests.decodeSample(params, token)
  );
  connection.onRequest(SuggestLayoutMethod, (params: unknown, token) =>
    requests.suggestLayout(params, token)
  );
  connection.onRequest(RootParametersMethod, (params: unknown, token) =>
    requests.rootParameters(params, token)
  );
}

class CustomRequests {
  private readonly c: CustomRequestContext;

  constructor(context: CustomRequestContext) {
    this.c = context;
  }

  async showIr(
    params: unknown,
    token: CancellationToken
  ): Promise<ShowIrResult | ResponseError<void>> {
    const uri = documentUri(params);
    if (uri instanceof ResponseError) return uri;
    return this.c.run("showIr", uri, token, { program: null, diagnostics: [] }, t =>
      this.compileIr(t.path)
    );
  }

  /** Compile a file with unsaved editor contents; the IR as plain JSON (bigints as strings). */
  private compileIr(path: string): ShowIrResult {
    const { compile } = this.c;
    if (!compile) {
      return {
        program: null,
        diagnostics: [],
        error: "Show IR is unavailable: the server has no compiler."
      };
    }
    let result: ReturnType<CompileFunction>;
    try {
      result = compile([path], this.c.files);
    } catch (error) {
      this.c.reporter.report("compile", error);
      return {
        program: null,
        diagnostics: [],
        error: `The compiler failed: ${errorMessage(error)}`
      };
    }
    const diagnostics: IrDiagnostic[] = (
      Array.isArray(result?.diagnostics) ? result.diagnostics : []
    ).map(d => ({
      uri: this.c.uris.toUri(d.path || path),
      range: toLspRange(d.range),
      severity: d.severity,
      code: d.code,
      message: d.message
    }));
    if (result?.program === undefined) return { program: null, diagnostics };
    try {
      const json = JSON.stringify(result.program, (_k, v: unknown) =>
        typeof v === "bigint" ? v.toString() : v
      );
      return { program: JSON.parse(json) as unknown, diagnostics };
    } catch (error) {
      const message = `The IR is not serializable: ${errorMessage(error)}`;
      return { program: null, diagnostics, error: message };
    }
  }

  async rootParameters(
    params: unknown,
    token: CancellationToken
  ): Promise<RootParametersResult | ResponseError<void>> {
    const input = rootParams(params);
    if (input instanceof ResponseError) return input;
    return this.c.run("rootParameters", input.uri, token, { parameters: [] }, t => {
      const result = t.service.attempt(
        "getRootParameters",
        s =>
          typeof s.getRootParameters === "function" ? s.getRootParameters(t.path, input.root) : [],
        false
      );
      if (!result.ok) return { parameters: [], error: errorMessage(result.error) };
      const parameters = (Array.isArray(result.value) ? result.value : []).filter(
        x => isRecord(x) && typeof x.name === "string"
      ) as RootParameterDto[];
      return { parameters };
    });
  }

  decodeSample(
    params: unknown,
    token: CancellationToken
  ): Promise<DecodeSampleResult | ResponseError<void>> {
    return this.sampleRequest(
      "decodeSample",
      params,
      token,
      { annotations: [] },
      (s, path, input) => s.decodeSample(path, input.root, input.bytes, input.args),
      (annotations, t) => ({
        annotations: (Array.isArray(annotations) ? annotations : []).filter(isRecord).map(a => ({
          uri: this.c.uris.toUri(typeof a.path === "string" && a.path ? a.path : t.path),
          range: toLspRange(a.range),
          value: String(a.value ?? ""),
          offset: Number(a.offset) || 0,
          size: Number(a.size) || 0
        }))
      })
    );
  }

  suggestLayout(
    params: unknown,
    token: CancellationToken
  ): Promise<SuggestLayoutResult | ResponseError<void>> {
    return this.sampleRequest(
      "suggestLayout",
      params,
      token,
      { edit: null },
      (s, path, input) => s.suggestLayout(path, input.root, input.bytes, input.args),
      edit => ({ edit: isRecord(edit) ? toLspChanges(edit, this.c.convertContext()) : null })
    );
  }

  /**
   * The sample requests' common part. The service rejects with messages for the user (unknown
   * root, a sample that doesn't decode, …), so a rejection is answered in `error` and logged as
   * information, not as a failure.
   */
  private async sampleRequest<V, R extends object>(
    method: string,
    params: unknown,
    token: CancellationToken,
    empty: R,
    call: (service: svc.LanguageService, path: string, input: SampleInput) => Promise<V>,
    convert: (value: V, target: RequestTarget) => R
  ): Promise<R | ResponseError<void>> {
    const input = this.sampleParams(params);
    if (input instanceof ResponseError) return input;
    if (typeof input === "string") return { ...empty, error: input };
    return this.c.run(method, input.uri, token, empty, async t => {
      const result = await t.service.attemptAsync(method, s => call(s, t.path, input), false);
      if (result.ok) return convert(result.value, t);
      const message = errorMessage(result.error);
      this.c.logger.info(`yaffle: ${method}: ${message}`);
      return { ...empty, error: message };
    });
  }

  /** Sample request params with the sample's bytes. A string is a message for the user. */
  private sampleParams(params: unknown): SampleInput | ResponseError<void> | string {
    const root = rootParams(params);
    if (root instanceof ResponseError) return root;
    const { args, sample } = params as Record<string, unknown>;
    if (args !== undefined && !isRecord(args)) {
      return new ResponseError(ErrorCodes.InvalidParams, "Expected args: an object");
    }
    const input = args === undefined ? root : { ...root, args };
    if (isRecord(sample) && typeof sample.base64 === "string") {
      return { ...input, bytes: new Uint8Array(Buffer.from(sample.base64, "base64")) };
    }
    if (isRecord(sample) && typeof sample.uri === "string") {
      const samplePath = this.c.uris.toPath(sample.uri);
      const bytes = this.c.fs.readBinary(samplePath);
      return bytes ? { ...input, bytes } : `Cannot read the sample file ${samplePath}`;
    }
    return new ResponseError(ErrorCodes.InvalidParams, "Expected sample: { uri } or { base64 }");
  }
}

/** The `textDocument.uri` of custom request params. */
function documentUri(params: unknown): string | ResponseError<void> {
  const uri = isRecord(params) && isRecord(params.textDocument) ? params.textDocument.uri : null;
  if (typeof uri === "string") return uri;
  return new ResponseError(ErrorCodes.InvalidParams, "Expected { textDocument: { uri } }");
}

/** `{ textDocument, root }`, the params of `yaffle/rootParameters` and the sample requests. */
function rootParams(params: unknown): { uri: string; root: string } | ResponseError<void> {
  const uri = documentUri(params);
  if (uri instanceof ResponseError) return uri;
  const root = (params as Record<string, unknown>).root;
  if (typeof root !== "string" || root === "") {
    return new ResponseError(ErrorCodes.InvalidParams, "Expected a root struct name");
  }
  return { uri, root };
}
