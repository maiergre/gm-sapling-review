import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, posix, resolve, sep } from "node:path";

import { parse as parseDiff } from "diff2html";
import type { DiffFile, DiffLine } from "diff2html/lib-esm/types";

export type Anchor = {
  file: string;
  side: "old" | "new";
  start: number;
  end: number;
  text: string[];
};

export type ReviewComment = {
  id: string;
  anchor: Anchor;
  body: string;
  createdAt: string;
  updatedAt: string;
};

/** A path as it appeared on either side of a comparison. */
export type ComparisonFile = {
  oldPath?: string;
  newPath?: string;
};

/**
 * Source text loaded for a bounded context range. Keeping this separate from
 * the patch lets a review retain the four-line initial diff while still
 * validating comments on rows revealed later.
 */
export type ComparisonSourceRange = {
  /** Explicit EOF preserves ranges written with earlier expansion sizes. */
  endOfFile?: boolean;
  id: string;
  file: string;
  oldFile?: string;
  newFile?: string;
  oldStart?: number;
  oldLines?: string[];
  newStart?: number;
  newLines?: string[];
  /** The command/revision identity used to obtain this source. */
  sourceKey: string;
};

export type ExpandedContextRange = {
  id: string;
  file: string;
  oldFile?: string;
  newFile?: string;
  direction: "above" | "below" | "between";
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
};

/** Durable metadata for one successfully rendered comparison snapshot. */
export type ComparisonSnapshot = {
  version: 1;
  repository: string;
  directory: string;
  command: string;
  userArgs: string[];
  extensionArgs: string[];
  patch: string;
  files: ComparisonFile[];
  expandedRanges: ExpandedContextRange[];
  sourceRanges: ComparisonSourceRange[];
  oldRevision?: string;
  newRevision?: string;
};

export type Review = {
  version: 2;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  repo: string;
  command: string;
  comments: ReviewComment[];
  /** Last successfully rendered patch, retained for restart recovery. */
  patch?: string;
  /** Selected command directory, which may differ from the repository root. */
  directory?: string;
  /** Last successful comparison and any bounded context loaded for it. */
  snapshot?: ComparisonSnapshot;
  /** Internal marker used to make legacy migration idempotent after rename. */
  legacySource?: string;
};

export type ReviewSummary = {
  commentCount: number;
  id: string;
  name: string;
  updatedAt: string;
  command: string;
};

const SHELL_OPERATOR = /[;&|<>`]/;
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", ".git", ".sl", ".hg"]);

/**
 * Parse a command entered in the custom comparison box into argv.
 *
 * The command is subsequently passed to a child process without a shell. We
 * still reject shell operators here so that accidentally pasting a shell
 * pipeline cannot silently do something different from what the user sees.
 * Single and double quotes, and backslash escaping, follow the useful subset
 * of shell quoting needed for paths and revsets.
 */
export function parseCommand(input: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;

  const pushToken = () => {
    if (tokenStarted) {
      tokens.push(token);
      token = "";
      tokenStarted = false;
    }
  };

  for (let i = 0; i < input.length; i += 1) {
    const character = input[i];

    if (quote === "single") {
      if (character === "'") {
        quote = undefined;
      } else {
        token += character;
      }
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        if (i + 1 >= input.length) {
          throw new Error("A command cannot end with an escape");
        }
        token += input[++i];
      } else {
        token += character;
      }
      continue;
    }

    if (/\s/.test(character)) {
      pushToken();
      continue;
    }

    if (character === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      if (i + 1 >= input.length) {
        throw new Error("A command cannot end with an escape");
      }
      token += input[++i];
      tokenStarted = true;
      continue;
    }

    if (
      SHELL_OPERATOR.test(character) ||
      (character === "$" && (input[i + 1] === "(" || input[i + 1] === "{"))
    ) {
      throw new Error(
        `Shell operator '${character}' is not allowed in a Sapling command`,
      );
    }

    token += character;
    tokenStarted = true;
  }

  if (quote !== undefined) {
    throw new Error("Unterminated quote in command");
  }
  pushToken();

  if (tokens.length === 0) {
    throw new Error("A Sapling command is required");
  }
  if (tokens[0] === "sl") {
    tokens.shift();
  }
  if (tokens.length === 0) {
    throw new Error("A Sapling subcommand is required");
  }
  return tokens;
}

/** Return the command line corresponding to one of Sapling's standard comparisons. */
export function presetCommand(mode: "uncommitted" | "head" | "stack"): string {
  switch (mode) {
    case "uncommitted":
      return "sl diff --git --rev .";
    case "head":
      return "sl diff --git --rev .^";
    case "stack":
      return "sl diff --git --rev ancestor(.,interestingmaster())";
  }
}

/**
 * Find Sapling repositories reachable from every workspace folder.
 *
 * rootFor is deliberately injected: the extension can implement it by
 * asking `sl root`, while tests and other hosts can provide a lightweight
 * implementation. Repository marker directories bound the number of root
 * queries while still finding repositories nested below a workspace folder.
 */
export async function discoverRepositories(
  folders: string[],
  rootFor: (dir: string) => Promise<string | undefined>,
): Promise<string[]> {
  const repositories = new Set<string>();
  const visited = new Set<string>();

  const scan = async (
    directory: string,
    workspaceFolder = false,
  ): Promise<void> => {
    let directoryInfo;
    try {
      directoryInfo = await fs.lstat(directory);
    } catch {
      return;
    }
    // A workspace folder may itself be a symlink. Resolve that one boundary
    // so repositories below it are discoverable, while descendants remain
    // lstat-checked and symlinks are never followed recursively.
    let scannedDirectory = directory;
    if (directoryInfo.isSymbolicLink()) {
      if (!workspaceFolder) return;
      try {
        scannedDirectory = await fs.realpath(directory);
      } catch {
        return;
      }
    } else if (!directoryInfo.isDirectory()) {
      return;
    }

    const absoluteDirectory = resolve(scannedDirectory);
    if (visited.has(absoluteDirectory)) {
      // A workspace folder can also be reached while walking another
      // workspace folder. Preserve the contract that every supplied folder
      // gets its own root query even when its directory was already visited.
      if (workspaceFolder) {
        try {
          const repository = await rootFor(absoluteDirectory);
          if (repository) {
            repositories.add(await canonicalPath(repository));
          }
        } catch {
          // Ignore an inaccessible workspace folder and continue the scan.
        }
      }
      return;
    }
    visited.add(absoluteDirectory);

    const addRepositoryFor = async () => {
      try {
        const repository = await rootFor(absoluteDirectory);
        if (repository) {
          repositories.add(await canonicalPath(repository));
        }
      } catch {
        // A directory can disappear or be inaccessible while a workspace is
        // being scanned. The remaining workspace must still be discovered.
      }
    };

    // Always query each workspace folder, including one nested inside a
    // repository and one whose contents cannot be read.
    if (workspaceFolder) {
      await addRepositoryFor();
    }

    let entries;
    try {
      entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      return;
    }

    // The workspace folder itself can be inside a repository, so always ask
    // rootFor for it. For descendants, a .sl/.hg marker gives us a bounded
    // set of candidates without invoking a process once per source folder.
    const marker = entries.some(
      (entry) =>
        (entry.name === ".sl" || entry.name === ".hg") &&
        entry.isDirectory() &&
        !entry.isSymbolicLink(),
    );
    if (marker && !workspaceFolder) {
      await addRepositoryFor();
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        SKIPPED_DIRECTORY_NAMES.has(entry.name) ||
        entry.isSymbolicLink() ||
        !entry.isDirectory()
      ) {
        continue;
      }
      await scan(join(absoluteDirectory, entry.name));
    }
  };

  await Promise.all(folders.map((folder) => scan(folder, true)));
  return Array.from(repositories).sort();
}

async function canonicalPath(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return resolve(value);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertAnchor(
  value: unknown,
  context: string,
): asserts value is Anchor {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }
  const start = value.start;
  const end = value.end;
  if (
    typeof value.file !== "string" ||
    (value.side !== "old" && value.side !== "new") ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    !Array.isArray(value.text) ||
    !value.text.every((line) => typeof line === "string") ||
    value.text.length !== end - start + 1
  ) {
    throw new Error(`${context} is not a valid review anchor`);
  }
}

function assertStringArray(
  value: unknown,
  context: string,
): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`${context} must be an array of strings`);
}

function assertSnapshot(
  value: unknown,
  context = "Review comparison snapshot",
): asserts value is ComparisonSnapshot {
  if (!isObject(value) || value.version !== 1)
    throw new Error(`${context} has an invalid shape`);
  if (
    typeof value.repository !== "string" ||
    typeof value.directory !== "string" ||
    typeof value.command !== "string" ||
    typeof value.patch !== "string"
  )
    throw new Error(`${context} has invalid paths or command`);
  for (const key of ["oldRevision", "newRevision"]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" ||
        !/^[0-9a-f]{40}$/.test(value[key] as string))
    )
      throw new Error(`${context} has an invalid revision`);
  }
  assertStringArray(value.userArgs, `${context} userArgs`);
  assertStringArray(value.extensionArgs, `${context} extensionArgs`);
  if (!Array.isArray(value.files))
    throw new Error(`${context} files must be an array`);
  for (const [index, file] of value.files.entries()) {
    if (
      !isObject(file) ||
      (file.oldPath !== undefined && typeof file.oldPath !== "string") ||
      (file.newPath !== undefined && typeof file.newPath !== "string") ||
      (file.oldPath === undefined && file.newPath === undefined)
    )
      throw new Error(`${context} file ${index} is invalid`);
  }
  if (!Array.isArray(value.expandedRanges))
    throw new Error(`${context} expandedRanges must be an array`);
  for (const [index, range] of value.expandedRanges.entries()) {
    const oldStart = isObject(range) ? range.oldStart : undefined;
    const oldEnd = isObject(range) ? range.oldEnd : undefined;
    const newStart = isObject(range) ? range.newStart : undefined;
    const newEnd = isObject(range) ? range.newEnd : undefined;
    if (
      !isObject(range) ||
      typeof range.id !== "string" ||
      typeof range.file !== "string" ||
      (range.oldFile !== undefined && typeof range.oldFile !== "string") ||
      (range.newFile !== undefined && typeof range.newFile !== "string") ||
      !["above", "below", "between"].includes(String(range.direction)) ||
      !Number.isSafeInteger(oldStart) ||
      !Number.isSafeInteger(oldEnd) ||
      !Number.isSafeInteger(newStart) ||
      !Number.isSafeInteger(newEnd) ||
      (oldStart as number) < 1 ||
      (oldEnd as number) < (oldStart as number) - 1 ||
      (newStart as number) < 1 ||
      (newEnd as number) < (newStart as number) - 1
    )
      throw new Error(`${context} expanded range ${index} is invalid`);
  }
  if (!Array.isArray(value.sourceRanges))
    throw new Error(`${context} sourceRanges must be an array`);
  for (const [index, source] of value.sourceRanges.entries()) {
    const oldStart = isObject(source) ? source.oldStart : undefined;
    const newStart = isObject(source) ? source.newStart : undefined;
    if (
      !isObject(source) ||
      typeof source.id !== "string" ||
      typeof source.file !== "string" ||
      (source.oldFile !== undefined && typeof source.oldFile !== "string") ||
      (source.newFile !== undefined && typeof source.newFile !== "string") ||
      typeof source.sourceKey !== "string" ||
      (oldStart !== undefined &&
        (!Number.isSafeInteger(oldStart) || (oldStart as number) < 1)) ||
      (newStart !== undefined &&
        (!Number.isSafeInteger(newStart) || (newStart as number) < 1))
    )
      throw new Error(`${context} source range ${index} is invalid`);
    if (source.oldLines !== undefined)
      assertStringArray(
        source.oldLines,
        `${context} source range ${index} oldLines`,
      );
    if (source.newLines !== undefined)
      assertStringArray(
        source.newLines,
        `${context} source range ${index} newLines`,
      );
  }
}

type LegacyReview = {
  version: 1;
  repo: string;
  command: string;
  comments: ReviewComment[];
  patch?: string;
};

function assertComments(value: unknown): asserts value is ReviewComment[] {
  if (!Array.isArray(value)) {
    throw new Error("Review comments must be an array");
  }
  for (const [index, comment] of value.entries()) {
    if (
      !isObject(comment) ||
      typeof comment.id !== "string" ||
      typeof comment.body !== "string" ||
      typeof comment.createdAt !== "string" ||
      typeof comment.updatedAt !== "string"
    ) {
      throw new Error(`Review comment ${index} is invalid`);
    }
    assertAnchor(comment.anchor, `Review comment ${index} anchor`);
  }
}

function assertReview(value: unknown): asserts value is Review {
  if (
    !isObject(value) ||
    value.version !== 2 ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    typeof value.repo !== "string" ||
    typeof value.command !== "string" ||
    value.command.length === 0 ||
    (value.patch !== undefined && typeof value.patch !== "string") ||
    (value.directory !== undefined && typeof value.directory !== "string") ||
    (value.legacySource !== undefined && typeof value.legacySource !== "string")
  ) {
    throw new Error("Review file has an invalid shape");
  }
  if (value.snapshot !== undefined) assertSnapshot(value.snapshot);
  assertComments(value.comments);
}

function assertLegacyReview(value: unknown): asserts value is LegacyReview {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    typeof value.repo !== "string" ||
    typeof value.command !== "string" ||
    value.command.length === 0 ||
    (value.patch !== undefined && typeof value.patch !== "string")
  ) {
    throw new Error("Legacy review file has an invalid shape");
  }
  assertComments(value.comments);
}

/** The v1 filename also serves as a stable source marker after migration. */
function legacyReviewFilename(repo: string, command: string): string {
  const key = createHash("sha256")
    .update(`${repo}\0${command}`, "utf8")
    .digest("hex");
  return `${key}.json`;
}

/** Hash v2 identities in their own namespace so v1 files can never collide. */
function reviewFilename(repo: string, id: string): string {
  const key = createHash("sha256")
    .update(`review-v2\0${repo}\0${id}`, "utf8")
    .digest("hex");
  return `${key}.json`;
}

/**
 * A deleted legacy review needs a durable marker. The original v1 file is
 * intentionally left in place for migration safety, so without this marker a
 * later load/list would import it again after its v2 file was deleted.
 */
function deletedLegacyFilename(repo: string, legacySource: string): string {
  const key = createHash("sha256")
    .update(`review-v2-deleted\0${repo}\0${legacySource}`, "utf8")
    .digest("hex");
  return `${key}.deleted`;
}

function legacyReviewId(repo: string, command: string): string {
  const key = createHash("sha256")
    .update(`${repo}\0${command}`, "utf8")
    .digest("hex");
  return `legacy-${key}`;
}

function now(): string {
  return new Date().toISOString();
}

function nextUpdatedAt(previous: string): string {
  const current = Date.now();
  const previousTime = Date.parse(previous);
  return Number.isFinite(previousTime) && previousTime >= current
    ? new Date(previousTime + 1).toISOString()
    : new Date(current).toISOString();
}

function assertName(name: string): void {
  if (name.trim().length === 0) {
    throw new Error("A review name is required");
  }
}

function emptyDefaultReview(repo: string): Review {
  const timestamp = now();
  return {
    version: 2,
    id: "default",
    name: "Default",
    createdAt: timestamp,
    updatedAt: timestamp,
    repo,
    command: presetCommand("uncommitted"),
    comments: [],
  };
}

function isLegacy(value: unknown): value is LegacyReview {
  return isObject(value) && value.version === 1;
}

/** Durable, crash-safe storage for named reviews keyed by repository and id. */
export class ReviewStore {
  private readonly directory: string;

  public constructor(directory: string) {
    this.directory = resolve(directory);
  }

  /**
   * Parse a review file with an error that identifies the file. A malformed
   * file must not be treated as an empty review because that could discard
   * comments on a subsequent save.
   */
  private async readFile(filename: string): Promise<unknown> {
    let raw: string;
    try {
      raw = await fs.readFile(filename, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }

    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`Malformed review file: ${filename}`, { cause: error });
    }
  }

  private async syncDirectory(): Promise<void> {
    // Syncing the containing directory makes the rename durable on the
    // platforms where directory fsync is supported. Some Windows filesystems
    // reject opening directories; the file itself is still fully synced.
    try {
      const directoryHandle = await fs.open(this.directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") {
        throw error;
      }
    }
  }

  private async writeFile(
    review: Review,
    mode: "replace" | "create" = "replace",
  ): Promise<boolean> {
    const directory = this.directory;
    await fs.mkdir(directory, { recursive: true });
    const filename = join(directory, reviewFilename(review.repo, review.id));
    const temporary = join(
      directory,
      `.${filename.slice(filename.lastIndexOf(sep) + 1)}.${randomUUID()}.tmp`,
    );
    const data = `${JSON.stringify(review, null, 2)}\n`;
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(data, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (mode === "create") {
        try {
          // A hard link gives us an atomic, exclusive destination without
          // replacing a review created by another writer while this process
          // was scanning legacy files. The temporary file and destination
          // are in the same directory, so this does not cross filesystems.
          await fs.link(temporary, filename);
          await fs.unlink(temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return false;
          }
          throw error;
        }
      } else {
        await fs.rename(temporary, filename);
      }
      await this.syncDirectory();
      return true;
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private async writeDeletedLegacyMarker(
    repo: string,
    legacySource: string,
  ): Promise<void> {
    const directory = this.directory;
    await fs.mkdir(directory, { recursive: true });
    const filename = join(directory, deletedLegacyFilename(repo, legacySource));
    const temporary = join(
      directory,
      `.${filename.slice(filename.lastIndexOf(sep) + 1)}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile("deleted\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        // Keep an existing marker. This also makes retries after a crash
        // idempotent without replacing a marker another writer created.
        await fs.link(temporary, filename);
        await fs.unlink(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await this.syncDirectory();
    } finally {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private async isLegacyDeleted(
    repo: string,
    legacySource: string,
  ): Promise<boolean> {
    try {
      await fs.access(
        join(this.directory, deletedLegacyFilename(repo, legacySource)),
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private async migrate(repo: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filename = join(this.directory, entry.name);
      let parsed;
      try {
        parsed = await this.readFile(filename);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Malformed review file:")
        )
          continue;
        throw error;
      }
      if (!isLegacy(parsed)) continue;
      try {
        assertLegacyReview(parsed);
      } catch {
        continue;
      }
      if (parsed.repo !== repo) continue;

      const legacySource = legacyReviewFilename(parsed.repo, parsed.command);
      if (await this.isLegacyDeleted(parsed.repo, legacySource)) continue;
      let id =
        parsed.command === presetCommand("uncommitted")
          ? "default"
          : legacyReviewId(parsed.repo, parsed.command);
      let destination = join(this.directory, reviewFilename(repo, id));
      let existing = await this.readFile(destination);
      if (existing !== undefined) {
        assertReview(existing);
        if (
          (existing as Review).repo !== repo ||
          (existing as Review).id !== id
        ) {
          throw new Error(
            "Review file repository or id does not match its key",
          );
        }
        // A migrated default keeps the source marker when it is renamed or
        // edited. If the default was created independently, preserve it and
        // import the old uncommitted review under its deterministic id.
        if ((existing as Review).legacySource !== legacySource) {
          if (id !== "default") continue;
          id = legacyReviewId(parsed.repo, parsed.command);
          destination = join(this.directory, reviewFilename(repo, id));
          existing = await this.readFile(destination);
          if (existing !== undefined) {
            assertReview(existing);
            if (
              (existing as Review).repo !== repo ||
              (existing as Review).id !== id
            ) {
              throw new Error(
                "Review file repository or id does not match its key",
              );
            }
            continue;
          }
        } else {
          continue;
        }
      }

      const stat = await fs.stat(filename);
      const timestamp = stat.mtime.toISOString();
      const migrated: Review = {
        version: 2,
        id,
        name: id === "default" ? "Default" : `Imported: ${parsed.command}`,
        createdAt: timestamp,
        updatedAt: timestamp,
        repo: parsed.repo,
        command: parsed.command,
        comments: parsed.comments,
        ...(parsed.patch === undefined ? {} : { patch: parsed.patch }),
        legacySource,
      };
      await this.writeFile(migrated, "create");
    }
  }

  private async readReview(
    repo: string,
    id: string,
  ): Promise<Review | undefined> {
    const filename = join(this.directory, reviewFilename(repo, id));
    const parsed = await this.readFile(filename);
    if (parsed === undefined) return undefined;
    assertReview(parsed);
    if (parsed.repo !== repo || parsed.id !== id) {
      throw new Error("Review file repository or id does not match its key");
    }
    return parsed;
  }

  public async load(repo: string, id = "default"): Promise<Review> {
    await this.migrate(repo);
    const review = await this.readReview(repo, id);
    if (review !== undefined) return review;
    if (id === "default") return emptyDefaultReview(repo);
    throw new Error(`Review not found: ${id}`);
  }

  public async list(repo: string): Promise<ReviewSummary[]> {
    await this.migrate(repo);
    let entries;
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const reviews: Review[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filename = join(this.directory, entry.name);
      let parsed;
      try {
        parsed = await this.readFile(filename);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Malformed review file:")
        )
          continue;
        throw error;
      }
      if (parsed === undefined || isLegacy(parsed)) continue;
      // A corrupt sibling must not strand otherwise valid reviews. Direct
      // loading still reports the error, and the original file is retained.
      try {
        assertReview(parsed);
      } catch {
        continue;
      }
      if (parsed.repo === repo) reviews.push(parsed);
    }
    return reviews
      .sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      )
      .map(({ id, name, updatedAt, command, comments }) => ({
        commentCount: comments.length,
        id,
        name,
        updatedAt,
        command,
      }));
  }

  /**
   * Find the v2 review imported from one v1 repository/command key. The
   * marker is independent of the review's current name, id, and command, so
   * this continues to work after a user renames the imported review or edits
   * its command.
   */
  public async resolveLegacy(
    repo: string,
    command: string,
  ): Promise<Review | undefined> {
    await this.migrate(repo);
    const legacySource = legacyReviewFilename(repo, command);
    let entries;
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const parsed = await this.readFile(join(this.directory, entry.name));
      if (parsed === undefined || isLegacy(parsed)) continue;
      assertReview(parsed);
      if (parsed.repo === repo && parsed.legacySource === legacySource) {
        return parsed;
      }
    }
    return undefined;
  }

  public async create(
    repo: string,
    name: string,
    command = presetCommand("uncommitted"),
  ): Promise<Review> {
    assertName(name);
    const timestamp = now();
    const review: Review = {
      version: 2,
      id: randomUUID(),
      name,
      createdAt: timestamp,
      updatedAt: timestamp,
      repo,
      command,
      comments: [],
    };
    assertReview(review);
    await this.writeFile(review);
    return review;
  }

  public async rename(repo: string, id: string, name: string): Promise<Review> {
    assertName(name);
    const review = await this.load(repo, id);
    return this.save({ ...review, name });
  }

  public async save(review: Review): Promise<Review> {
    assertReview(review);
    const updated: Review = {
      ...review,
      updatedAt: nextUpdatedAt(review.updatedAt),
    };
    await this.writeFile(updated);
    return updated;
  }

  /** Persist snapshot/context changes without making the review look edited. */
  public async saveSnapshot(
    review: Review,
    snapshot: ComparisonSnapshot,
  ): Promise<Review> {
    assertReview(review);
    assertSnapshot(snapshot);
    const updated = { ...review, snapshot, patch: snapshot.patch };
    await this.writeFile(updated);
    return updated;
  }

  /**
   * Permanently remove a review file. Returns false when no persisted review
   * exists; in particular, deleting a never-saved default is a no-op and the
   * next load can still provide a fresh empty default.
   *
   * Legacy source files are retained for safe, nondestructive migration. A
   * tombstone is written before removing their imported v2 review so the
   * source cannot be imported again after a restart.
   */
  public async delete(repo: string, id = "default"): Promise<boolean> {
    await this.migrate(repo);
    const review = await this.readReview(repo, id);
    if (review === undefined) return false;

    if (review.legacySource !== undefined) {
      await this.writeDeletedLegacyMarker(repo, review.legacySource);
    }

    try {
      await fs.unlink(join(this.directory, reviewFilename(repo, id)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    await this.syncDirectory();
    return true;
  }
}

function normalizeDiffPath(filename: string): string {
  let normalized = filename.trim().replaceAll("\\", "/");
  if (normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = normalized.slice(1, -1);
  }
  normalized = normalized.replace(/^\.\//, "");
  normalized = posix.normalize(normalized);
  if (normalized === ".") {
    return "";
  }
  return normalized;
}

function fileNamesMatch(
  anchor: string,
  diffFilename: string | undefined,
): boolean {
  if (diffFilename === undefined) return false;
  const wanted = normalizeDiffPath(anchor);
  const actual = normalizeDiffPath(diffFilename);
  return wanted === actual;
}

function lineNumber(line: DiffLine, side: Anchor["side"]): number | undefined {
  return side === "old" ? line.oldNumber : line.newNumber;
}

function lineText(line: DiffLine): string {
  // diff2html retains the leading '+', '-' or context-space in content.
  return line.content.length > 0 ? line.content.slice(1) : line.content;
}

function sourceStatus(
  anchor: Anchor,
  snapshot: ComparisonSnapshot,
): "current" | "outdated" | undefined {
  const candidate = snapshot.sourceRanges.find((range) => {
    const matchesFile = fileNamesMatch(
      anchor.file,
      anchor.side === "old"
        ? (range.oldFile ?? range.file)
        : (range.newFile ?? range.file),
    );
    if (!matchesFile) return false;
    const start = anchor.side === "old" ? range.oldStart : range.newStart;
    const lines = anchor.side === "old" ? range.oldLines : range.newLines;
    return (
      start !== undefined &&
      lines !== undefined &&
      anchor.start >= start &&
      anchor.end < start + lines.length
    );
  });
  if (!candidate) return undefined;
  const start =
    anchor.side === "old" ? candidate.oldStart! : candidate.newStart!;
  const lines =
    anchor.side === "old" ? candidate.oldLines! : candidate.newLines!;
  const offset = anchor.start - start;
  return lines
    .slice(offset, offset + anchor.text.length)
    .every((line, index) => line === anchor.text[index])
    ? "current"
    : "outdated";
}

/**
 * Compare an anchor against the parsed patch. A line-number shift or changed
 * line is intentionally considered stale, even if the same text appears
 * elsewhere in the file.
 */
export function commentStatus(
  anchor: Anchor,
  patch: string,
  snapshot?: ComparisonSnapshot,
): "current" | "outdated" {
  let files: DiffFile[];
  try {
    files = parseDiff(patch);
  } catch {
    return "outdated";
  }

  const file = files.find((candidate) =>
    fileNamesMatch(
      anchor.file,
      anchor.side === "old" ? candidate.oldName : candidate.newName,
    ),
  );
  if (file === undefined) {
    return "outdated";
  }

  const lines = file.blocks.flatMap((block) => block.lines);
  for (let number = anchor.start; number <= anchor.end; number++) {
    const visible = lines.find(
      (line) => lineNumber(line, anchor.side) === number,
    );
    const text = anchor.text[number - anchor.start];
    if (visible) {
      if (lineText(visible) !== text) return "outdated";
    } else if (
      !snapshot ||
      sourceStatus(
        { ...anchor, start: number, end: number, text: [text] },
        snapshot,
      ) !== "current"
    ) {
      return "outdated";
    }
  }
  return "current";
}

/** Build durable file identity metadata from a parsed unified patch. */
export function comparisonFiles(patch: string): ComparisonFile[] {
  try {
    return parseDiff(patch).map((file) => ({
      ...(file.oldName ? { oldPath: normalizeDiffPath(file.oldName) } : {}),
      ...(file.newName ? { newPath: normalizeDiffPath(file.newName) } : {}),
    }));
  } catch {
    return [];
  }
}

export function comparisonSnapshot(
  repository: string,
  directory: string,
  command: string,
  userArgs: string[],
  extensionArgs: string[],
  patch: string,
): ComparisonSnapshot {
  return {
    version: 1,
    repository,
    directory,
    command,
    userArgs: [...userArgs],
    extensionArgs: [...extensionArgs],
    patch,
    files: comparisonFiles(patch),
    expandedRanges: [],
    sourceRanges: [],
  };
}

function emptySnapshot(patch: string): ComparisonSnapshot {
  return {
    version: 1,
    repository: "",
    directory: "",
    command: "",
    userArgs: [],
    extensionArgs: [],
    patch,
    files: [],
    expandedRanges: [],
    sourceRanges: [],
  };
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

/** Render comments as a compact, human- and agent-readable review handoff. */
export function markdown(review: Review, patch: string): string {
  const lines = [
    "# Review comments",
    "",
    `Repository: ${inlineCode(review.repo)}`,
    `Review: ${inlineCode(review.name)}`,
    `Command: ${inlineCode(review.command)}`,
    "",
  ];

  if (review.comments.length === 0) {
    lines.push("No comments.");
    return `${lines.join("\n")}\n`;
  }

  for (const comment of review.comments) {
    const { anchor } = comment;
    const range =
      anchor.start === anchor.end
        ? `${anchor.start}`
        : `${anchor.start}-${anchor.end}`;
    const status =
      commentStatus(anchor, patch, review.snapshot) === "outdated"
        ? " **OUTDATED**"
        : "";
    // Keep the location unadorned so it can be copied directly into an issue,
    // editor, or agent prompt as `path:line`.
    lines.push(`- ${anchor.file}:${range} (${anchor.side})${status}`);
    lines.push(`  <!-- review-comment:${comment.id} -->`);
    lines.push(
      `  Created: ${comment.createdAt}; updated: ${comment.updatedAt}`,
    );
    lines.push("  Source:");
    for (const sourceLine of anchor.text) {
      lines.push(`  > ${sourceLine}`);
    }
    lines.push("  Comment:");
    for (const bodyLine of comment.body.split("\n")) {
      lines.push(`  ${bodyLine}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
