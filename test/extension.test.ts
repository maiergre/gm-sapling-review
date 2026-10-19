import { strict as assert } from "node:assert";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import Module from "node:module";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createHash } from "node:crypto";

type Disposable = { dispose(): void };
type MessageHandler = (message: unknown) => unknown;
type NodeModuleLoader = {
  _load(request: string, parent: NodeModule | null, isMain: boolean): unknown;
};

class Emitter<T> {
  private readonly listeners = new Set<(event: T) => unknown>();

  on(listener: (event: T) => unknown): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  fire(event: T): void {
    for (const listener of this.listeners) {
      void listener(event);
    }
  }
}

class FakeUri {
  readonly scheme: string;
  readonly fsPath: string;

  private constructor(fsPath: string, scheme = "file") {
    this.fsPath = fsPath;
    this.scheme = scheme;
  }

  static file(fsPath: string): FakeUri {
    return new FakeUri(fsPath);
  }

  toString(): string {
    return `${this.scheme}:${this.fsPath}`;
  }
}

class FakePosition {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

class FakeSelection {
  constructor(
    public readonly anchor: FakePosition,
    public readonly active: FakePosition,
  ) {}
}

class FakeRange {
  constructor(
    public readonly start: FakePosition,
    public readonly end: FakePosition,
  ) {}
}

type FakePanel = {
  webview: {
    html: string;
    options?: unknown;
    cspSource: string;
    messages: unknown[];
    onDidReceiveMessage(listener: MessageHandler): Disposable;
    emit(message: unknown): void;
    postMessage(message: unknown): Promise<boolean>;
    asWebviewUri(uri: FakeUri): FakeUri;
  };
  reveal(): void;
  dispose(): void;
  onDidDispose(listener: () => unknown): Disposable;
};

function makePanel(): FakePanel {
  const messageEmitter = new Emitter<unknown>();
  const disposeEmitter = new Emitter<void>();
  const messages: unknown[] = [];
  let disposed = false;
  return {
    webview: {
      html: "",
      cspSource: "vscode-resource:",
      messages,
      onDidReceiveMessage(listener) {
        return messageEmitter.on(listener);
      },
      emit(message) {
        messageEmitter.fire(message);
      },
      postMessage(message) {
        messages.push(message);
        return Promise.resolve(true);
      },
      asWebviewUri(uri) {
        return uri;
      },
    },
    reveal() {},
    dispose() {
      if (!disposed) {
        disposed = true;
        disposeEmitter.fire(undefined);
      }
    },
    onDidDispose(listener) {
      return disposeEmitter.on(listener);
    },
  };
}

type Host = {
  vscode: Record<string, unknown>;
  panels: FakePanel[];
  commands: Map<string, (...args: unknown[]) => unknown>;
  serializers: Map<
    string,
    { deserializeWebviewPanel(panel: FakePanel, state: unknown): unknown }
  >;
  savedDocument: Emitter<{ uri: FakeUri }>;
  execCalls: Array<{ file: string; args: string[]; cwd?: string }>;
  openedDocuments: Array<{ uri: FakeUri; lineCount: number }>;
  shownEditors: Array<{
    document: { uri: FakeUri; lineCount: number };
    options?: { preview?: boolean; viewColumn?: number };
    selection?: FakeSelection;
    reveal?: FakeRange;
    revealType?: number;
  }>;
  workspaceState: Map<string, unknown>;
  inputValues: string[];
  quickPickCalls: string[][];
  execFile(
    file: string,
    args: string[],
    options: { cwd?: string },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): void;
};

function makeHost(repo: string, storage: string): Host {
  const panels: FakePanel[] = [];
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const serializers = new Map<
    string,
    { deserializeWebviewPanel(panel: FakePanel, state: unknown): unknown }
  >();
  const savedDocument = new Emitter<{ uri: FakeUri }>();
  const execCalls: Host["execCalls"] = [];
  const openedDocuments: Host["openedDocuments"] = [];
  const shownEditors: Host["shownEditors"] = [];
  const workspaceState = new Map<string, unknown>();
  const inputValues: string[] = [];
  const quickPickCalls: string[][] = [];
  const configuration = {
    get<T>(_key: string, defaultValue?: T): T | undefined {
      return defaultValue;
    },
  };

  const execFile = (
    file: string,
    args: string[],
    options: { cwd?: string },
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execCalls.push({ file, args: [...args], cwd: options.cwd });
    if (args[0] === "root") {
      callback(null, `${options.cwd ?? repo}\n`, "");
    } else {
      callback(
        null,
        [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1,3 +1,3 @@",
          " one",
          "-two",
          "+two",
          " three",
          "",
        ].join("\n"),
        "",
      );
    }
  };

  const workspace = {
    isTrusted: true,
    workspaceFolders: [{ uri: FakeUri.file(repo) }],
    getConfiguration: () => configuration,
    onDidSaveTextDocument: (
      listener: (document: { uri: FakeUri }) => unknown,
    ) => savedDocument.on(listener),
    openTextDocument: async (uri: FakeUri) => {
      const contents = await readFile(uri.fsPath, "utf8");
      const document = { uri, lineCount: contents.split(/\r?\n/).length };
      openedDocuments.push(document);
      return document;
    },
    fs: {
      writeFile: async (uri: FakeUri, contents: Uint8Array) => {
        await writeFile(uri.fsPath, contents);
      },
    },
  };

  const window = {
    createWebviewPanel: () => {
      const panel = makePanel();
      panels.push(panel);
      return panel;
    },
    withProgress: async (
      _options: unknown,
      task: (progress: unknown, token: unknown) => Promise<unknown>,
    ) => task({ report() {} }, { isCancellationRequested: false }),
    showQuickPick: async (items: string[]) => {
      quickPickCalls.push(items);
      if (items.includes("Custom command")) return "Custom command";
      return items[0];
    },
    showInputBox: async () =>
      inputValues.shift() ?? 'sl diff --rev ".^" --include src/app.ts',
    showErrorMessage: async () => undefined,
    showSaveDialog: async () => undefined,
    showTextDocument: async (
      document: { uri: FakeUri; lineCount: number },
      options?: { preview?: boolean; viewColumn?: number },
    ) => {
      const editor = {
        document,
        options,
        selection: undefined as FakeSelection | undefined,
        reveal: undefined as FakeRange | undefined,
        revealType: undefined as number | undefined,
        revealRange(range: FakeRange, revealType?: number) {
          editor.reveal = range;
          editor.revealType = revealType;
        },
      };
      shownEditors.push(editor);
      return editor;
    },
  };

  const vscode = {
    Uri: {
      file: FakeUri.file,
      joinPath: (base: FakeUri, ...parts: string[]) =>
        FakeUri.file(path.join(base.fsPath, ...parts)),
    },
    Position: FakePosition,
    Selection: FakeSelection,
    Range: FakeRange,
    ViewColumn: { Active: 1, Beside: 2 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 1 },
    ProgressLocation: { Notification: 15 },
    workspace,
    window,
    commands: {
      registerCommand: (
        id: string,
        handler: (...args: unknown[]) => unknown,
      ) => {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
    },
    Disposable: {
      from: (...items: Disposable[]) => ({
        dispose: () => items.forEach((item) => item.dispose()),
      }),
    },
  } as unknown as Record<string, unknown>;

  (
    window as typeof window & {
      registerWebviewPanelSerializer?: (
        viewType: string,
        serializer: Host["serializers"] extends Map<string, infer V>
          ? V
          : never,
      ) => Disposable;
    }
  ).registerWebviewPanelSerializer = (viewType, serializer) => {
    serializers.set(viewType, serializer);
    return { dispose: () => serializers.delete(viewType) };
  };

  // The extension accesses this through `vscode.window.registerWebviewPanelSerializer`.
  (vscode.window as Record<string, unknown>).registerWebviewPanelSerializer = (
    window as typeof window & { registerWebviewPanelSerializer: Function }
  ).registerWebviewPanelSerializer;

  return {
    vscode,
    panels,
    commands,
    serializers,
    savedDocument,
    execCalls,
    openedDocuments,
    shownEditors,
    workspaceState,
    inputValues,
    quickPickCalls,
    execFile,
  };
}

function makeContext(host: Host, repo: string, storage: string) {
  return {
    globalStorageUri: FakeUri.file(storage),
    extensionUri: FakeUri.file(repo),
    globalState: {
      get<T>(key: string, fallback?: T): T {
        return (host.workspaceState.get(`global:${key}`) as T) ?? fallback!;
      },
      update: async (key: string, value: unknown) => {
        host.workspaceState.set(`global:${key}`, value);
      },
    },
    workspaceState: {
      get<T>(key: string, fallback?: T): T | undefined {
        return (host.workspaceState.get(key) as T | undefined) ?? fallback;
      },
      update: async (key: string, value: unknown) => {
        host.workspaceState.set(key, value);
      },
    },
    subscriptions: [] as Disposable[],
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for host operation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("activation persists custom review comments, runs custom diff arguments explicitly, and opens file lines", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "gm-sapling-extension-"));
  const repo = path.join(root, "repo");
  const storage = path.join(root, "storage");
  await writeFile(path.join(root, "placeholder"), "fixture");
  await mkdir(path.join(repo, "src"), { recursive: true });
  const file = path.join(repo, "src", "app.ts");
  await writeFile(file, "one\ntwo\nthree\n");

  const host = makeHost(repo, storage);
  const otherRepo = path.join(root, "second-repo");
  await mkdir(otherRepo);
  (host.vscode.workspace as any).workspaceFolders.push({
    uri: FakeUri.file(otherRepo),
  });
  const moduleLoader = Module as unknown as NodeModuleLoader;
  const originalLoad = moduleLoader._load;
  const childProcess = { execFile: host.execFile };
  moduleLoader._load = function (
    request: string,
    parent: NodeModule | null,
    isMain: boolean,
  ) {
    if (request === "vscode") return host.vscode;
    if (request === "node:child_process") return childProcess;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const extension =
      require("../src/extension") as typeof import("../src/extension");
    const context = makeContext(host, repo, storage);
    extension.activate(context as never);

    await host.commands.get("gmSapling.review")?.();
    assert.deepEqual(
      host.execCalls.filter((call) => call.args.includes("diff")).at(-1)?.args,
      [
        "--color",
        "never",
        "diff",
        "--git",
        "--rev",
        ".",
        "--unified",
        "1000000",
      ],
    );
    assert.equal(
      host.quickPickCalls.length,
      1,
      "Open Diff asks which repository to review when several are found",
    );
    await waitFor(() => host.panels.length === 1);
    const panel = host.panels[0];
    const initialState = panel.webview.messages
      .filter((message: any) => message.type === "state")
      .at(-1) as any;
    const reviewUpdatedAtBeforeExpansion =
      initialState?.reviews?.[0]?.updatedAt;
    const diffCalls = () =>
      host.execCalls.filter((call) => call.args.includes("diff"));
    const diffCallsBeforeExpansion = diffCalls().length;
    panel.webview.emit({
      type: "expandContext",
      file: "src/app.ts",
      direction: "above",
      contextLines: 1000000,
    });
    await waitFor(() => diffCalls().length > diffCallsBeforeExpansion);
    assert.deepEqual(diffCalls().at(-1), {
      file: "sl",
      args: [
        "--color",
        "never",
        "diff",
        "--git",
        "--rev",
        ".",
        "--unified",
        "1000000",
      ],
      cwd: repo,
    });
    const expandedState = panel.webview.messages
      .filter((message: any) => message.type === "state")
      .at(-1) as any;
    assert.equal(expandedState.contextLines, 1000000);
    assert.equal(
      expandedState.reviews[0].updatedAt,
      reviewUpdatedAtBeforeExpansion,
      "context expansion does not update review metadata",
    );
    const custom = host.commands.get("gmSapling.custom");
    assert.ok(custom, "custom review command should be registered");
    await custom?.();
    await waitFor(() => host.panels.length === 1);

    t.diagnostic(`exec calls: ${JSON.stringify(host.execCalls)}`);
    assert.deepEqual(diffCalls().at(-1)?.args, [
      "--color",
      "never",
      "diff",
      "--git",
      "--rev",
      ".^",
      "--include",
      "src/app.ts",
      "--unified",
      "1000000",
    ]);
    assert.equal(
      host.workspaceState.get("lastReview") != null,
      true,
      "review selection should survive restart",
    );
    assert.equal(host.panels.length, 1);

    const diffCallsBeforeToolbarRefresh = diffCalls().length;
    panel.webview.emit({
      type: "refresh",
      choice: "head",
      command: "sl diff --git --rev .^",
    });
    await waitFor(() => diffCalls().length > diffCallsBeforeToolbarRefresh);
    assert.deepEqual(diffCalls().at(-1), {
      file: "sl",
      args: [
        "--color",
        "never",
        "diff",
        "--git",
        "--rev",
        ".^",
        "--unified",
        "1000000",
      ],
      cwd: repo,
    });
    const diffCallsBeforeCustomRefresh = diffCalls().length;
    panel.webview.emit({
      type: "refresh",
      choice: "custom",
      command: "--rev .^ --include src/app.ts",
    });
    await waitFor(() => diffCalls().length > diffCallsBeforeCustomRefresh);
    assert.deepEqual(diffCalls().at(-1), {
      file: "sl",
      args: [
        "--color",
        "never",
        "diff",
        "--git",
        "--rev",
        ".^",
        "--include",
        "src/app.ts",
        "--unified",
        "1000000",
      ],
      cwd: repo,
    });
    panel.webview.emit({
      type: "saveComment",
      body: "Please keep this behavior.",
      anchor: {
        file: "src/app.ts",
        side: "new",
        start: 2,
        end: 2,
        text: ["two"],
      },
    });
    await waitFor(() =>
      panel.webview.messages.some(
        (message) =>
          (message as { comments?: unknown[] }).comments?.length === 1,
      ),
    );

    const state = () =>
      panel.webview.messages
        .filter((m: any) => m.type === "state")
        .at(-1) as any;
    const originalId = state().reviewId;
    assert.equal(originalId, "default");
    assert.deepEqual(state().repos, [repo, otherRepo]);
    panel.webview.emit({ type: "refresh", choice: "head" });
    await waitFor(() => state().command === "sl diff --git --rev .^");
    assert.equal(
      state().comments.length,
      1,
      "changing command keeps the same review's comments",
    );
    panel.webview.emit({
      type: "saveComments",
      comments: [
        {
          body: "Batch one",
          anchor: {
            file: "src/app.ts",
            side: "new",
            start: 1,
            end: 1,
            text: ["one"],
          },
        },
        {
          body: "Batch two",
          anchor: {
            file: "src/app.ts",
            side: "new",
            start: 3,
            end: 3,
            text: ["three"],
          },
        },
      ],
    });
    await waitFor(() => state().comments.length === 3);
    assert.equal(state().reviews[0].id, originalId);
    assert.ok(state().reviews[0].updatedAt);
    const errorsBefore = panel.webview.messages.filter(
      (m: any) => m.type === "error",
    ).length;
    panel.webview.emit({
      type: "saveComments",
      comments: [
        {
          body: "Must not partially save",
          anchor: {
            file: "src/app.ts",
            side: "new",
            start: 1,
            end: 1,
            text: ["one"],
          },
        },
        {
          body: "",
          anchor: {
            file: "src/app.ts",
            side: "new",
            start: 1,
            end: 1,
            text: ["one"],
          },
        },
      ],
    });
    await waitFor(
      () =>
        panel.webview.messages.filter((m: any) => m.type === "error").length >
        errorsBefore,
    );
    assert.equal(
      state().comments.length,
      3,
      "invalid batch must not partially save",
    );
    host.inputValues.push("Audit auth");
    panel.webview.emit({ type: "newReview" });
    await waitFor(() => state().reviewName === "Audit auth");
    const newId = state().reviewId;
    assert.notEqual(newId, originalId);
    assert.equal(state().comments.length, 0);
    host.inputValues.push("Audit renamed");
    panel.webview.emit({ type: "renameReview" });
    await waitFor(() => state().reviewName === "Audit renamed");
    assert.equal(state().reviewId, newId, "rename preserves review identity");
    assert.equal(state().reviews.length, 2);
    const windowApi = host.vscode.window as any;
    const saveDefaults: string[] = [];
    windowApi.showSaveDialog = async (options: any) => {
      saveDefaults.push(options.defaultUri.fsPath);
      return undefined;
    };
    panel.webview.emit({ type: "export" });
    await waitFor(() => saveDefaults.length === 1);
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    assert.equal(
      saveDefaults[0],
      path.join(repo, `00-review-Audit renamed-${date}.md`),
    );
    const manage = (action: string) =>
      panel.webview.emit({
        type: "manageReviewAction",
        action,
        repo,
        id: newId,
      });
    host.inputValues.push("Managed review");
    manage("rename");
    await waitFor(() => state().reviewName === "Managed review");
    manage("export");
    await waitFor(() => saveDefaults.length === 2);
    assert.equal(
      saveDefaults[1],
      path.join(repo, `00-review-Managed review-${date}.md`),
    );
    let confirmations = 0;
    windowApi.showWarningMessage = async (message: string, options: any) => {
      assert.match(message, /Managed review.*0 comments/);
      assert.equal(options.modal, true);
      confirmations++;
      return undefined;
    };
    manage("delete");
    await waitFor(() => confirmations === 1);
    assert.equal(state().reviewId, newId, "cancel preserves the review");
    windowApi.showWarningMessage = async () => "Delete";
    manage("delete");
    await waitFor(
      () => state().reviewId === originalId && state().reviews.length === 1,
    );
    assert.equal(
      state().comments.length,
      3,
      "deleting current review selects another without losing its comments",
    );
    panel.webview.emit({ type: "selectReview", id: originalId });
    await waitFor(
      () => state().reviewId === originalId && state().comments.length === 3,
    );
    panel.webview.emit({ type: "selectRepo", repo: otherRepo });
    await waitFor(() => state().repo === otherRepo && !!state().patch);
    assert.equal(state().comments.length, 0, "reviews isolated by repo");
    assert.equal(diffCalls().at(-1)?.cwd, otherRepo);
    const statesBeforeReturningRepo = panel.webview.messages.filter(
      (message: any) => message.type === "state",
    ).length;
    panel.webview.emit({ type: "selectRepo", repo });
    await waitFor(
      () =>
        state().repo === repo &&
        state().comments.length === 3 &&
        panel.webview.messages.filter(
          (message: any) => message.type === "state",
        ).length > statesBeforeReturningRepo,
    );
    panel.webview.emit({ type: "viewMode", mode: "split" });
    await waitFor(() => host.workspaceState.get("global:viewMode") === "split");
    panel.webview.emit({
      type: "refresh",
      choice: "custom",
      command: "--rev .^ --include src/app.ts",
    });
    await waitFor(
      () => state().command === "sl diff --git --rev '.^' --include src/app.ts",
    );

    const callsBeforeSave = diffCalls().length;
    const beforeFileSaveErrors = panel.webview.messages.filter(
      (m: any) => m.type === "error",
    ).length;
    host.savedDocument.fire({ uri: FakeUri.file(file) });
    await waitFor(
      () =>
        panel.webview.messages.filter((m: any) => m.type === "error").length >
        beforeFileSaveErrors,
    );
    assert.equal(
      diffCalls().length,
      callsBeforeSave,
      "custom commands must not rerun on file saves",
    );
    assert.ok(
      panel.webview.messages.some(
        (message) => (message as { type?: string }).type === "error",
      ),
    );

    panel.webview.emit({ type: "open", file: "src/app.ts", line: 2 });
    await waitFor(() => host.shownEditors.length > 0);
    assert.equal(
      await realpath(host.openedDocuments.at(-1)!.uri.fsPath),
      await realpath(file),
    );
    assert.equal(host.shownEditors.at(-1)?.selection?.anchor.line, 1);
    assert.deepEqual(host.shownEditors.at(-1)?.options, { preview: true });
    assert.equal(host.shownEditors.at(-1)?.revealType, 1);

    panel.dispose();
    const serializer = host.serializers.get("gmSapling.review");
    assert.ok(
      serializer,
      "webview serializer should be registered for restart recovery",
    );
    const restored = makePanel();
    await serializer?.deserializeWebviewPanel(restored, undefined);
    await waitFor(() =>
      restored.webview.messages.some(
        (message) =>
          (message as { comments?: unknown[] }).comments?.length === 3,
      ),
    );
    const restoredState = restored.webview.messages
      .map(
        (message) =>
          message as { type?: string; comments?: Array<{ body: string }> },
      )
      .find((message) => message.type === "state" && message.comments?.length);
    assert.equal((restoredState as any)?.viewMode, "split");
    assert.equal(
      restoredState?.comments?.[0]?.body,
      "Please keep this behavior.",
    );
    restored.dispose();
    const legacyCommand = "sl diff --rev legacy";
    const legacyPath = path.join(
      storage,
      createHash("sha256").update(`${repo}\0${legacyCommand}`).digest("hex") +
        ".json",
    );
    const legacy = {
      version: 1,
      repo,
      command: legacyCommand,
      comments: [
        {
          id: "legacy-note",
          body: "Keep my pre-upgrade review",
          anchor: {
            file: "src/app.ts",
            side: "new",
            start: 2,
            end: 2,
            text: ["two"],
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const originalLegacy = JSON.stringify(legacy);
    await writeFile(legacyPath, originalLegacy);
    host.workspaceState.set("lastReview", { repo, command: legacyCommand });
    host.workspaceState.set("lastReviewByRepo", {});
    extension.activate(makeContext(host, repo, storage) as never);
    await host.commands.get("gmSapling.review")?.();
    const upgraded = host.panels
      .at(-1)!
      .webview.messages.filter((m: any) => m.type === "state")
      .at(-1) as any;
    assert.equal(
      upgraded.command,
      "sl diff --git --rev .",
      "Open Diff still defaults to uncommitted after upgrade",
    );
    assert.equal(upgraded.comments[0].body, "Keep my pre-upgrade review");
    assert.notEqual(
      upgraded.reviewId,
      "default",
      "selected legacy review should survive upgrade",
    );
    assert.equal(await readFile(legacyPath, "utf8"), originalLegacy);
    const upgradedPanel = host.panels.at(-1)!;
    let bulkConfirmations = 0;
    windowApi.showWarningMessage = async (message: string, options: any) => {
      assert.match(message, /Delete all .* reviews and their .* comments/);
      assert.ok(message.includes(repo));
      assert.equal(options.modal, true);
      bulkConfirmations++;
      return undefined;
    };
    upgradedPanel.webview.emit({
      type: "manageReviewAction",
      repo,
      action: "deleteAll",
    });
    await waitFor(() => bulkConfirmations === 1);
    const latest = () =>
      upgradedPanel.webview.messages
        .filter((m: any) => m.type === "state")
        .at(-1) as any;
    assert.equal(latest().reviewId, upgraded.reviewId);
    windowApi.showWarningMessage = async () => "Delete all";
    upgradedPanel.webview.emit({
      type: "manageReviewAction",
      repo,
      action: "deleteAll",
    });
    await waitFor(
      () =>
        latest().reviewId === "default" &&
        latest().comments.length === 0 &&
        latest().reviews.length === 1,
    );
    const statesBeforeRepoSwitch = upgradedPanel.webview.messages.filter(
      (message: any) => message.type === "state",
    ).length;
    upgradedPanel.webview.emit({ type: "selectRepo", repo: otherRepo });
    await waitFor(
      () =>
        latest().repo === otherRepo &&
        upgradedPanel.webview.messages.filter(
          (message: any) => message.type === "state",
        ).length >=
          statesBeforeRepoSwitch + 2,
    );
    assert.ok(
      latest().reviews.length > 0,
      "bulk deletion leaves other repository reviews intact",
    );
  } finally {
    moduleLoader._load = originalLoad;
    await rm(root, { recursive: true, force: true });
    t.diagnostic(
      "The test uses a temporary repo and restores the module loader after activation.",
    );
  }
});
