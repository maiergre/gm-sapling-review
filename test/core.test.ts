import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  commentStatus,
  discoverRepositories,
  markdown,
  parseCommand,
  presetCommand,
  ReviewStore,
  type Anchor,
  type Review,
} from "../src/core";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("parseCommand", () => {
  it("parses quotes and strips an optional sl executable", () => {
    assert.deepEqual(
      parseCommand(
        "sl diff --rev \"ancestor(.,interestingmaster())\" --include 'a path.ts'",
      ),
      [
        "diff",
        "--rev",
        "ancestor(.,interestingmaster())",
        "--include",
        "a path.ts",
      ],
    );
    assert.deepEqual(parseCommand("diff --include a\\ path.ts"), [
      "diff",
      "--include",
      "a path.ts",
    ]);
  });

  it("rejects shell operators and malformed quoting", () => {
    assert.throws(() => parseCommand("sl diff; rm -rf ."), /Shell operator/);
    assert.throws(
      () => parseCommand('sl diff "unterminated'),
      /Unterminated quote/,
    );
    assert.throws(() => parseCommand("sl"), /subcommand/);
  });
});

describe("presetCommand", () => {
  it("matches upstream Comparison.ts revset arguments", () => {
    assert.equal(presetCommand("uncommitted"), "sl diff --git --rev .");
    assert.equal(presetCommand("head"), "sl diff --git --rev .^");
    assert.equal(
      presetCommand("stack"),
      "sl diff --git --rev ancestor(.,interestingmaster())",
    );
  });
});

describe("discoverRepositories", () => {
  it("finds nested repositories across multiple folders and skips metadata and symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "gm-sapling-discovery-"));
    temporaryDirectories.push(root);
    const first = join(root, "first");
    const second = join(root, "second");
    const nested = join(first, "nested");
    const ignored = join(first, "node_modules", "ignored");
    await mkdir(nested, { recursive: true });
    await mkdir(join(nested, ".hg"), { recursive: true });
    await mkdir(join(first, ".sl"), { recursive: true });
    await mkdir(ignored, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(join(nested, "file.ts"), "");
    await symlink(nested, join(first, "linked"));

    const repoByDirectory = new Map([
      [resolve(first), resolve(first)],
      [resolve(nested), resolve(nested)],
      [resolve(second), resolve(second)],
      [resolve(ignored), resolve(ignored)],
    ]);
    const found = await discoverRepositories(
      [first, second],
      async (directory) => repoByDirectory.get(resolve(directory)),
    );
    assert.deepEqual(
      found,
      [resolve(first), resolve(nested), resolve(second)].sort(),
    );
  });

  it("continues after a root or directory permission-style failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "gm-sapling-discovery-errors-"));
    temporaryDirectories.push(root);
    const good = join(root, "good");
    const bad = join(root, "bad");
    await mkdir(good);
    await mkdir(bad);
    const found = await discoverRepositories([good, bad], async (directory) => {
      if (directory === resolve(bad)) {
        throw new Error("permission denied");
      }
      return directory;
    });
    assert.deepEqual(found, [resolve(good)]);
  });
});

const patch = [
  "diff --git a/src/example.ts b/src/example.ts",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,3 @@",
  " unchanged",
  "-old value",
  "+new value",
  " final",
  "",
].join("\n");

const currentAnchor: Anchor = {
  file: "src/example.ts",
  side: "new",
  start: 2,
  end: 2,
  text: ["new value"],
};

describe("commentStatus and markdown", () => {
  it("marks exact anchors current and changed or missing ranges outdated", () => {
    assert.equal(commentStatus(currentAnchor, patch), "current");
    assert.equal(
      commentStatus({ ...currentAnchor, text: ["different"] }, patch),
      "outdated",
    );
    assert.equal(
      commentStatus(
        { ...currentAnchor, start: 20, end: 20, text: ["new value"] },
        patch,
      ),
      "outdated",
    );
    assert.equal(
      commentStatus({ ...currentAnchor, file: "missing.ts" }, patch),
      "outdated",
    );
  });

  it("renders file, side, range, body, and an outdated marker", () => {
    const review: Review = {
      version: 2,
      id: "review-1",
      name: "Example review",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      repo: "/workspace/repo",
      command: "sl diff --rev .",
      comments: [
        {
          id: "c1",
          anchor: currentAnchor,
          body: "Please keep this value configurable.",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "c2",
          anchor: { ...currentAnchor, text: ["stale"] },
          body: "This one moved.",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    };
    const output = markdown(review, patch);
    assert.match(output, /src\/example\.ts:2 \(new\)/);
    assert.match(output, /Please keep this value configurable\./);
    assert.match(output, /src\/example\.ts:2 \(new\) \*\*OUTDATED\*\*/);
    assert.match(output, /review-comment:c1/);
    assert.match(output, /Review: `Example review`/);
  });
});

function legacyFilename(repo: string, command: string): string {
  return `${createHash("sha256")
    .update(`${repo}\0${command}`, "utf8")
    .digest("hex")}.json`;
}

function legacyId(repo: string, command: string): string {
  return `legacy-${createHash("sha256")
    .update(`${repo}\0${command}`, "utf8")
    .digest("hex")}`;
}

describe("ReviewStore", () => {
  it("persists a named review and returns the default for a new repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gm-sapling-reviews-"));
    temporaryDirectories.push(directory);
    const store = new ReviewStore(directory);
    const empty = await store.load("/workspace/repo");
    assert.equal(empty.version, 2);
    assert.equal(empty.id, "default");
    assert.equal(empty.name, "Default");
    assert.equal(empty.command, presetCommand("uncommitted"));
    assert.deepEqual(empty.comments, []);

    const review: Review = {
      ...empty,
      name: "Example",
      patch,
      comments: [
        {
          id: "c1",
          anchor: currentAnchor,
          body: "Please explain this.",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const saved = await store.save(review);
    assert.deepEqual(await store.load(review.repo, review.id), saved);
    const files = await (await import("node:fs/promises")).readdir(directory);
    assert.equal(files.filter((file) => file.endsWith(".json")).length, 1);
  });

  it("creates, renames, changes command, and sorts summaries by update time", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "gm-sapling-reviews-named-"),
    );
    temporaryDirectories.push(directory);
    const store = new ReviewStore(directory);
    const repo = "/workspace/repo";
    const first = await store.create(repo, "First");
    const second = await store.create(repo, "Second", "sl diff --rev .^");
    const renamed = await store.rename(repo, first.id, "Renamed");
    const changed = await store.save({
      ...renamed,
      command: "sl diff --git --rev abc123",
    });

    assert.equal((await store.load(repo, first.id)).id, first.id);
    assert.equal((await store.load(repo, first.id)).name, "Renamed");
    assert.equal((await store.load(repo, first.id)).command, changed.command);
    assert.equal((await store.load(repo, second.id)).command, second.command);

    const summaries = await store.list(repo);
    assert.deepEqual(
      summaries.map(({ id }) => id),
      [changed, second]
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.id.localeCompare(right.id),
        )
        .map(({ id }) => id),
    );
    assert.deepEqual(
      summaries.find(({ id }) => id === first.id),
      {
        id: first.id,
        name: "Renamed",
        commentCount: 0,
        updatedAt: changed.updatedAt,
        command: changed.command,
      },
    );
  });

  it("deletes persisted reviews and recreates an empty default", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "gm-sapling-review-delete-"),
    );
    temporaryDirectories.push(directory);
    const store = new ReviewStore(directory);
    const repo = "/workspace/repo";
    const named = await store.create(repo, "To remove");

    assert.equal(await store.delete(repo, named.id), true);
    assert.equal(await store.delete(repo, named.id), false);
    await assert.rejects(store.load(repo, named.id), /Review not found: /);

    const persistedDefault = await store.rename(repo, "default", "Saved");
    assert.equal(persistedDefault.name, "Saved");
    assert.equal(await store.delete(repo), true);
    const freshDefault = await store.load(repo);
    assert.equal(freshDefault.id, "default");
    assert.equal(freshDefault.name, "Default");
    assert.deepEqual(freshDefault.comments, []);
  });

  it("migrates v1 files idempotently without changing the originals", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "gm-sapling-review-migrate-"),
    );
    temporaryDirectories.push(directory);
    const store = new ReviewStore(directory);
    const repo = "/workspace/repo";
    const command = "sl diff --rev feature";
    const legacy = {
      version: 1,
      repo,
      command,
      comments: [
        {
          id: "legacy-comment",
          anchor: currentAnchor,
          body: "Keep this comment.",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const legacyPath = join(directory, legacyFilename(repo, command));
    const legacyContents = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(legacyPath, legacyContents);

    const imported = await store.load(repo, legacyId(repo, command));
    assert.equal(imported.name, `Imported: ${command}`);
    assert.deepEqual(imported.comments, legacy.comments);
    assert.equal(await readFile(legacyPath, "utf8"), legacyContents);
    const firstList = await store.list(repo);
    const secondList = await store.list(repo);
    assert.deepEqual(secondList, firstList);
    assert.equal(firstList.length, 1);

    const renamed = await store.rename(repo, imported.id, "Renamed import");
    const changed = await store.save({
      ...renamed,
      command: "sl diff --rev changed-after-import",
    });
    assert.equal((await store.list(repo))[0].name, "Renamed import");
    assert.equal((await store.load(repo, imported.id)).name, changed.name);
    assert.equal((await store.resolveLegacy(repo, command))?.id, imported.id);
    assert.equal(
      (await store.resolveLegacy(repo, command))?.command,
      changed.command,
    );
    assert.equal(await readFile(legacyPath, "utf8"), legacyContents);
    assert.equal(
      (await (await import("node:fs/promises")).readdir(directory)).filter(
        (file) => file.endsWith(".json"),
      ).length,
      2,
    );
  });

  it("does not re-import a deleted legacy review", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "gm-sapling-review-delete-legacy-"),
    );
    temporaryDirectories.push(directory);
    const store = new ReviewStore(directory);
    const repo = "/workspace/repo";
    const command = "sl diff --rev feature";
    const legacy = {
      version: 1,
      repo,
      command,
      comments: [],
    };
    const legacyPath = join(directory, legacyFilename(repo, command));
    const legacyContents = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(legacyPath, legacyContents);

    const imported = await store.load(repo, legacyId(repo, command));
    assert.equal(imported.legacySource, legacyFilename(repo, command));
    assert.equal(await store.delete(repo, imported.id), true);
    assert.deepEqual(await store.list(repo), []);
    assert.equal(await store.resolveLegacy(repo, command), undefined);
    await assert.rejects(store.load(repo, imported.id), /Review not found: /);
    assert.deepEqual(await store.list(repo), []);
    assert.equal(await readFile(legacyPath, "utf8"), legacyContents);
  });

  it("does not re-import a deleted legacy default", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "gm-sapling-review-delete-default-"),
    );
    temporaryDirectories.push(directory);
    const store = new ReviewStore(directory);
    const repo = "/workspace/repo";
    const command = presetCommand("uncommitted");
    const legacy = {
      version: 1,
      repo,
      command,
      comments: [],
    };
    const legacyPath = join(directory, legacyFilename(repo, command));
    await writeFile(legacyPath, `${JSON.stringify(legacy)}\n`);

    const imported = await store.load(repo);
    assert.equal(imported.id, "default");
    assert.equal(await store.delete(repo), true);
    const fresh = await store.load(repo);
    assert.equal(fresh.id, "default");
    assert.equal(fresh.name, "Default");
    assert.deepEqual(fresh.comments, []);
    assert.deepEqual(await store.list(repo), []);
    assert.equal(await store.resolveLegacy(repo, command), undefined);
    assert.equal(
      await readFile(legacyPath, "utf8"),
      `${JSON.stringify(legacy)}\n`,
    );
  });

  it("imports a legacy default separately when a default review already exists", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "gm-sapling-review-default-collision-"),
    );
    temporaryDirectories.push(directory);
    const store = new ReviewStore(directory);
    const repo = "/workspace/repo";
    const command = presetCommand("uncommitted");
    const current = await store.rename(repo, "default", "Current default");
    assert.equal(current.id, "default");
    const legacy = {
      version: 1,
      repo,
      command,
      comments: [],
    };
    const legacyPath = join(directory, legacyFilename(repo, command));
    await writeFile(legacyPath, `${JSON.stringify(legacy)}\n`);

    const summaries = await store.list(repo);
    assert.deepEqual(
      new Set(summaries.map(({ id, name }) => `${id}:${name}`)),
      new Set([
        `default:Current default`,
        `${legacyId(repo, command)}:Imported: ${command}`,
      ]),
    );
    const imported = await store.resolveLegacy(repo, command);
    assert.equal(imported?.id, legacyId(repo, command));
    const renamed = await store.rename(repo, "default", "Renamed default");
    assert.equal((await store.load(repo, "default")).name, renamed.name);
    const changed = await store.save({
      ...imported!,
      command: "sl diff --rev changed-after-collision",
    });
    assert.equal((await store.resolveLegacy(repo, command))?.id, changed.id);
    assert.equal(
      (await store.resolveLegacy(repo, command))?.command,
      changed.command,
    );
    assert.equal((await store.list(repo)).length, 2);
  });

  it("throws on malformed JSON instead of treating it as an empty review", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "gm-sapling-review-corrupt-"),
    );
    temporaryDirectories.push(directory);
    const store = new ReviewStore(directory);
    await store.save({
      version: 2,
      id: "corrupt",
      name: "Corruptible",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      repo: "repo",
      command: "sl diff",
      comments: [],
    });
    const file = (
      await (await import("node:fs/promises")).readdir(directory)
    ).find((name) => name.endsWith(".json"))!;
    await writeFile(join(directory, file), "{not json");
    await assert.rejects(
      store.load("repo", "corrupt"),
      /Malformed review file/,
    );
    assert.equal(await readFile(join(directory, file), "utf8"), "{not json");
  });
});
