/**
 * A small stand-in for the `vscode` module, enough to load and activate the bundled extension
 * (dist/extension.cjs) outside VS Code. Known APIs are implemented; any other function is a
 * forgiving no-op that returns a disposable (and events accept listeners), so
 * vscode-languageclient can run its full startup against the real bundled server.
 */
"use strict";

const calls = [];
const registeredCommands = new Map();
const contentProviders = new Map();
const messages = [];
const configuration = {};

function record(name, args) {
  calls.push({ name, args });
}

class Disposable {
  constructor(fn) {
    this._fn = fn;
  }
  static from(...items) {
    return new Disposable(() => items.forEach(i => i && i.dispose && i.dispose()));
  }
  dispose() {
    if (this._fn) this._fn();
    this._fn = undefined;
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener, thisArg) => {
      const l = thisArg ? listener.bind(thisArg) : listener;
      this.listeners.add(l);
      return new Disposable(() => this.listeners.delete(l));
    };
  }
  fire(value) {
    for (const l of [...this.listeners]) l(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(a, b, c, d) {
    if (typeof a === "number") {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    } else {
      this.start = a;
      this.end = b;
    }
  }
}

class Selection extends Range {}

class Location {
  constructor(uri, rangeOrPosition) {
    this.uri = uri;
    this.range = rangeOrPosition;
  }
}

class Uri {
  constructor(scheme, authority, path, query, fragment) {
    this.scheme = scheme;
    this.authority = authority || "";
    this.path = path || "/";
    this.query = query || "";
    this.fragment = fragment || "";
  }
  static parse(value) {
    const m = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!m) return new Uri("file", "", value);
    return new Uri(m[1], m[2], decodeURIComponent(m[3] || "/"), m[4], m[5]);
  }
  static file(path) {
    return new Uri("file", "", path.replace(/\\/g, "/"));
  }
  static from(parts) {
    return new Uri(parts.scheme, parts.authority, parts.path, parts.query, parts.fragment);
  }
  static joinPath(base, ...segments) {
    return new Uri(
      base.scheme,
      base.authority,
      [base.path, ...segments].join("/").replace(/\/+/g, "/")
    );
  }
  get fsPath() {
    return this.path;
  }
  with(change) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    );
  }
  toString() {
    const q = this.query ? `?${this.query}` : "";
    const f = this.fragment ? `#${this.fragment}` : "";
    const authority = this.scheme === "file" || this.authority ? `//${this.authority}` : "";
    return `${this.scheme}:${authority}${encodeURI(this.path)}${q}${f}`;
  }
  toJSON() {
    return this.toString();
  }
}

class MarkdownString {
  constructor(value = "") {
    this.value = value;
  }
  appendText(t) {
    this.value += t;
    return this;
  }
  appendMarkdown(t) {
    this.value += t;
    return this;
  }
  appendCodeblock(t) {
    this.value += t;
    return this;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class CancellationTokenSource {
  constructor() {
    const emitter = new EventEmitter();
    this._emitter = emitter;
    this.token = { isCancellationRequested: false, onCancellationRequested: emitter.event };
  }
  cancel() {
    this.token.isCancellationRequested = true;
    this._emitter.fire();
  }
  dispose() {}
}

class CancellationError extends Error {}

/** A generic class for API value types the client only constructs. */
function valueClass(name) {
  return {
    [name]: class {
      constructor(...args) {
        this.args = args;
      }
    }
  }[name];
}

/** Any enum: every member is a distinct number. */
function autoEnum() {
  const values = new Map();
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === "symbol") return undefined;
        if (!values.has(prop)) values.set(prop, values.size + 1);
        return values.get(prop);
      }
    }
  );
}

/** Namespace with known members; unknown functions are no-ops returning disposables. */
function namespace(name, known) {
  return new Proxy(known, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return (...args) => {
        record(`${name}.${String(prop)}`, args);
        return new Disposable();
      };
    }
  });
}

function outputChannel(name) {
  const lines = [];
  const log = level => message => lines.push(`[${level}] ${message}`);
  return {
    name,
    lines,
    logLevel: 2,
    onDidChangeLogLevel: new EventEmitter().event,
    append: t => lines.push(t),
    appendLine: t => lines.push(t),
    replace: t => lines.push(t),
    clear() {},
    show() {},
    hide() {},
    dispose() {},
    trace: log("trace"),
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error")
  };
}

const outputChannels = [];
/** Emitters tests can fire, and canned answers for UI prompts. */
const events = {
  didSave: new EventEmitter(),
  visibleEditors: new EventEmitter(),
  configuration: new EventEmitter()
};
const responses = {
  symbols: [],
  quickPick: items => items[0],
  openDialog: undefined,
  inputBox: () => undefined
};
const appliedEdits = [];
const statusItems = [];

function configurationFor(section) {
  const prefix = section ? `${section}.` : "";
  return {
    get(key, defaultValue) {
      const full = prefix + key;
      return full in configuration ? configuration[full] : defaultValue;
    },
    has(key) {
      return prefix + key in configuration;
    },
    inspect() {
      return undefined;
    },
    update() {
      return Promise.resolve();
    }
  };
}

const workspace = namespace("workspace", {
  workspaceFolders: undefined,
  textDocuments: [],
  name: undefined,
  getConfiguration: section => configurationFor(section),
  getWorkspaceFolder: () => undefined,
  onDidOpenTextDocument: new EventEmitter().event,
  onDidCloseTextDocument: new EventEmitter().event,
  onDidChangeTextDocument: new EventEmitter().event,
  onDidSaveTextDocument: events.didSave.event,
  onWillSaveTextDocument: new EventEmitter().event,
  onDidChangeConfiguration: events.configuration.event,
  onDidChangeWorkspaceFolders: new EventEmitter().event,
  onDidCreateFiles: new EventEmitter().event,
  onDidRenameFiles: new EventEmitter().event,
  onDidDeleteFiles: new EventEmitter().event,
  onWillCreateFiles: new EventEmitter().event,
  onWillRenameFiles: new EventEmitter().event,
  onWillDeleteFiles: new EventEmitter().event,
  onDidOpenNotebookDocument: new EventEmitter().event,
  onDidCloseNotebookDocument: new EventEmitter().event,
  onDidChangeNotebookDocument: new EventEmitter().event,
  onDidSaveNotebookDocument: new EventEmitter().event,
  notebookDocuments: [],
  createFileSystemWatcher: glob => {
    record("workspace.createFileSystemWatcher", [glob]);
    return {
      onDidCreate: new EventEmitter().event,
      onDidChange: new EventEmitter().event,
      onDidDelete: new EventEmitter().event,
      dispose() {}
    };
  },
  registerTextDocumentContentProvider: (scheme, provider) => {
    contentProviders.set(scheme, provider);
    return new Disposable(() => contentProviders.delete(scheme));
  },
  fs: { readFile: async () => new Uint8Array() },
  applyEdit: async edit => {
    appliedEdits.push(edit);
    return true;
  },
  openTextDocument: async uri => {
    const provider = contentProviders.get(uri.scheme);
    const text = provider
      ? await provider.provideTextDocumentContent(uri, new CancellationTokenSource().token)
      : "";
    return { uri, languageId: "plaintext", getText: () => text };
  }
});

const window = namespace("window", {
  activeTextEditor: undefined,
  visibleTextEditors: [],
  createOutputChannel: name => {
    const channel = outputChannel(name);
    outputChannels.push(channel);
    return channel;
  },
  createTextEditorDecorationType: options => ({ options, key: "decoration", dispose() {} }),
  createStatusBarItem: () => {
    const item = {
      text: "",
      tooltip: "",
      visible: false,
      show() {
        item.visible = true;
      },
      hide() {
        item.visible = false;
      },
      dispose() {}
    };
    statusItems.push(item);
    return item;
  },
  showErrorMessage: (...args) => {
    messages.push({ type: "error", args });
    return Promise.resolve(undefined);
  },
  showWarningMessage: (...args) => {
    messages.push({ type: "warning", args });
    return Promise.resolve(undefined);
  },
  showInformationMessage: (...args) => {
    messages.push({ type: "info", args });
    return Promise.resolve(undefined);
  },
  withProgress: (_options, task) => task({ report() {} }, new CancellationTokenSource().token),
  onDidChangeVisibleTextEditors: events.visibleEditors.event,
  showQuickPick: async items => responses.quickPick(await items),
  showOpenDialog: async () => responses.openDialog,
  showInputBox: async options => {
    record("window.showInputBox", [options]);
    return responses.inputBox(options);
  },
  showTextDocument: async document => ({ document, setDecorations() {} }),
  onDidChangeActiveTextEditor: new EventEmitter().event,
  onDidChangeTextEditorSelection: new EventEmitter().event,
  onDidChangeWindowState: new EventEmitter().event,
  state: { focused: true }
});

const commands = namespace("commands", {
  registerCommand: (id, fn) => {
    registeredCommands.set(id, fn);
    return new Disposable(() => registeredCommands.delete(id));
  },
  executeCommand: async (id, ...args) => {
    record("commands.executeCommand", [id, ...args]);
    if (id === "vscode.executeDocumentSymbolProvider") return responses.symbols;
    const fn = registeredCommands.get(id);
    return fn ? fn(...args) : undefined;
  },
  getCommands: async () => [...registeredCommands.keys()]
});

const languages = namespace("languages", {
  createDiagnosticCollection: name => ({
    name,
    set() {},
    delete() {},
    clear() {},
    forEach() {},
    get() {
      return undefined;
    },
    has() {
      return false;
    },
    dispose() {}
  }),
  match: () => 0,
  setTextDocumentLanguage: async (document, languageId) => ({ ...document, languageId }),
  onDidChangeDiagnostics: new EventEmitter().event
});

const env = namespace("env", {
  appName: "vscode-mock",
  language: "en",
  machineId: "mock",
  sessionId: "mock",
  uiKind: 1,
  remoteName: undefined
});

const vscode = {
  version: "1.100.0",
  Disposable,
  EventEmitter,
  Position,
  Range,
  Selection,
  Location,
  Uri,
  MarkdownString,
  ThemeColor,
  CancellationTokenSource,
  CancellationError,
  workspace,
  window,
  commands,
  languages,
  env,
  extensions: namespace("extensions", { all: [], getExtension: () => undefined }),
  notebooks: namespace("notebooks", {}),
  l10n: {
    t: (message, ...args) => String(message).replace(/\{(\d+)\}/g, (_m, i) => String(args[i]))
  }
};

for (const name of [
  "CallHierarchyItem",
  "CodeAction",
  "CodeLens",
  "Color",
  "ColorInformation",
  "ColorPresentation",
  "Command",
  "CompletionItem",
  "CompletionList",
  "Diagnostic",
  "DiagnosticRelatedInformation",
  "DocumentHighlight",
  "DocumentLink",
  "DocumentSymbol",
  "FoldingRange",
  "Hover",
  "InlayHint",
  "InlayHintLabelPart",
  "InlineValueText",
  "LinkedEditingRanges",
  "ParameterInformation",
  "RelativePattern",
  "SelectionRange",
  "SemanticTokens",
  "SemanticTokensEdit",
  "SemanticTokensEdits",
  "SemanticTokensLegend",
  "SignatureHelp",
  "SignatureInformation",
  "SnippetString",
  "SymbolInformation",
  "TypeHierarchyItem",
  "TabInputText",
  "TabInputTextDiff",
  "TabInputCustom",
  "TabInputNotebook"
]) {
  vscode[name] = valueClass(name);
}

class WorkspaceEdit {
  constructor() {
    this.edits = new Map();
  }
  set(uri, edits) {
    this.edits.set(uri.toString(), edits);
  }
  replace(uri, range, newText) {
    const list = this.edits.get(uri.toString()) ?? [];
    list.push({ range, newText });
    this.edits.set(uri.toString(), list);
  }
  insert(uri, position, newText) {
    this.replace(uri, new Range(position, position), newText);
  }
  entries() {
    return [...this.edits.entries()];
  }
  get size() {
    return this.edits.size;
  }
}
vscode.WorkspaceEdit = WorkspaceEdit;

class TextEdit {
  constructor(range, newText) {
    this.range = range;
    this.newText = newText;
  }
}
vscode.TextEdit = TextEdit;

// Enums are real properties: bundlers copy the module's own keys.
for (const name of [
  "CodeActionTriggerKind",
  "CompletionItemKind",
  "CompletionItemTag",
  "CompletionTriggerKind",
  "ConfigurationTarget",
  "DecorationRangeBehavior",
  "DiagnosticSeverity",
  "DiagnosticTag",
  "DocumentHighlightKind",
  "EndOfLine",
  "FileType",
  "FoldingRangeKind",
  "IndentAction",
  "InlayHintKind",
  "LogLevel",
  "NotebookCellKind",
  "ProgressLocation",
  "SignatureHelpTriggerKind",
  "StatusBarAlignment",
  "SymbolKind",
  "SymbolTag",
  "TextDocumentChangeReason",
  "TextDocumentSaveReason",
  "TextEditorRevealType",
  "UIKind",
  "ViewColumn"
]) {
  vscode[name] = autoEnum();
}

class CodeActionKind {
  constructor(value) {
    this.value = value;
  }
  append(part) {
    return new CodeActionKind(this.value ? `${this.value}.${part}` : part);
  }
  contains(other) {
    return this.value === other.value || other.value.startsWith(this.value + ".");
  }
  intersects(other) {
    return this.contains(other) || other.contains(this);
  }
}
for (const [key, value] of Object.entries({
  Empty: "",
  QuickFix: "quickfix",
  Refactor: "refactor",
  RefactorExtract: "refactor.extract",
  RefactorInline: "refactor.inline",
  RefactorMove: "refactor.move",
  RefactorRewrite: "refactor.rewrite",
  Source: "source",
  SourceOrganizeImports: "source.organizeImports",
  SourceFixAll: "source.fixAll",
  Notebook: "notebook"
})) {
  CodeActionKind[key] = new CodeActionKind(value);
}
vscode.CodeActionKind = CodeActionKind;

module.exports = vscode;

module.exports.__mock = {
  events,
  responses,
  appliedEdits,
  statusItems,
  calls,
  registeredCommands,
  contentProviders,
  messages,
  configuration,
  outputChannels
};
