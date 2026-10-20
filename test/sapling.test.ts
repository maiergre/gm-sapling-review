import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "diff2html";
import { discoverRepositories, parseCommand, presetCommand } from "../src/core";

const available =
  spawnSync("sl", ["--version"], { stdio: "ignore" }).status === 0;
test(
  "real Sapling: nested repository discovery and renderable preset/custom diffs",
  { skip: !available },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sapling-review-integration-"),
    );
    const repo = join(directory, "projects", "repo");
    const sl = (cwd: string, args: string[]) =>
      execFileSync("sl", args, {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          HGENCODING: "UTF-8",
          SL_ENCODING: "UTF-8",
          SL_AUTOMATION: "true",
          SL_AUTOMATION_EXCEPT: "ghrevset,phrevset,progress,sniff,username",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    try {
      await mkdir(repo, { recursive: true });
      sl(repo, ["init"]);
      await writeFile(join(repo, "sample.ts"), "const value = 1;\n");
      sl(repo, ["add", "sample.ts"]);
      sl(repo, [
        "commit",
        "-m",
        "initial",
        "-u",
        "Review Test <test@example.com>",
      ]);
      await writeFile(join(repo, "sample.ts"), "const value = 2;\n");
      const roots = await discoverRepositories(
        [directory, repo],
        async (dir) => {
          try {
            return sl(dir, ["root"]).trim();
          } catch {
            return undefined;
          }
        },
      );
      assert.equal(roots.length, 1);
      const patch = sl(repo, [
        "--color",
        "never",
        "diff",
        "--git",
        "--no-binary",
        "--nodate",
        "--unified",
        "4",
        "--rev",
        ".",
      ]);
      assert.equal(parse(patch)[0].newName, "sample.ts");
      assert.ok(patch.includes("+const value = 2;"));
      const custom = sl(repo, [
        "--color",
        "never",
        ...parseCommand('sl diff --git --rev "." -- sample.ts'),
      ]);
      assert.equal(parse(custom)[0].newName, "sample.ts");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
