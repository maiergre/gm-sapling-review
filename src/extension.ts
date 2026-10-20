import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { parse as parseDiff } from "diff2html";
import {
  ComparisonSnapshot,
  ExpandedContextRange,
  ReviewStore,
  Review,
  Anchor,
  comparisonSnapshot,
  parseCommand,
  presetCommand,
  discoverRepositories,
  commentStatus,
  markdown,
} from "./core";

const INITIAL_CONTEXT_LINES = 4;
const EXPANSION_LINES = 30;
const MAX_EXPANSION_LINES = 200;
const MAX_COMMAND_OUTPUT = 32 * 1024 * 1024;

export function activate(context: vscode.ExtensionContext) {
  const store = new ReviewStore(context.globalStorageUri.fsPath);
  let panel: vscode.WebviewPanel | undefined;
  let review: Review | undefined;
  let patch = "";
  let contextLines = INITIAL_CONTEXT_LINES;
  let repositories: string[] = [];
  let repositoryDirectories = new Map<string, string>();
  const repositoryWorkspaceIndexes = new Map<string, number>();
  let repositoryUriDirectories = new Map<string, string>();
  let viewMode = context.globalState.get<"inline" | "split">(
    "viewMode",
    "inline",
  );
  let queue = Promise.resolve();
  const executable = () => {
    const configured = vscode.workspace
      .getConfiguration("gmSapling")
      .get<string>("commandPath", "");
    if (configured?.trim()) return configured.trim();
    return process.platform === "win32" ? "sl.exe" : "sl";
  };
  const run = (cwd: string, args: string[]) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        executable(),
        args,
        {
          cwd,
          encoding: "utf8",
          timeout: 60000,
          maxBuffer: MAX_COMMAND_OUTPUT,
          env: {
            ...process.env,
            HGENCODING: "UTF-8",
            SL_ENCODING: "UTF-8",
            SL_AUTOMATION: "true",
            // Permit the revset, progress, identity, and sniffing operations
            // that upstream allows while still keeping the process non-
            // interactive.
            SL_AUTOMATION_EXCEPT: "ghrevset,phrevset,progress,sniff,username",
            EDITOR: undefined,
            VISUAL: undefined,
            HGUSER: undefined,
            HGEDITOR: process.platform === "win32" ? "exit /b 1" : "false",
            LANG:
              process.env.LANG && /UTF-8$/i.test(process.env.LANG)
                ? process.env.LANG
                : "C.UTF-8",
          },
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout);
            return;
          }
          const details = stderr.trim();
          const typed = error as NodeJS.ErrnoException & {
            killed?: boolean;
            signal?: string;
          };
          let message: string;
          if (typed.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
            message =
              "Sapling command output exceeded the 32 MiB limit. Narrow the diff to fewer files.";
          else if (typed.killed || typed.signal === "SIGTERM")
            message = "Sapling command timed out after 60 seconds.";
          else if (typed.code === "ENOENT")
            message = `Sapling executable was not found: ${executable()}`;
          else if (typeof typed.code === "number")
            message = `Sapling command failed with exit status ${typed.code}${details ? `: ${details}` : ""}`;
          else message = details || error.message;
          reject(new Error(message, { cause: error }));
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
      directory: review?.directory ?? review?.repo,
      command: review?.command,
      repos: repositories,
      reviewId: review?.id,
      reviewName: review?.name,
      customCommand: review ? customArgsForCommand(review.command) : undefined,
      reviews,
      viewMode,
      contextLines,
      canExpandContext: review ? isDiffCommand(review.command) : false,
      patch,
      snapshot: review?.snapshot,
      expandedRanges: review?.snapshot?.expandedRanges ?? [],
      comments:
        review?.comments.map((c) => ({
          ...c,
          status: commentStatus(c.anchor, patch, review?.snapshot),
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
    const isStalePointer = (error: unknown): boolean =>
      error instanceof Error &&
      (/^Review not found:/.test(error.message) ||
        /^Malformed review file:/.test(error.message) ||
        /^Review (?:file has an invalid shape|comparison snapshot|comments|comment)/.test(
          error.message,
        ) ||
        /^Review file repository or id does not match its key/.test(
          error.message,
        ));
    if (typeof byRepo[repo] === "string" && byRepo[repo]) {
      try {
        return await store.load(repo, byRepo[repo]);
      } catch (error) {
        if (!isStalePointer(error)) throw error;
        const next = { ...byRepo };
        delete next[repo];
        await context.workspaceState.update("lastReviewByRepo", next);
      }
    }
    const last = context.workspaceState.get<{
      repo: string;
      id?: string;
      command?: string;
    }>("lastReview");
    if (last?.repo === repo) {
      if (last.id) {
        try {
          return await store.load(repo, last.id);
        } catch (error) {
          if (!isStalePointer(error)) throw error;
          await context.workspaceState.update("lastReview", undefined);
        }
      }
      if (last.command) {
        const imported = await store.resolveLegacy(repo, last.command);
        if (imported) return imported;
      }
    }
    try {
      return await store.load(repo);
    } catch (error) {
      if (!isStalePointer(error)) throw error;
      // Preserve a corrupt Default file for recovery rather than overwrite it.
      return store.create(repo, "Default");
    }
  }
  async function discover() {
    const workspaceDirectories = (vscode.workspace.workspaceFolders ?? []).map(
      (folder) => folder.uri.fsPath,
    );
    repositories = await discoverRepositories(
      workspaceDirectories,
      async (dir) => {
        try {
          return (await run(dir, ["root"])).trim();
        } catch {
          return undefined;
        }
      },
    );
    repositoryDirectories = new Map();
    repositoryUriDirectories = new Map();
    repositoryWorkspaceIndexes.clear();
    for (const repository of repositories) {
      for (const directory of workspaceDirectories) {
        let canonicalDirectory: string;
        try {
          canonicalDirectory = await fs.realpath(directory);
        } catch {
          canonicalDirectory = path.resolve(directory);
        }
        if (
          !pathWithin(canonicalDirectory, repository) &&
          !pathWithin(repository, canonicalDirectory)
        )
          continue;
        repositoryDirectories.set(
          repository,
          pathWithin(repository, canonicalDirectory)
            ? canonicalDirectory
            : repository,
        );
        repositoryUriDirectories.set(repository, canonicalDirectory);
        repositoryWorkspaceIndexes.set(
          repository,
          workspaceDirectories.indexOf(directory),
        );
        break;
      }
    }
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
  const isDiffCommand = (command: string) => {
    try {
      return parseCommand(command)[0] === "diff";
    } catch {
      return false;
    }
  };
  const quoteCommandArg = (arg: string): string =>
    /^[A-Za-z0-9_./:@%+=,-]+$/.test(arg)
      ? arg
      : `'${arg.replaceAll("'", "'\\''")}'`;
  const formatCommandArgs = (args: string[]): string =>
    args.map(quoteCommandArg).join(" ");
  const customArgsFromCommand = (
    command: string,
    rejectInternal = false,
  ): string[] => {
    const args = parseCommand(command);
    const legacyFullCommand = args[0] === "diff";
    const commandArgs = legacyFullCommand ? args.slice(1) : args;
    const normalized: string[] = [];
    let separator = false;
    for (let index = 0; index < commandArgs.length; index += 1) {
      const arg = commandArgs[index];
      if (arg === "--") {
        separator = true;
        normalized.push(arg);
        continue;
      }
      if (!separator && arg === "--git") {
        if (rejectInternal && !legacyFullCommand)
          throw new Error("Custom diff arguments must not include --git.");
        continue;
      }
      if (
        !separator &&
        (arg === "--binary" ||
          arg === "--no-binary" ||
          arg === "--nodate" ||
          arg === "--nodates" ||
          arg === "--color")
      ) {
        if (rejectInternal && !legacyFullCommand)
          throw new Error(
            "Custom diff arguments must not include extension-owned diff flags.",
          );
        if (arg === "--color") index += 1;
        continue;
      }
      if (!separator && /^--color=/.test(arg)) {
        if (rejectInternal && !legacyFullCommand)
          throw new Error(
            "Custom diff arguments must not include extension-owned diff flags.",
          );
        continue;
      }
      if (!separator && (arg === "--unified" || arg === "-U")) {
        if (rejectInternal && !legacyFullCommand)
          throw new Error("Custom diff arguments must not include --unified.");
        index += 1;
        continue;
      }
      if (!separator && (/^--unified=/.test(arg) || /^-U\d+$/.test(arg))) {
        if (rejectInternal && !legacyFullCommand)
          throw new Error("Custom diff arguments must not include --unified.");
        continue;
      }
      normalized.push(arg);
    }
    return normalized;
  };
  const canonicalCustomCommand = (input: string): string =>
    formatCommandArgs([
      "sl",
      "diff",
      "--git",
      ...customArgsFromCommand(input, true),
    ]);
  const customArgsForCommand = (command: string): string => {
    try {
      return formatCommandArgs(customArgsFromCommand(command));
    } catch {
      return "";
    }
  };
  const diffArgsWithContext = (
    command: string,
    lines = INITIAL_CONTEXT_LINES,
    scopedFile?: string | string[],
  ): string[] => {
    const args = parseCommand(command);
    if (args[0] !== "diff")
      throw new Error("Only sl diff commands support context expansion.");
    const normalized: string[] = [];
    let separatorSeen = false;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--") separatorSeen = true;
      if (!separatorSeen && (arg === "--unified" || arg === "-U")) {
        index += 1;
        continue;
      }
      if (
        !separatorSeen &&
        (arg === "--git" ||
          arg === "--binary" ||
          arg === "--no-binary" ||
          arg === "--nodate" ||
          arg === "--nodates" ||
          arg === "--color")
      ) {
        if (arg === "--color") index += 1;
        continue;
      }
      if (!separatorSeen && /^--color=/.test(arg)) continue;
      if (!separatorSeen && (/^--unified=/.test(arg) || /^-U\d+$/.test(arg)))
        continue;
      normalized.push(arg);
    }
    const separator = normalized.indexOf("--");
    normalized.splice(
      separator < 0 ? normalized.length : separator,
      0,
      "--git",
      "--no-binary",
      "--nodate",
      "--color",
      "never",
      "--unified",
      String(lines),
    );
    if (scopedFile !== undefined) {
      // Include filters intersect existing positional arguments. Adding a
      // positional filename would instead broaden the user's selection.
      const boundary = normalized.indexOf("--");
      const paths = typeof scopedFile === "string" ? [scopedFile] : scopedFile;
      normalized.splice(
        boundary < 0 ? normalized.length : boundary,
        0,
        ...[...new Set(paths)]
          .filter((file) => file !== "/dev/null")
          .flatMap((file) => ["--include", `path:${file}`]),
      );
    }
    return normalized;
  };

  const commandDirectory = (candidate: Review): string =>
    candidate.directory?.trim() || candidate.repo;

  const userArgsForSnapshot = (command: string): string[] => {
    try {
      return customArgsFromCommand(command);
    } catch {
      return [];
    }
  };

  const makeSnapshot = async (
    candidate: Review,
    command: string,
    output: string,
  ): Promise<ComparisonSnapshot> => {
    const snapshot = comparisonSnapshot(
      candidate.repo,
      commandDirectory(candidate),
      command,
      userArgsForSnapshot(command),
      [
        "--git",
        "--no-binary",
        "--nodate",
        "--color",
        "never",
        "--unified",
        String(INITIAL_CONTEXT_LINES),
      ],
      output,
    );
    for (const side of ["old", "new"] as const) {
      const source = revisionForSide(command, side);
      if (source.kind !== "revision") continue;
      try {
        const node = (
          await run(candidate.repo, [
            "log",
            "-r",
            source.revision,
            "-T",
            "{node}\n",
          ])
        ).trim();
        if (/^[0-9a-f]{40}$/.test(node))
          snapshot[side === "old" ? "oldRevision" : "newRevision"] = node;
      } catch {
        /* A custom comparison may still have a valid patch. */
      }
    }
    return snapshot;
  };

  const normalizedRelativePath = (file: string): string => {
    const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
    if (
      !normalized ||
      normalized === "." ||
      normalized.startsWith("/") ||
      normalized.split("/").includes("..")
    )
      throw new Error("The comparison file is outside the repository.");
    return normalized;
  };

  const pathWithin = (root: string, candidate: string): boolean => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (!relative.startsWith(".." + path.sep) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    );
  };

  const uriForRepositoryPath = (
    file: string,
    repository?: string,
  ): vscode.Uri => {
    const canonicalFolder =
      repository && repositoryUriDirectories.get(repository);
    const folders = vscode.workspace.workspaceFolders ?? [];
    // Discovery records the canonical path separately from the URI spelling.
    const index = repository
      ? repositoryWorkspaceIndexes.get(repository)
      : undefined;
    const folder =
      index !== undefined
        ? folders[index]
        : folders.find((f) => pathWithin(f.uri.fsPath, file));
    if (!folder || folder.uri.scheme === "file") return vscode.Uri.file(file);
    return vscode.Uri.joinPath(
      folder.uri,
      path.relative(canonicalFolder || folder.uri.fsPath, file),
    );
  };

  type ComparisonSource =
    | { kind: "revision"; revision: string }
    | { kind: "workingCopy" }
    | { kind: "unresolved" };

  const revisionForSide = (
    command: string,
    side: "old" | "new",
  ): ComparisonSource => {
    let args: string[];
    try {
      args = parseCommand(command);
    } catch {
      return { kind: "unresolved" };
    }
    const revisions: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--") break;
      if (
        arg === "--change" ||
        arg === "-c" ||
        /^-c.+/.test(arg) ||
        arg.startsWith("--change=")
      )
        return { kind: "unresolved" };
      if (arg === "--rev" || arg === "-r") {
        const revision = args[++index];
        if (revision) revisions.push(revision);
      } else if (arg.startsWith("--rev="))
        revisions.push(arg.slice("--rev=".length));
      else if (arg.startsWith("-r") && arg.length > 2)
        revisions.push(arg.slice(2));
    }
    const revision = side === "old" ? (revisions[0] ?? ".") : revisions[1];
    if (revision === undefined) return { kind: "workingCopy" };
    // Expressions involving a range or revset cannot be mapped to one cat
    // revision without changing comparison semantics. They must go through
    // the file-scoped diff fallback, never be mistaken for working-copy text.
    if (/[,:;]|\.\./.test(revision)) return { kind: "unresolved" };
    return { kind: "revision", revision };
  };

  const sourceKeyFor = (
    candidate: Review,
    side: "old" | "new",
    file: string,
  ): string =>
    createHash("sha256")
      .update(
        `${candidate.command}\0${commandDirectory(candidate)}\0${side}\0${file}\0${candidate.snapshot?.patch ?? candidate.patch ?? ""}`,
      )
      .digest("hex");

  type ContextRequest = {
    file?: unknown;
    direction?: unknown;
    regionId?: unknown;
    oldStart?: unknown;
    oldEnd?: unknown;
    newStart?: unknown;
    newEnd?: unknown;
  };

  type ContextResponse = {
    region: ExpandedContextRange;
    oldLines: string[];
    newLines: string[];
    patch: string;
    sourceKey: string;
  };

  const boundedNumber = (value: unknown): number | undefined =>
    Number.isSafeInteger(value) && (value as number) >= 1
      ? (value as number)
      : undefined;

  const rangeFromRequest = (
    request: ContextRequest,
    candidate: Review,
  ): ExpandedContextRange => {
    const file = normalizedRelativePath(String(request.file ?? ""));
    const direction = request.direction;
    if (
      direction !== "above" &&
      direction !== "below" &&
      direction !== "between"
    )
      throw new Error("Invalid context expansion direction.");
    let oldStart = boundedNumber(request.oldStart);
    let oldEnd = boundedNumber(request.oldEnd);
    let newStart = boundedNumber(request.newStart);
    let newEnd = boundedNumber(request.newEnd);
    const comparisonFile = (
      candidate.snapshot?.files ??
      comparisonSnapshot(
        candidate.repo,
        commandDirectory(candidate),
        candidate.command,
        [],
        [],
        candidate.patch ?? "",
      ).files
    ).find((item) => item.oldPath === file || item.newPath === file);
    const oldFile = comparisonFile?.oldPath ?? file;
    const newFile = comparisonFile?.newPath ?? file;
    const parsed = candidate.snapshot?.patch ?? candidate.patch ?? "";
    if ((!oldStart || !oldEnd || !newStart || !newEnd) && parsed) {
      const found = parseDiff(parsed).find((item) =>
        [item.oldName, item.newName]
          .filter((name): name is string => !!name)
          .some((name) => normalizedRelativePath(name) === file),
      );
      const blocks = found?.blocks ?? [];
      const first = blocks[0]?.header?.match(
        /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/,
      );
      const last = blocks
        .at(-1)
        ?.header?.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/);
      if (first && last) {
        const firstOld = Number(first[1]);
        const firstOldCount = Number(first[2] ?? 1);
        const firstNew = Number(first[3]);
        const firstNewCount = Number(first[4] ?? 1);
        const lastOld = Number(last[1]);
        const lastOldCount = Number(last[2] ?? 1);
        const lastNew = Number(last[3]);
        const lastNewCount = Number(last[4] ?? 1);
        if (direction === "above") {
          oldEnd ??= Math.max(1, firstOld - 1);
          newEnd ??= Math.max(1, firstNew - 1);
          oldStart ??= Math.max(1, oldEnd - EXPANSION_LINES + 1);
          newStart ??= Math.max(1, newEnd - EXPANSION_LINES + 1);
        } else if (direction === "below") {
          oldStart ??= lastOld + lastOldCount;
          newStart ??= lastNew + lastNewCount;
          oldEnd ??= oldStart + EXPANSION_LINES - 1;
          newEnd ??= newStart + EXPANSION_LINES - 1;
        } else {
          oldStart ??= firstOld + firstOldCount;
          newStart ??= firstNew + firstNewCount;
          oldEnd ??= Math.max(oldStart, lastOld - 1);
          newEnd ??= Math.max(newStart, lastNew - 1);
        }
      }
    }
    oldStart ??= 1;
    newStart ??= 1;
    oldEnd ??= oldStart + EXPANSION_LINES - 1;
    newEnd ??= newStart + EXPANSION_LINES - 1;
    // A single click is deliberately bounded. The UI asks again with the
    // next range when a gap is larger than this, so one expansion cannot
    // turn a four-line patch into an unbounded source dump.
    const perClickLimit = Math.min(EXPANSION_LINES, MAX_EXPANSION_LINES);
    oldEnd = Math.max(
      oldStart - 1,
      Math.min(oldEnd, oldStart + perClickLimit - 1),
    );
    newEnd = Math.max(
      newStart - 1,
      Math.min(newEnd, newStart + perClickLimit - 1),
    );
    const id =
      typeof request.regionId === "string" && request.regionId.trim()
        ? request.regionId
        : `${file}:${direction}:${oldStart}-${oldEnd}:${newStart}-${newEnd}`;
    return {
      id,
      file,
      oldFile,
      newFile,
      direction,
      oldStart,
      oldEnd,
      newStart,
      newEnd,
    };
  };

  const linesFromPatch = (
    output: string,
    file: string,
    side: "old" | "new",
    start: number,
    end: number,
  ): string[] => {
    if (end < start) return [];
    const parsed = parseDiff(output).find((item) =>
      [item.oldName, item.newName]
        .filter((name): name is string => !!name)
        .some((name) => normalizedRelativePath(name) === file),
    );
    if (!parsed) return [];
    return parsed.blocks
      .flatMap((block) => block.lines)
      .filter((line) => {
        const number = side === "old" ? line.oldNumber : line.newNumber;
        return number !== undefined && number >= start && number <= end;
      })
      .map((line) => (line.content.length ? line.content.slice(1) : ""));
  };

  const changedSignature = (output: string, file: string): string => {
    try {
      const parsed = parseDiff(output).find((item) =>
        [item.oldName, item.newName]
          .filter((name): name is string => !!name)
          .some((name) => normalizedRelativePath(name) === file),
      );
      return (parsed?.blocks ?? [])
        .flatMap((block) => block.lines)
        .filter((line) => line.type !== "context")
        .map(
          (line) =>
            `${line.type}:${line.oldNumber ?? ""}:${line.newNumber ?? ""}:${line.content.length ? line.content.slice(1) : ""}`,
        )
        .join("\n");
    } catch {
      return "";
    }
  };

  const gapsForFile = (candidate: Review, file: string) => {
    const parsed = parseDiff(
      candidate.snapshot?.patch ?? candidate.patch ?? "",
    ).find((f) => f.oldName === file || f.newName === file);
    if (!parsed || parsed.isNew || parsed.isDeleted || !parsed.blocks.length)
      return [];
    const gaps: Array<{
      oldStart: number;
      newStart: number;
      oldEnd: number;
      newEnd: number;
    }> = [];
    let oldStart = 1,
      newStart = 1;
    for (const block of parsed.blocks) {
      const match = block.header.match(
        /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/,
      );
      if (!match) continue;
      const old = Number(match[1]),
        next = Number(match[3]);
      if (old > oldStart && next > newStart)
        gaps.push({ oldStart, newStart, oldEnd: old - 1, newEnd: next - 1 });
      oldStart = old + Number(match[2] ?? 1);
      newStart = next + Number(match[4] ?? 1);
    }
    gaps.push({ oldStart, newStart, oldEnd: Infinity, newEnd: Infinity });
    return gaps;
  };

  const readContext = async (
    candidate: Review,
    region: ExpandedContextRange,
  ): Promise<ContextResponse> => {
    const basePatch = candidate.snapshot?.patch ?? candidate.patch ?? "";
    const cached = candidate.snapshot?.sourceRanges.find(
      (r) =>
        r.id === region.id &&
        r.oldStart === region.oldStart &&
        r.newStart === region.newStart,
    );
    if (cached?.oldLines && cached.newLines)
      return {
        region: {
          ...region,
          oldEnd: region.oldStart + cached.oldLines.length - 1,
          newEnd: region.newStart + cached.newLines.length - 1,
        },
        oldLines: cached.oldLines,
        newLines: cached.newLines,
        patch: "",
        sourceKey: cached.sourceKey,
      };
    const gap = gapsForFile(candidate, region.file).find(
      (g) =>
        region.oldStart >= g.oldStart &&
        region.newStart >= g.newStart &&
        region.oldEnd <= g.oldEnd &&
        region.newEnd <= g.newEnd &&
        region.oldStart - g.oldStart === region.newStart - g.newStart,
    );
    if (
      !gap ||
      region.oldEnd - region.oldStart !== region.newEnd - region.newStart
    )
      throw new Error(
        "This context range no longer matches the comparison. Refresh the review.",
      );
    const sourceLines = (text: string) => {
      const lines = text ? text.split(/\r?\n/) : [];
      if (lines.at(-1) === "") lines.pop();
      return lines;
    };
    const readSide = async (
      side: "old" | "new",
      start: number,
      end: number,
    ): Promise<string[]> => {
      const file =
        side === "old"
          ? (region.oldFile ?? region.file)
          : (region.newFile ?? region.file);
      const pinned =
        candidate.snapshot?.[side === "old" ? "oldRevision" : "newRevision"];
      const source = pinned
        ? { kind: "revision" as const, revision: pinned }
        : revisionForSide(candidate.command, side);
      if (source.kind === "unresolved")
        throw new Error("Unresolved comparison side");
      let text: string;
      if (source.kind === "workingCopy") {
        const root = await fs.realpath(candidate.repo);
        const filename = await fs.realpath(
          path.resolve(root, normalizedRelativePath(file)),
        );
        if (!pathWithin(root, filename))
          throw new Error("File is outside the repository.");
        if ((await fs.stat(filename)).size > MAX_COMMAND_OUTPUT)
          throw new Error(
            "Source exceeds the 32 MiB limit. Narrow the comparison.",
          );
        text = await fs.readFile(filename, "utf8");
      } else {
        text = await run(candidate.repo, [
          "cat",
          "--rev",
          source.revision,
          "--",
          file,
        ]);
      }
      return sourceLines(text).slice(start - 1, end);
    };
    let oldLines: string[] | undefined, newLines: string[] | undefined;
    try {
      oldLines = await readSide("old", region.oldStart, region.oldEnd);
    } catch {
      /* scoped fallback below */
    }
    try {
      newLines = await readSide("new", region.newStart, region.newEnd);
    } catch {
      /* scoped fallback below */
    }
    // Only the selected file is rerun. Known source sides use a four-line
    // validation patch; unresolved custom comparisons get bounded extra context.
    const distance =
      Math.min(
        region.oldEnd - gap.oldStart + 1,
        Number.isFinite(gap.oldEnd)
          ? gap.oldEnd - region.oldStart + 1
          : Infinity,
      ) + INITIAL_CONTEXT_LINES;
    const fallback = oldLines === undefined || newLines === undefined;
    if (fallback && distance > 100_000)
      throw new Error(
        "This custom comparison needs too much context. Narrow the diff or use explicit --rev arguments.",
      );
    const scopedPatch = validatePatch(
      await run(commandDirectory(candidate), [
        "--color",
        "never",
        ...diffArgsWithContext(
          candidate.command,
          fallback
            ? Math.max(EXPANSION_LINES, distance)
            : INITIAL_CONTEXT_LINES,
          [region.oldFile ?? region.file, region.newFile ?? region.file],
        ),
      ]),
    );
    if (
      changedSignature(basePatch, region.file) !==
      changedSignature(scopedPatch, region.file)
    )
      throw new Error(
        `The comparison changed while loading ${region.file}. Refresh the review and try again.`,
      );
    if (oldLines === undefined)
      oldLines = linesFromPatch(
        scopedPatch,
        region.file,
        "old",
        region.oldStart,
        region.oldEnd,
      );
    if (newLines === undefined)
      newLines = linesFromPatch(
        scopedPatch,
        region.file,
        "new",
        region.newStart,
        region.newEnd,
      );
    if (
      oldLines.length !== newLines.length ||
      oldLines.some((line, i) => line !== newLines![i])
    )
      throw new Error(
        "The requested lines are no longer unchanged context. Refresh the review.",
      );
    const count = region.oldEnd - region.oldStart + 1;
    if (Number.isFinite(gap.oldEnd) && oldLines.length !== count)
      throw new Error(
        "Unable to resolve the complete context range. Refresh the review.",
      );
    return {
      region: {
        ...region,
        oldEnd: region.oldStart + oldLines.length - 1,
        newEnd: region.newStart + newLines.length - 1,
      },
      oldLines,
      newLines,
      patch: "",
      sourceKey: sourceKeyFor(candidate, "new", region.file),
    };
  };
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
        if (!command) throw new Error("Custom diff arguments are required.");
        return canonicalCustomCommand(command);
      }
      default:
        throw new Error("Choose a Sapling diff preset.");
    }
  };
  async function refresh(requested?: RequestedDiff) {
    if (!review) return;
    if (!vscode.workspace.isTrusted)
      throw new Error("Trust this workspace before running Sapling commands.");
    const command = requested
      ? commandForChoice(requested)
      : isPreset(review.command)
        ? review.command
        : canonicalCustomCommand(review.command);
    const nextReview = {
      ...review,
      command,
      directory: review.directory ?? review.repo,
    };
    const next = await run(commandDirectory(nextReview), [
      "--color",
      "never",
      ...diffArgsWithContext(command),
    ]);
    validatePatch(next);
    const snapshot = await makeSnapshot(nextReview, command, next);
    const savedReview = { ...nextReview, patch: next, snapshot };
    review = await store.save(savedReview);
    patch = next;
    contextLines = INITIAL_CONTEXT_LINES;
    await restoreCommentContexts();
    await remember();
    await send();
  }

  async function expandContext(message: ContextRequest) {
    if (!review || !isDiffCommand(review.command)) return;
    if (!vscode.workspace.isTrusted)
      throw new Error("Trust this workspace before expanding diff context.");
    const requestedRegion = rangeFromRequest(message, review);
    const response = await readContext(review, requestedRegion);
    const region = response.region;
    const prior =
      review.snapshot ?? (await makeSnapshot(review, review.command, patch));
    const snapshot: ComparisonSnapshot = {
      ...prior,
      patch: prior.patch || patch,
      expandedRanges: [
        ...prior.expandedRanges.filter((item) => item.id !== region.id),
        region,
      ],
      sourceRanges: [
        ...prior.sourceRanges.filter((item) => item.id !== region.id),
        {
          id: region.id,
          file: region.file,
          oldFile: region.oldFile,
          newFile: region.newFile,
          oldStart: region.oldStart,
          oldLines: response.oldLines,
          newStart: region.newStart,
          newLines: response.newLines,
          sourceKey: response.sourceKey,
          endOfFile:
            region.direction === "below" &&
            response.oldLines.length < EXPANSION_LINES,
        },
      ],
    };
    // Snapshot writes are intentionally separate from review edits. A failed
    // expansion therefore leaves the last successful patch and comments
    // intact, while a successful one survives a panel restart.
    review = await store.saveSnapshot(review, snapshot);
    patch = snapshot.patch;
    contextLines = INITIAL_CONTEXT_LINES;
    await panel?.webview.postMessage({
      type: "contextExpanded",
      regionId: region.id,
      file: region.file,
      direction: region.direction,
      oldStart: region.oldStart,
      oldEnd: region.oldEnd,
      newStart: region.newStart,
      newEnd: region.newEnd,
      oldLines: response.oldLines,
      newLines: response.newLines,
      patch: response.patch,
      endOfFile:
        region.direction === "below" &&
        response.oldLines.length < EXPANSION_LINES,
    });
    await send();
  }

  async function restoreCommentContexts(): Promise<void> {
    if (!review || !review.comments.length || !isDiffCommand(review.command))
      return;
    const candidate = review;
    let snapshot =
      candidate.snapshot ??
      (await makeSnapshot(candidate, candidate.command, patch));
    for (const comment of candidate.comments) {
      if (commentStatus(comment.anchor, patch, snapshot) === "current")
        continue;
      const anchor = comment.anchor;
      const file = snapshot.files.find(
        (f) => (anchor.side === "old" ? f.oldPath : f.newPath) === anchor.file,
      );
      if (!file) continue;
      let rangeIndex = 0;
      for (const gap of gapsForFile(candidate, anchor.file)) {
        const gapStart = anchor.side === "old" ? gap.oldStart : gap.newStart;
        const gapEnd = anchor.side === "old" ? gap.oldEnd : gap.newEnd;
        const start = Math.max(anchor.start, gapStart);
        const end = Math.min(anchor.end, gapEnd);
        for (let cursor = start; cursor <= end; cursor += MAX_EXPANSION_LINES) {
          const offset = cursor - gapStart;
          const length = Math.min(MAX_EXPANSION_LINES, end - cursor + 1);
          const region: ExpandedContextRange = {
            id: `comment:${comment.id}${rangeIndex++ ? `:${cursor}` : ""}`,
            file: anchor.file,
            oldFile: file.oldPath,
            newFile: file.newPath,
            direction: "between",
            oldStart: gap.oldStart + offset,
            oldEnd: gap.oldStart + offset + length - 1,
            newStart: gap.newStart + offset,
            newEnd: gap.newStart + offset + length - 1,
          };
          try {
            const response = await readContext(
              { ...candidate, snapshot },
              region,
            );
            snapshot = {
              ...snapshot,
              expandedRanges: [
                ...snapshot.expandedRanges.filter((r) => r.id !== region.id),
                response.region,
              ],
              sourceRanges: [
                ...snapshot.sourceRanges.filter((r) => r.id !== region.id),
                {
                  ...response.region,
                  oldLines: response.oldLines,
                  newLines: response.newLines,
                  sourceKey: response.sourceKey,
                },
              ],
            };
          } catch {
            /* Missing or changed source stays outdated. */
          }
        }
      }
    }
    review = await store.saveSnapshot(candidate, snapshot);
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
    let repo: string | undefined;
    if (!review && repositories.length > 1) {
      repo = await vscode.window.showQuickPick(repositories, {
        placeHolder: "Choose a Sapling repository",
      });
      if (!repo) return;
    } else {
      repo =
        review?.repo ??
        (last && repositories.includes(last.repo)
          ? last.repo
          : repositories[0]);
    }
    if (!repo) throw new Error("No Sapling repository was selected.");
    const selected =
      review?.repo === repo ? review : await rememberedReview(repo);
    let command = presetCommand("uncommitted");
    if (requested) command = commandForChoice(requested);
    else if (custom) {
      const entered = await vscode.window.showInputBox({
        title: "Arguments for sl diff",
        value: customArgsForCommand(selected.command),
        validateInput: (value) => {
          try {
            customArgsFromCommand(value, true);
            return undefined;
          } catch (e) {
            return String(e);
          }
        },
      });
      if (entered === undefined) return;
      command = canonicalCustomCommand(entered);
    }
    const selectedReview = {
      ...selected,
      directory: selected.directory ?? repositoryDirectories.get(repo) ?? repo,
    };
    const nextPatch = validatePatch(
      await run(commandDirectory(selectedReview), [
        "--color",
        "never",
        ...diffArgsWithContext(command),
      ]),
    );
    review = await store.save({
      ...selectedReview,
      command,
      patch: nextPatch,
      snapshot: await makeSnapshot(selectedReview, command, nextPatch),
    });
    patch = nextPatch;
    contextLines = INITIAL_CONTEXT_LINES;
    await restoreCommentContexts();
    await remember();
    ensurePanel();
    await send();
  }
  async function selectReview(repo: string, id: string) {
    review = await store.load(repo, id);
    if (!review.directory) {
      const directory = repositoryDirectories.get(repo) ?? repo;
      review = { ...review, directory };
      if (review.patch !== undefined || review.snapshot !== undefined)
        review = await store.save(review);
    }
    if (!isPreset(review.command) && isDiffCommand(review.command)) {
      const normalized = canonicalCustomCommand(review.command);
      if (normalized !== review.command)
        review = await store.save({ ...review, command: normalized });
    }
    patch = review.patch ?? "";
    contextLines = INITIAL_CONTEXT_LINES;
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
      defaultUri: uriForRepositoryPath(
        path.join(selected.repo, `00-review-${name}-${date}.md`),
        selected.repo,
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
          if (message.type === "expandContext") {
            try {
              await expandContext(message);
            } catch (error) {
              await panel?.webview.postMessage({
                type: "contextError",
                regionId: message.regionId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
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
              review = await store.save({
                ...next,
                patch: review.patch ?? patch,
                directory: review.directory,
                snapshot: review.snapshot,
              });
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
              const root = await fs.realpath(review.repo);
              const file = await fs.realpath(path.resolve(root, message.file));
              const relative = path.relative(root, file);
              if (
                relative.startsWith(".." + path.sep) ||
                relative === ".." ||
                path.isAbsolute(relative)
              )
                throw new Error("File is outside the repository.");
              const fileUri = uriForRepositoryPath(file, review.repo);
              const image = /\.(?:png|jpe?g|gif|bmp|webp|svg|ico)$/i.test(file);
              if (
                image &&
                typeof vscode.commands.executeCommand === "function"
              ) {
                await vscode.commands.executeCommand("vscode.open", fileUri);
                break;
              }
              const document = await vscode.workspace.openTextDocument(fileUri);
              const editor = await vscode.window.showTextDocument(document, {
                preview: true,
              });
              const position = new vscode.Position(
                Math.min(message.line - 1, document.lineCount - 1),
                0,
              );
              editor.selection = new vscode.Selection(position, position);
              editor.revealRange(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenterIfOutsideViewport,
              );
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
          if (last && !repositories.includes(last.repo)) {
            await context.workspaceState.update("lastReview", undefined);
            const byRepo = context.workspaceState.get<Record<string, string>>(
              "lastReviewByRepo",
              {},
            );
            if (byRepo[last.repo] !== undefined) {
              const next = { ...byRepo };
              delete next[last.repo];
              await context.workspaceState.update("lastReviewByRepo", next);
            }
          }
          const rememberedRepo =
            last && repositories.includes(last.repo)
              ? last.repo
              : repositories[0];
          if (rememberedRepo) {
            const selected = await rememberedReview(rememberedRepo);
            await selectReview(rememberedRepo, selected.id);
          } else {
            review = undefined;
            patch = "";
            await send();
          }
        });
      },
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (!review || !panel || !document.uri.fsPath) return;
      const selectedRepo = review.repo;
      serial(async () => {
        if (!review || review.repo !== selectedRepo || !panel) return;
        let root: string, file: string;
        try {
          [root, file] = await Promise.all([
            fs.realpath(selectedRepo),
            fs.realpath(document.uri.fsPath),
          ]);
        } catch {
          return;
        }
        if (!pathWithin(root, file)) return;
        if (isPreset(review.command)) await refresh();
        else
          await panel.webview.postMessage({
            type: "error",
            message:
              "Files changed. Refresh the custom diff to update comment locations.",
          });
      });
    }),
  );
}
