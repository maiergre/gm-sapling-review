import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { realpath } from "node:fs/promises";
import { parse as parseDiff } from "diff2html";
import {
  ReviewStore,
  Review,
  Anchor,
  parseCommand,
  presetCommand,
  discoverRepositories,
  commentStatus,
  markdown,
} from "./core";

export function activate(context: vscode.ExtensionContext) {
  const store = new ReviewStore(context.globalStorageUri.fsPath);
  let panel: vscode.WebviewPanel | undefined;
  let review: Review | undefined;
  let patch = "";
  let repositories: string[] = [];
  let viewMode = context.globalState.get<"inline" | "split">(
    "viewMode",
    "inline",
  );
  let queue = Promise.resolve();
  const executable = () =>
    vscode.workspace
      .getConfiguration("gmSapling")
      .get<string>("commandPath", "sl");
  const run = (cwd: string, args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        executable(),
        args,
        {
          cwd,
          encoding: "utf8",
          timeout: 60000,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, HGPLAIN: "1", SL_AUTOMATION: "1" },
        },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || error.message));
          else resolve(stdout);
        },
      );
    });
  const validatePatch = (output: string) => {
    if (output.trim() && parseDiff(output).length === 0)
      throw new Error(
        "The command did not produce a unified diff. Try sl diff --git.",
      );
    return output;
  };
  const send = async () => {
    const reviews = review ? await store.list(review.repo) : [];
    return panel?.webview.postMessage({
      type: "state",
      repo: review?.repo,
      command: review?.command,
      repos: repositories,
      reviewId: review?.id,
      reviewName: review?.name,
      reviews,
      viewMode,
      patch,
      comments:
        review?.comments.map((c) => ({
          ...c,
          status: commentStatus(c.anchor, patch),
        })) ?? [],
    });
  };
  async function remember() {
    if (!review) return;
    await context.workspaceState.update("lastReview", {
      repo: review.repo,
      id: review.id,
    });
    const byRepo = context.workspaceState.get<Record<string, string>>(
      "lastReviewByRepo",
      {},
    );
    await context.workspaceState.update("lastReviewByRepo", {
      ...byRepo,
      [review.repo]: review.id,
    });
  }
  async function rememberedReview(repo: string): Promise<Review> {
    const byRepo = context.workspaceState.get<Record<string, string>>(
      "lastReviewByRepo",
      {},
    );
    if (byRepo[repo]) return store.load(repo, byRepo[repo]);
    const last = context.workspaceState.get<{
      repo: string;
      id?: string;
      command?: string;
    }>("lastReview");
    if (last?.repo === repo) {
      if (last.id) return store.load(repo, last.id);
      if (last.command) {
        const imported = await store.resolveLegacy(repo, last.command);
        if (imported) return imported;
      }
    }
    return store.load(repo);
  }
  async function discover() {
    repositories = await discoverRepositories(
      (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      async (dir) => {
        try {
          return (await run(dir, ["root"])).trim();
        } catch {
          return undefined;
        }
      },
    );
    if (review && !repositories.includes(review.repo))
      repositories.push(review.repo);
    return repositories;
  }
  const report = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    void panel?.webview.postMessage({ type: "error", message });
    void vscode.window.showErrorMessage(`Sapling Review: ${message}`);
  };
  const serial = (action: () => Promise<unknown>) => {
    queue = queue
      .then(action)
      .then(() => undefined)
      .catch(report);
    return queue;
  };
  const isPreset = (command: string) =>
    (["uncommitted", "head", "stack"] as const).some(
      (mode) => presetCommand(mode) === command,
    );
  type RequestedDiff = { choice?: string; command?: string };
  const commandForChoice = (requested: RequestedDiff): string => {
    switch (requested.choice) {
      case "uncommitted":
        return presetCommand("uncommitted");
      case "head":
        return presetCommand("head");
      case "stack":
        return presetCommand("stack");
      case "custom": {
        const command = requested.command?.trim();
        if (!command) throw new Error("A custom Sapling command is required.");
        parseCommand(command);
        return command;
      }
      default:
        throw new Error("Choose a Sapling diff preset.");
    }
  };
  async function refresh(requested?: RequestedDiff) {
    if (!review) return;
    if (!vscode.workspace.isTrusted)
      throw new Error("Trust this workspace before running Sapling commands.");
    const command = requested ? commandForChoice(requested) : review.command;
    const nextReview = { ...review, command };
    const next = await run(nextReview.repo, [
      "--color",
      "never",
      ...parseCommand(command),
    ]);
    validatePatch(next);
    const savedReview = { ...nextReview, patch: next };
    review = await store.save(savedReview);
    patch = next;
    await remember();
    await send();
  }
  async function choose(custom = false, requested?: RequestedDiff) {
    if (!vscode.workspace.isTrusted)
      throw new Error("Trust this workspace before running Sapling commands.");
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Finding Sapling repositories",
      },
      discover,
    );
    if (!repositories.length)
      throw new Error(
        "No Sapling repositories found in the workspace folders.",
      );
    const last = context.workspaceState.get<{ repo: string }>("lastReview");
    const repo =
      review?.repo ??
      (last && repositories.includes(last.repo) ? last.repo : repositories[0]);
    const selected =
      review?.repo === repo ? review : await rememberedReview(repo);
    let command = presetCommand("uncommitted");
    if (requested) command = commandForChoice(requested);
    else if (custom) {
      const entered = await vscode.window.showInputBox({
        title: "Sapling command producing a unified diff",
        value: selected.command,
        validateInput: (value) => {
          try {
            parseCommand(value);
            return undefined;
          } catch (e) {
            return String(e);
          }
        },
      });
      if (entered === undefined) return;
      parseCommand(entered);
      command = entered;
    }
    const nextPatch = validatePatch(
      await run(repo, ["--color", "never", ...parseCommand(command)]),
    );
    review = await store.save({ ...selected, command, patch: nextPatch });
    patch = nextPatch;
    await remember();
    ensurePanel();
    await send();
  }
  async function selectReview(repo: string, id: string) {
    review = await store.load(repo, id);
    patch = review.patch ?? "";
    await remember();
    await send();
    if (isPreset(review.command) && vscode.workspace.isTrusted) await refresh();
  }
  async function exportReview(selected: Review) {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const name =
      selected.name
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
        .trim()
        .replace(/[. ]+$/g, "") || "default";
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(selected.repo, `00-review-${name}-${date}.md`),
      ),
      filters: { Markdown: ["md"] },
    });
    if (target) {
      await vscode.workspace.fs.writeFile(
        target,
        Buffer.from(markdown(selected, selected.patch ?? ""), "utf8"),
      );
      await vscode.window.showTextDocument(target);
    }
  }
  async function renameReview(selected: Review) {
    const name = await vscode.window.showInputBox({
      title: "Rename review",
      value: selected.name,
      validateInput: (value) =>
        value.trim() ? undefined : "Enter a review name.",
    });
    if (name === undefined) return;
    const renamed = await store.rename(selected.repo, selected.id, name.trim());
    if (review?.repo === renamed.repo && review.id === renamed.id)
      review = renamed;
    await send();
  }
  async function manageReviewAction(message: {
    repo?: string;
    id?: string;
    action?: string;
  }) {
    if (!review || message.repo !== review.repo) return;
    const repo = review.repo;
    const summaries = await store.list(repo);
    if (message.action === "deleteAll") {
      const count = summaries.reduce(
        (total, item) => total + item.commentCount,
        0,
      );
      const confirmed = await vscode.window.showWarningMessage(
        `Delete all ${summaries.length} reviews and their ${count} comments in ${repo}?`,
        {
          modal: true,
          detail:
            "This permanently deletes all saved reviews for this repository. This cannot be undone. An empty Default review will be created.",
        },
        "Delete all",
      );
      if (confirmed !== "Delete all") return;
      for (const item of summaries) {
        await store.delete(repo, item.id);
        await panel?.webview.postMessage({
          type: "reviewsDeleted",
          repo,
          ids: [item.id],
        });
      }
      review = await store.save(await store.load(repo));
      patch = review.patch ?? "";
      await remember();
      await send();
      return;
    }
    if (!summaries.some((item) => item.id === message.id))
      throw new Error("The review no longer exists.");
    const selected = await store.load(repo, message.id!);
    switch (message.action) {
      case "open":
        await selectReview(repo, selected.id);
        break;
      case "rename":
        await renameReview(selected);
        break;
      case "export":
        await exportReview(selected);
        break;
      case "delete": {
        const confirmed = await vscode.window.showWarningMessage(
          `Delete review “${selected.name}” and its ${selected.comments.length} comments?`,
          {
            modal: true,
            detail:
              "This permanently deletes the saved review. This cannot be undone.",
          },
          "Delete",
        );
        if (confirmed !== "Delete") return;
        await store.delete(repo, selected.id);
        await panel?.webview.postMessage({
          type: "reviewsDeleted",
          repo,
          ids: [selected.id],
        });
        if (review.id === selected.id) {
          const remaining = await store.list(repo);
          review = remaining.length
            ? await store.load(repo, remaining[0].id)
            : await store.save(await store.load(repo));
          patch = review.patch ?? "";
          await remember();
        }
        await send();
        break;
      }
    }
  }
  function applyComment(
    next: Review,
    message: { id?: string; anchor: Anchor; body: string },
  ): Review {
    if (typeof message.body !== "string" || !message.body.trim())
      throw new Error("Enter a comment.");
    const anchor = message.anchor;
    if (
      !anchor ||
      typeof anchor.file !== "string" ||
      !["old", "new"].includes(anchor.side) ||
      !Number.isSafeInteger(anchor.start) ||
      !Number.isSafeInteger(anchor.end) ||
      anchor.start < 1 ||
      anchor.end < anchor.start ||
      !Array.isArray(anchor.text) ||
      anchor.text.length !== anchor.end - anchor.start + 1 ||
      !anchor.text.every((t) => typeof t === "string")
    )
      throw new Error("Invalid comment range.");
    const old = message.id
      ? next.comments.find((c) => c.id === message.id)
      : undefined;
    if (message.id && !old) throw new Error("The comment no longer exists.");
    const now = new Date().toISOString();
    const comment = {
      id: old?.id ?? randomUUID(),
      anchor: old?.anchor ?? anchor,
      body: message.body,
      createdAt: old?.createdAt ?? now,
      updatedAt: now,
    };
    return {
      ...next,
      comments: old
        ? next.comments.map((c) => (c.id === old.id ? comment : c))
        : [...next.comments, comment],
    };
  }
  function ensurePanel(existing?: vscode.WebviewPanel) {
    if (panel) {
      panel.reveal();
      return;
    }
    panel =
      existing ??
      vscode.window.createWebviewPanel(
        "gmSapling.review",
        "Sapling Review",
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(context.extensionUri, "dist"),
          ],
        },
      );
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    };
    const webview = panel.webview;
    const uri = (file: string) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(context.extensionUri, "dist", file),
      );
    const nonce = randomUUID();
    webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};"><link rel="stylesheet" href="${uri("highlight.css")}"><link rel="stylesheet" href="${uri("diff2html.css")}"><link rel="stylesheet" href="${uri("style.css")}"></head><body><div id="toolbar"></div><div id="status" role="status"></div><main id="diff"></main><section id="comments"></section><script nonce="${nonce}" src="${uri("main.js")}"></script></body></html>`;
    panel.onDidDispose(() => {
      panel = undefined;
    });
    webview.onDidReceiveMessage(
      (message) =>
        serial(async () => {
          if (!message || typeof message.type !== "string") return;
          if (message.type === "ready") {
            await send();
            return;
          }
          if (message.type === "viewMode") {
            if (message.mode === "inline" || message.mode === "split") {
              viewMode = message.mode;
              await context.globalState.update("viewMode", viewMode);
            }
            return;
          }
          if (message.type === "selectRepo") {
            if (typeof message.repo !== "string") return;
            if (!repositories.includes(message.repo)) await discover();
            if (!repositories.includes(message.repo))
              throw new Error("Repository is not in this workspace.");
            const selected = await rememberedReview(message.repo);
            await selectReview(message.repo, selected.id);
            return;
          }
          if (message.type === "refresh") {
            const requested: RequestedDiff = {
              choice:
                typeof message.choice === "string" ? message.choice : undefined,
              command:
                typeof message.command === "string"
                  ? message.command
                  : undefined,
            };
            if (review) await refresh(requested);
            else await choose(false, requested);
            return;
          }
          if (!review) return;
          switch (message.type) {
            case "selectReview": {
              if (typeof message.id !== "string") return;
              await selectReview(review.repo, message.id);
              break;
            }
            case "newReview": {
              const name = await vscode.window.showInputBox({
                title: "New review",
                prompt: "Optional review name",
                placeHolder: "Untitled review",
              });
              if (name === undefined) return;
              const next = await store.create(
                review.repo,
                name.trim() || "Untitled review",
                review.command,
              );
              review = await store.save({ ...next, patch });
              await remember();
              await send();
              break;
            }
            case "manageReviewAction": {
              await manageReviewAction(message);
              break;
            }
            case "renameReview": {
              await renameReview(review);
              break;
            }
            case "saveComment": {
              review = await store.save(applyComment(review, message));
              await send();
              break;
            }
            case "saveComments": {
              if (!Array.isArray(message.comments))
                throw new Error("Invalid comment batch.");
              let next = review;
              for (const comment of message.comments)
                next = applyComment(next, comment);
              review = await store.save(next);
              await send();
              break;
            }
            case "deleteComment": {
              const next = {
                ...review,
                comments: review.comments.filter((c) => c.id !== message.id),
              };
              review = await store.save(next);
              await send();
              break;
            }
            case "export": {
              await exportReview(review);
              break;
            }
            case "open": {
              if (
                typeof message.file !== "string" ||
                !Number.isSafeInteger(message.line) ||
                message.line < 1
              )
                return;
              const root = await realpath(review.repo);
              const file = await realpath(path.resolve(root, message.file));
              const relative = path.relative(root, file);
              if (
                relative.startsWith(".." + path.sep) ||
                relative === ".." ||
                path.isAbsolute(relative)
              )
                throw new Error("File is outside the repository.");
              const document = await vscode.workspace.openTextDocument(
                vscode.Uri.file(file),
              );
              const editor = await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.Beside,
                preview: true,
              });
              const position = new vscode.Position(
                Math.min(message.line - 1, document.lineCount - 1),
                0,
              );
              editor.selection = new vscode.Selection(position, position);
              editor.revealRange(new vscode.Range(position, position));
              break;
            }
          }
        }),
      undefined,
      context.subscriptions,
    );
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("gmSapling.review", () =>
      serial(() => choose()),
    ),
    vscode.commands.registerCommand("gmSapling.custom", () =>
      serial(() => choose(true)),
    ),
    vscode.window.registerWebviewPanelSerializer("gmSapling.review", {
      async deserializeWebviewPanel(restored) {
        const last = context.workspaceState.get<{
          repo: string;
          id?: string;
          command?: string;
        }>("lastReview");
        ensurePanel(restored);
        return serial(async () => {
          await discover();
          if (last) {
            const selected = await rememberedReview(last.repo);
            await selectReview(last.repo, selected.id);
          } else await send();
        });
      },
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (
        review &&
        panel &&
        document.uri.scheme === "file" &&
        document.uri.fsPath.startsWith(review.repo + path.sep)
      ) {
        // Custom commands run only on explicit refresh; they can have side effects.
        if (isPreset(review.command)) serial(refresh);
        else
          void panel.webview.postMessage({
            type: "error",
            message:
              "Files changed. Refresh the custom diff to update comment locations.",
          });
      }
    }),
  );
}
