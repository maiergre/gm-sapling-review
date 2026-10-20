import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

const bundle = buildSync({
  entryPoints: ["webview/main.ts"],
  bundle: true,
  write: false,
  platform: "browser",
  loader: { ".css": "empty" },
}).outputFiles[0].text;
const patch = `diff --git a/a/example.ts b/a/example.ts
--- a/a/example.ts
+++ b/a/example.ts
@@ -1,3 +1,3 @@
 const one = 1;
-const two = 2;
+const two = 3;
 const three = 3;
`;
function browser(restored?: any) {
  const dom = new JSDOM(
    '<div id="toolbar"></div><div id="status"></div><main id="diff"></main><section id="comments"></section>',
    {
      runScripts: "outside-only",
      pretendToBeVisual: true,
      url: "https://review.invalid",
    },
  );
  const messages: any[] = [];
  let stored: any = restored;
  const w = dom.window;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  (w as any).acquireVsCodeApi = () => ({
    postMessage: (m: any) => messages.push(structuredClone(m)),
    getState: () => stored,
    setState: (s: any) => {
      stored = structuredClone(s);
    },
  });
  w.eval(bundle);
  const state = (
    comments: any[] = [],
    override: Record<string, unknown> = {},
  ) =>
    w.dispatchEvent(
      new w.MessageEvent("message", {
        data: {
          type: "state",
          repo: "/repo",
          command: "sl diff --git --rev .",
          patch,
          comments,
          ...override,
        },
      }),
    );
  const button = (label: string) =>
    [...w.document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) =>
        b.textContent === label ||
        b.getAttribute("aria-label") === label ||
        b.title === label,
    )!;
  const line = (number: number, side = "new") =>
    w.document.querySelector<HTMLElement>(
      `[data-review-side="${side}"][data-review-line="${number}"]`,
    )!;
  return { dom, w, messages, state, button, line, stored: () => stored };
}

test("webview renders highlighted diffs, preserves names, selects ranges, saves inline comments and changes layout", () => {
  const b = browser();
  try {
    b.state();
    assert.equal(b.messages[0].type, "ready");
    assert.equal(
      b.w.document
        .querySelector(".review-actions-row button")
        ?.getAttribute("aria-label"),
      "Refresh diff",
      "Refresh should be the first action in the review actions row",
    );
    const preset =
      b.w.document.querySelector<HTMLSelectElement>("#review-preset")!;
    const command = b.w.document.querySelector<HTMLInputElement>(
      ".review-command-input",
    )!;
    assert.equal(command.disabled, false);
    assert.equal(
      b.w.document
        .querySelector(".review-file-diffstat")
        ?.getAttribute("aria-label"),
      "1 lines added, 1 lines deleted",
    );
    assert.equal(
      [...b.w.document.querySelectorAll(".d2h-tag")].some(
        (tag) => tag.textContent?.trim() === "CHANGED",
      ),
      false,
    );
    preset.value = "stack";
    preset.dispatchEvent(new b.w.Event("change"));
    assert.equal(command.value, "--rev ancestor(.,interestingmaster())");
    assert.deepEqual(b.messages.at(-1), {
      type: "refresh",
      choice: "stack",
      command: "--rev ancestor(.,interestingmaster())",
    });
    const beforeCustom = b.messages.length;
    preset.value = "custom";
    preset.dispatchEvent(new b.w.Event("change"));
    assert.equal(
      b.messages.length,
      beforeCustom,
      "custom does not run a command",
    );
    command.dispatchEvent(new b.w.MouseEvent("click", { bubbles: true }));
    assert.equal(preset.value, "custom");
    command.value = "--rev abc123 --include src/app.ts";
    command.dispatchEvent(new b.w.Event("input"));
    b.w.document
      .querySelector<HTMLButtonElement>(".review-refresh-button")!
      .click();
    assert.deepEqual(b.messages.at(-1), {
      type: "refresh",
      choice: "custom",
      command: "--rev abc123 --include src/app.ts",
    });
    assert.equal(
      b.w.document.querySelector(".review-toc a")?.textContent,
      "example.ts",
    );
    assert.ok(
      b.w.document.querySelector(".hljs-keyword"),
      "syntax tokens should be highlighted",
    );
    b.line(2).click();
    assert.deepEqual(b.messages.at(-1), {
      type: "open",
      file: "a/example.ts",
      line: 2,
    });
    b.line(1).querySelector<HTMLButtonElement>("button")!.click();
    b.line(3)
      .querySelector("button")!
      .dispatchEvent(
        new b.w.MouseEvent("click", { bubbles: true, shiftKey: true }),
      );
    const form =
      b.w.document.querySelector<HTMLFormElement>(".review-composer")!;
    assert.equal(form.parentElement?.tagName, "TD");
    const textarea = form.querySelector("textarea")!;
    textarea.value = "Please explain this change.";
    textarea.dispatchEvent(new b.w.Event("input"));
    b.button("Save comment").click();
    const save = b.messages.at(-1);
    assert.equal(save.type, "saveComment");
    assert.equal(save.anchor.start, 1);
    assert.equal(save.anchor.end, 3);
    assert.deepEqual(
      [...save.anchor.text],
      ["const one = 1;", "const two = 3;", "const three = 3;"],
    );
    assert.equal(b.button("Saving…").disabled, true);
    const comment = {
      id: "c1",
      anchor: save.anchor,
      body: save.body,
      status: "current",
    };
    b.state([comment]);
    assert.equal(b.w.document.querySelector(".review-composer"), null);
    assert.ok(
      b.w.document.querySelector("#diff .review-thread-row .review-comment"),
    );
    b.button("Edit").click();
    const edit = b.w.document.querySelector<HTMLTextAreaElement>(
      '[aria-label="Edit review comment"]',
    )!;
    edit.value = "Updated comment";
    edit.dispatchEvent(new b.w.Event("input"));
    b.button("Save changes").click();
    assert.equal(b.messages.at(-1).body, "Updated comment");
    b.state([{ ...comment, body: "Updated comment" }]);
    b.button("Side by side").click();
    assert.equal(
      b.w.document.querySelectorAll(".d2h-file-side-diff").length,
      2,
    );
    assert.ok(b.line(2, "old"));
    b.w.document
      .querySelector<HTMLButtonElement>(".review-file-toggle")!
      .click();
    assert.ok(b.w.document.querySelector(".review-collapsed"));
    b.w.document
      .querySelector<HTMLButtonElement>(".review-file-toggle")!
      .click();
    b.state([{ ...comment, status: "outdated" }], { patch: "" });
    assert.ok(b.w.document.querySelector("#comments .outdated"));
    b.button("Delete").click();
    assert.equal(b.messages.at(-1).type, "deleteComment");
    b.state([], { patch: "" });
    assert.equal(b.w.document.querySelector(".review-comment"), null);
  } finally {
    b.dom.window.close();
  }
});

test("built-in diffs offer expandable context gaps in both layouts", () => {
  const b = browser();
  const expansionPatch = `diff --git a/a/example.ts b/a/example.ts
--- a/a/example.ts
+++ b/a/example.ts
@@ -10,3 +10,3 @@
 const ten = 10;
-const eleven = 11;
+const eleven = 12;
 const twelve = 12;
@@ -30,3 +30,3 @@
 const thirty = 30;
-const thirtyOne = 31;
+const thirtyOne = 32;
 const thirtyTwo = 32;
`;
  const fullExpansionPatch = [
    "diff --git a/a/example.ts b/a/example.ts",
    "--- a/a/example.ts",
    "+++ b/a/example.ts",
    "@@ -1,40 +1,40 @@",
    ...Array.from({ length: 40 }, (_, index) => {
      const line = index + 1;
      if (line === 11) return [`-const eleven = 11;`, `+const eleven = 12;`];
      if (line === 31)
        return [`-const thirtyOne = 31;`, `+const thirtyOne = 32;`];
      return [` const line${line};`];
    }).flat(),
    "",
  ].join("\n");
  try {
    b.state([], { patch: expansionPatch, contextLines: 3 });
    const controls = () => [
      ...b.w.document.querySelectorAll<HTMLButtonElement>(
        ".review-context-expansion-button",
      ),
    ];
    assert.deepEqual(
      controls().map((button) => button.dataset.reviewContextDirection),
      ["above", "between", "between", "below"],
    );
    assert.deepEqual(
      controls().map((button) => button.dataset.reviewContextEdge),
      ["up", "up", "down", "down"],
      "separators expose independent edge actions",
    );
    for (const button of controls()) {
      const row = button.closest("tr")!;
      assert.equal(row.querySelectorAll(":scope > td").length, 2);
      assert.equal(row.querySelector("td")?.colSpan, 1);
      assert.equal(button.querySelectorAll("svg").length, 1);
      assert.equal(button.textContent?.includes("Expand"), false);
      assert.match(button.getAttribute("aria-label") ?? "", /earlier|later/);
      assert.equal(button.title, button.getAttribute("aria-label"));
    }
    const suppressedHunks = [
      ...b.w.document.querySelectorAll<HTMLTableRowElement>(
        ".review-context-expansion-suppressed-hunk",
      ),
    ];
    assert.equal(suppressedHunks.length, 0);
    assert.equal(
      b.w.document.querySelectorAll(
        ".review-context-expansion-row .d2h-code-line",
      ).length,
      3,
      "hunk headers remain in separator rows",
    );
    const inlineRows = [
      ...b.w.document.querySelectorAll<HTMLTableRowElement>(
        ".d2h-diff-table tr",
      ),
    ];
    const belowRow = controls()
      .find((button) => button.dataset.reviewContextDirection === "below")!
      .closest("tr");
    assert.equal(
      belowRow,
      inlineRows.at(-1),
      "the below control follows the final rendered line",
    );
    const above = controls().find(
      (button) => button.dataset.reviewContextDirection === "above",
    )!;
    const file = above.dataset.reviewContextFile;
    above.click();
    assert.deepEqual(b.messages.at(-1), {
      type: "expandContext",
      file,
      direction: "above",
      regionId: `${file}:above:1-9:1-9`,
      oldStart: 1,
      oldEnd: 9,
      newStart: 1,
      newEnd: 9,
    });
    b.state([], { patch: fullExpansionPatch, contextLines: 1000000 });
    assert.equal(
      controls().some(
        (button) => button.dataset.reviewContextDirection === "above",
      ),
      false,
      "the clicked block expands while other blocks stay collapsed",
    );
    assert.equal(
      b.w.document.querySelectorAll(".review-context-expansion-suppressed-hunk")
        .length,
      0,
      "full-context local separators keep the hunk marker visible",
    );
    const comment = {
      id: "expanded-context-comment",
      body: "Keep this line clear.",
      status: "current",
      anchor: {
        file,
        side: "new",
        start: 11,
        end: 11,
        text: ["const eleven = 12;"],
      },
    };
    b.state([comment], { patch: fullExpansionPatch, contextLines: 1000000 });
    assert.equal(b.line(11).dataset.reviewLine, "11");
    assert.ok(
      b.w.document.querySelector(
        '[data-comment-id="expanded-context-comment"]',
      ),
      "expanded context keeps existing comment anchors attached",
    );
    b.w.document
      .querySelector<HTMLButtonElement>('[data-mode="split"]')!
      .click();
    const sideTables = b.w.document.querySelectorAll(
      ".d2h-file-side-diff .d2h-diff-table",
    );
    assert.equal(sideTables.length, 2);
    assert.deepEqual(
      [...sideTables].map(
        (table) =>
          table.querySelectorAll(".review-context-expansion-button").length,
      ),
      [3, 3],
      "split panes keep remaining controls aligned",
    );
    b.state([], {
      command: "sl diff --rev custom --include a/example.ts",
      patch: expansionPatch,
      canExpandContext: true,
    });
    assert.ok(
      b.w.document.querySelector(".review-context-expansion-button"),
      "custom diff arguments support the same context expansion controls",
    );
  } finally {
    b.dom.window.close();
  }
});

test("split context expansion aligns pure insertions and deletions", () => {
  const b = browser();
  const patch = [
    "diff --git a/a/example.ts b/a/example.ts",
    "--- a/a/example.ts",
    "+++ b/a/example.ts",
    "@@ -1,40 +1,40 @@",
    ...Array.from({ length: 40 }, (_, index) => {
      const line = index + 1;
      if (line === 11) return "+const inserted = 11;";
      if (line === 31) return "-const removed = 31;";
      return ` const line${line};`;
    }),
    "",
  ].join("\n");
  try {
    b.state([], { patch, contextLines: 1_000_000 });
    b.w.document
      .querySelector<HTMLButtonElement>('[data-mode="split"]')!
      .click();
    const panes = () => [
      ...b.w.document.querySelectorAll<HTMLTableElement>(
        ".d2h-file-side-diff .d2h-diff-table",
      ),
    ];
    assert.equal(panes().length, 2);
    const controls = (table: HTMLTableElement) => [
      ...table.querySelectorAll<HTMLButtonElement>(
        ".review-context-expansion-button",
      ),
    ];
    assert.deepEqual(
      panes().map((table) =>
        controls(table).map((button) => button.dataset.reviewContextDirection),
      ),
      [
        ["above", "between", "between", "below"],
        ["above", "between", "between", "below"],
      ],
      "both panes expose the same logical context blocks",
    );
    const between = controls(panes()[0]).find(
      (button) => button.dataset.reviewContextDirection === "between",
    )!;
    const id = between.dataset.reviewContextId;
    const messageCount = b.messages.length;
    between.click();
    assert.equal(
      b.messages.length,
      messageCount,
      "expanding a full patch stays local to the webview",
    );
    assert.deepEqual(
      panes().map((table) =>
        controls(table).map((button) => button.dataset.reviewContextDirection),
      ),
      [
        ["above", "below"],
        ["above", "below"],
      ],
      "only the clicked block expands in both panes",
    );
    assert.equal(
      panes().some((table) =>
        controls(table).some((button) => button.dataset.reviewContextId === id),
      ),
      false,
      "the expanded block control is removed from both panes",
    );
  } finally {
    b.dom.window.close();
  }
});

test("local context expansion reveals only the selected edge", () => {
  const b = browser();
  const patch = [
    "diff --git a/src/local.ts b/src/local.ts",
    "--- a/src/local.ts",
    "+++ b/src/local.ts",
    "@@ -1,110 +1,110 @@",
    ...Array.from({ length: 110 }, (_, index) => {
      const line = index + 1;
      if (line === 11) return [`-old ${line}`, `+new ${line}`];
      if (line === 100) return [`-old ${line}`, `+new ${line}`];
      return [` context ${line}`];
    }).flat(),
    "",
  ].join("\n");
  const visibleLines = () =>
    [
      ...b.w.document.querySelectorAll<HTMLTableRowElement>(
        ".d2h-diff-table tbody > tr",
      ),
    ]
      .filter(
        (row) =>
          !row.hidden &&
          !row.classList.contains("review-context-expansion-row"),
      )
      .flatMap((row) =>
        [...row.querySelectorAll<HTMLElement>("[data-review-line]")]
          .map((cell) => Number(cell.dataset.reviewLine))
          .filter((line) => Number.isSafeInteger(line) && line > 0),
      );
  try {
    b.state([], { patch, canExpandContext: true });
    const controls = () =>
      [
        ...b.w.document.querySelectorAll<HTMLButtonElement>(
          ".review-context-expansion-button",
        ),
      ].filter((button) => button.dataset.reviewContextDirection === "between");
    assert.deepEqual(
      controls().map((button) => button.dataset.reviewContextEdge),
      ["up", "down"],
    );
    const up = controls().find(
      (button) => button.dataset.reviewContextEdge === "up",
    )!;
    up.click();
    assert.notEqual(b.messages.at(-1)?.type, "expandContext");
    assert.ok(
      visibleLines().includes(80),
      `up reveals context near lower hunk: ${visibleLines()}`,
    );
    assert.equal(
      visibleLines().includes(40),
      false,
      `up keeps upper gap collapsed: ${visibleLines()}`,
    );
    assert.deepEqual(
      controls().map((button) => button.dataset.reviewContextEdge),
      ["up", "down"],
    );
    controls()
      .find((button) => button.dataset.reviewContextEdge === "down")!
      .click();
    assert.ok(
      visibleLines().includes(20),
      "down reveals context near upper hunk",
    );
    assert.ok(
      visibleLines().includes(90),
      "down preserves the lower edge reveal",
    );
    assert.equal(
      visibleLines().includes(50),
      false,
      "the middle of the gap stays collapsed after both edge expansions",
    );
  } finally {
    b.dom.window.close();
  }
});

test("bounded context responses merge only their source rows into the saved patch", () => {
  const b = browser();
  const base = `diff --git a/src/one.ts b/src/one.ts
--- a/src/one.ts
+++ b/src/one.ts
@@ -10,3 +10,3 @@
 line ten
-old
+new
 line twelve
diff --git a/src/two.ts b/src/two.ts
--- a/src/two.ts
+++ b/src/two.ts
@@ -1,3 +1,3 @@
 one
-two
+three
 four
`;
  const contextRows = Array.from(
    { length: 9 },
    (_, index) => `line ${index + 1}`,
  );
  try {
    b.state([], { patch: base });
    b.w.dispatchEvent(
      new b.w.MessageEvent("message", {
        data: {
          type: "contextExpanded",
          regionId: "src/one.ts:above:0",
          file: "src/one.ts",
          direction: "above",
          oldStart: 1,
          oldEnd: 9,
          newStart: 1,
          newEnd: 9,
          oldLines: contextRows,
          newLines: contextRows,
          patch: base,
        },
      }),
    );
    assert.ok(
      b.w.document.querySelector(
        '[data-review-file="src/one.ts"] [data-review-line="9"]',
      ),
    );
    assert.ok(b.w.document.querySelector('[data-review-file="src/two.ts"]'));
    const overlap = Array.from(
      { length: 11 },
      (_, index) => `line ${index + 5}`,
    );
    b.w.dispatchEvent(
      new b.w.MessageEvent("message", {
        data: {
          type: "contextExpanded",
          regionId: "src/one.ts:above:5-15:5-15",
          file: "src/one.ts",
          direction: "above",
          oldStart: 5,
          oldEnd: 15,
          newStart: 5,
          newEnd: 15,
          oldLines: overlap,
          newLines: overlap,
        },
      }),
    );
    assert.equal(
      b.w.document.querySelectorAll(
        '[data-review-file="src/one.ts"] [data-review-side="new"][data-review-line="9"]',
      ).length,
      1,
      "overlapping context responses do not duplicate source rows",
    );
    const restored = browser();
    try {
      restored.state([], {
        patch: base,
        expandedRanges: [
          {
            id: "src/one.ts:above:0",
            file: "src/one.ts",
            direction: "above",
            oldStart: 1,
            oldEnd: 9,
            newStart: 1,
            newEnd: 9,
          },
        ],
        snapshot: {
          patch: base,
          expandedRanges: [
            {
              id: "src/one.ts:above:0",
              file: "src/one.ts",
              direction: "above",
              oldStart: 1,
              oldEnd: 9,
              newStart: 1,
              newEnd: 9,
            },
          ],
          sourceRanges: [
            {
              id: "src/one.ts:above:0",
              file: "src/one.ts",
              oldStart: 1,
              oldLines: contextRows,
              newStart: 1,
              newLines: contextRows,
              sourceKey: "test",
            },
          ],
        },
      });
      assert.ok(
        restored.w.document.querySelector(
          '[data-review-file="src/one.ts"] [data-review-line="9"]',
        ),
        "saved source ranges are restored into the initial webview",
      );
    } finally {
      restored.dom.window.close();
    }
  } finally {
    b.dom.window.close();
  }
});

test("context expansion requests stay bounded and repeat for long gaps", () => {
  const b = browser();
  const changedHunk = (start: number, label: string) => [
    `@@ -${start},3 +${start},3 @@`,
    ` line ${start}`,
    `-${label} old`,
    `+${label} new`,
    ` line ${start + 2}`,
  ];
  const longPatch = [
    "diff --git a/src/long.ts b/src/long.ts",
    "--- a/src/long.ts",
    "+++ b/src/long.ts",
    ...changedHunk(110, "first"),
    ...changedHunk(250, "second"),
    "",
  ].join("\n");
  const controls = (direction: string) =>
    [
      ...b.w.document.querySelectorAll<HTMLButtonElement>(
        ".review-context-expansion-button",
      ),
    ].filter((button) => button.dataset.reviewContextDirection === direction);
  const expandThree = (
    direction: "above" | "between" | "below",
    edge: "up" | "down",
  ) => {
    for (let count = 0; count < 3; count += 1) {
      const button = controls(direction).find(
        (candidate) => candidate.dataset.reviewContextEdge === edge,
      );
      assert.ok(
        button,
        `${direction} control should remain for repeat ${count}`,
      );
      const oldStart = Number(button.dataset.reviewContextOldStart);
      const oldEnd = Number(button.dataset.reviewContextOldEnd);
      const newStart = Number(button.dataset.reviewContextNewStart);
      const newEnd = Number(button.dataset.reviewContextNewEnd);
      assert.equal(oldEnd - oldStart + 1, 30);
      assert.equal(newEnd - newStart + 1, 30);
      button.click();
      const request = b.messages.at(-1);
      assert.equal(request.type, "expandContext");
      assert.equal(request.direction, direction);
      const oldLines = Array.from(
        { length: oldEnd - oldStart + 1 },
        (_, index) => `line ${oldStart + index}`,
      );
      const newLines = Array.from(
        { length: newEnd - newStart + 1 },
        (_, index) => `line ${newStart + index}`,
      );
      b.w.dispatchEvent(
        new b.w.MessageEvent("message", {
          data: {
            type: "contextExpanded",
            regionId: request.regionId,
            file: request.file,
            direction,
            oldStart,
            oldEnd,
            newStart,
            newEnd,
            oldLines,
            newLines,
          },
        }),
      );
    }
  };
  try {
    b.state([], { patch: longPatch });
    expandThree("above", "up");
    for (const edge of ["up", "down", "up", "down"] as const) {
      const button = controls("between").find(
        (candidate) => candidate.dataset.reviewContextEdge === edge,
      );
      assert.ok(
        button,
        `between ${edge} control remains for alternating expansion`,
      );
      const oldStart = Number(button.dataset.reviewContextOldStart);
      const oldEnd = Number(button.dataset.reviewContextOldEnd);
      const newStart = Number(button.dataset.reviewContextNewStart);
      const newEnd = Number(button.dataset.reviewContextNewEnd);
      assert.ok(oldEnd - oldStart + 1 <= 30);
      button.click();
      const request = b.messages.at(-1);
      b.w.dispatchEvent(
        new b.w.MessageEvent("message", {
          data: {
            type: "contextExpanded",
            regionId: request.regionId,
            file: request.file,
            direction: "between",
            oldStart,
            oldEnd,
            newStart,
            newEnd,
            oldLines: Array.from(
              { length: oldEnd - oldStart + 1 },
              (_, index) => `line ${oldStart + index}`,
            ),
            newLines: Array.from(
              { length: newEnd - newStart + 1 },
              (_, index) => `line ${newStart + index}`,
            ),
          },
        }),
      );
    }
    expandThree("below", "down");
  } finally {
    b.dom.window.close();
  }
});

test("end-of-file context expansions stay exhausted after authoritative restore", () => {
  const b = browser();
  const base = `diff --git a/src/tail.ts b/src/tail.ts
--- a/src/tail.ts
+++ b/src/tail.ts
@@ -1,3 +1,3 @@
 line one
-line two
+line two changed
 line three
`;
  try {
    b.state([], { patch: base });
    const below = () =>
      [
        ...b.w.document.querySelectorAll<HTMLButtonElement>(
          ".review-context-expansion-button",
        ),
      ].find((button) => button.dataset.reviewContextDirection === "below");
    const initial = below();
    assert.ok(initial);
    initial.click();
    const request = b.messages.at(-1);
    b.w.dispatchEvent(
      new b.w.MessageEvent("message", {
        data: {
          type: "contextExpanded",
          regionId: request.regionId,
          file: request.file,
          direction: "below",
          oldStart: 4,
          oldEnd: 4,
          newStart: 4,
          newEnd: 4,
          oldLines: ["line four"],
          newLines: ["line four"],
          endOfFile: true,
        },
      }),
    );
    assert.equal(below(), undefined);
    const restored = browser();
    try {
      restored.state([], {
        patch: base,
        expandedRanges: [
          {
            id: request.regionId,
            file: request.file,
            direction: "below",
            oldStart: 4,
            oldEnd: 4,
            newStart: 4,
            newEnd: 4,
          },
        ],
        snapshot: {
          patch: base,
          expandedRanges: [
            {
              id: request.regionId,
              file: request.file,
              direction: "below",
              oldStart: 4,
              oldEnd: 4,
              newStart: 4,
              newEnd: 4,
            },
          ],
          sourceRanges: [
            {
              id: request.regionId,
              file: request.file,
              oldStart: 4,
              oldLines: ["line four"],
              newStart: 4,
              newLines: ["line four"],
            },
          ],
        },
      });
      assert.equal(
        [
          ...restored.w.document.querySelectorAll<HTMLButtonElement>(
            ".review-context-expansion-button",
          ),
        ].find((button) => button.dataset.reviewContextDirection === "below"),
        undefined,
      );
    } finally {
      restored.dom.window.close();
    }
  } finally {
    b.dom.window.close();
  }
});

test("legacy 20-line tail ranges do not imply EOF after increasing the step", () => {
  const b = browser();
  const patch =
    "diff --git a/tail.ts b/tail.ts\n--- a/tail.ts\n+++ b/tail.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+changed\n three\n";
  const range = {
    id: "legacy",
    file: "tail.ts",
    direction: "below",
    oldStart: 4,
    oldEnd: 23,
    newStart: 4,
    newEnd: 23,
  };
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 4}`);
  try {
    b.state([], {
      patch,
      snapshot: {
        patch,
        expandedRanges: [range],
        sourceRanges: [{ ...range, oldLines: lines, newLines: lines }],
      },
    });
    const control = b.w.document.querySelector<HTMLButtonElement>(
      '[data-review-context-direction="below"]',
    );
    assert.ok(control);
    assert.equal(control.dataset.reviewContextNewStart, "24");
    assert.equal(control.dataset.reviewContextNewEnd, "53");
  } finally {
    b.dom.window.close();
  }
});

test("context expansion errors stay beside the retry control", () => {
  const b = browser();
  try {
    const expansionPatch = `diff --git a/src/error.ts b/src/error.ts
--- a/src/error.ts
+++ b/src/error.ts
@@ -50,3 +50,3 @@
 line fifty
-line fifty one
+line fifty one changed
 line fifty two
`;
    b.state([], { patch: expansionPatch });
    const button = b.w.document.querySelector<HTMLButtonElement>(
      '.review-context-expansion-button[data-review-context-direction="above"]',
    );
    assert.ok(button);
    button.click();
    const request = b.messages.at(-1);
    b.w.dispatchEvent(
      new b.w.MessageEvent("message", {
        data: {
          type: "contextError",
          regionId: request.regionId,
          message: "Sapling could not read this file.",
        },
      }),
    );
    assert.equal(
      b.w.document.querySelector(".review-context-expansion-error")
        ?.textContent,
      "Sapling could not read this file.",
    );
    const messages = b.messages.length;
    b.w.document
      .querySelector<HTMLButtonElement>(".review-context-expansion-button")!
      .click();
    assert.equal(b.messages.length, messages + 1);
    assert.equal(b.messages.at(-1).type, "expandContext");
  } finally {
    b.dom.window.close();
  }
});

test("webview restores interrupted comment drafts and allows retry without leaking to another repository", () => {
  const first = browser();
  let stored: any;
  try {
    first.state();
    first.line(2).querySelector<HTMLButtonElement>("button")!.click();
    const input = first.w.document.querySelector<HTMLTextAreaElement>(
      ".review-composer textarea",
    )!;
    input.value = "Unsaved draft";
    input.dispatchEvent(new first.w.Event("input"));
    first.button("Save comment").click();
    stored = first.stored();
  } finally {
    first.dom.window.close();
  }
  const restored = browser(stored);
  try {
    restored.state();
    assert.equal(
      restored.w.document.querySelector<HTMLTextAreaElement>(
        ".review-composer textarea",
      )?.value,
      "Unsaved draft",
    );
    assert.equal(restored.button("Save comment").disabled, false);
    restored.button("Save comment").click();
    restored.w.dispatchEvent(
      new restored.w.MessageEvent("message", {
        data: { type: "error", message: "Disk full" },
      }),
    );
    assert.equal(restored.button("Save comment").disabled, false);
    assert.equal(
      restored.w.document.querySelector<HTMLTextAreaElement>(
        ".review-composer textarea",
      )?.value,
      "Unsaved draft",
    );
    restored.state([], { repo: "/other" });
    assert.equal(restored.w.document.querySelector(".review-composer"), null);
  } finally {
    restored.dom.window.close();
  }
});

test("renamed files use old and new filenames for their respective anchors", () => {
  const b = browser();
  try {
    b.state([], {
      patch: patch
        .replaceAll("a/a/example.ts", "a/old.ts")
        .replaceAll("b/a/example.ts", "b/new.ts"),
    });
    assert.equal(b.line(2, "old").dataset.reviewFile, "old.ts");
    assert.equal(b.line(2, "new").dataset.reviewFile, "new.ts");
    assert.match(
      b.w.document.querySelector<HTMLElement>(".d2h-file-name")?.textContent ??
        "",
      /old\.ts.*→.*new\.ts/,
    );
  } finally {
    b.dom.window.close();
  }
});

test("large deleted file bodies are gated before rows enter the DOM", () => {
  const b = browser();
  const lines = Array.from(
    { length: 4_001 },
    (_, index) => `-line ${index + 1}`,
  );
  const largeDeleted = [
    "diff --git a/generated.txt b/generated.txt",
    "deleted file mode 100644",
    "--- a/generated.txt",
    "+++ /dev/null",
    "@@ -1,4001 +0,0 @@",
    ...lines,
    "",
  ].join("\n");
  try {
    b.state([], { patch: largeDeleted });
    const file = b.w.document.querySelector<HTMLElement>(".d2h-file-wrapper")!;
    assert.ok(file.querySelector(".review-large-file-button"));
    assert.equal(file.querySelector('[data-review-line="4001"]'), null);
    file.querySelector<HTMLButtonElement>(".review-large-file-button")!.click();
    assert.ok(
      b.w.document.querySelector('[data-review-line="4001"]'),
      "revealing the file renders its complete body",
    );
  } finally {
    b.dom.window.close();
  }
});

test("the initial file body budget is cumulative across changed files", () => {
  const b = browser();
  const file = (name: string) => {
    const lines = Array.from(
      { length: 2_500 },
      (_, index) => `-line ${index + 1}`,
    );
    return [
      `diff --git a/${name} b/${name}`,
      `deleted file mode 100644`,
      `--- a/${name}`,
      "+++ /dev/null",
      "@@ -1,2500 +0,0 @@",
      ...lines,
      "",
    ].join("\n");
  };
  try {
    b.state([], { patch: `${file("first.txt")}\n${file("second.txt")}` });
    const wrappers = [
      ...b.w.document.querySelectorAll<HTMLElement>(".d2h-file-wrapper"),
    ];
    assert.equal(wrappers.length, 2);
    assert.equal(
      wrappers[0].querySelector('[data-review-line="2500"]') !== null,
      true,
    );
    assert.equal(wrappers[1].querySelector('[data-review-line="2500"]'), null);
    assert.ok(wrappers[1].querySelector(".review-large-file-button"));
  } finally {
    b.dom.window.close();
  }
});

test("comment navigation reveals a gated deleted file", () => {
  const b = browser();
  const lines = Array.from(
    { length: 4_001 },
    (_, index) => `-line ${index + 1}`,
  );
  const largeDeleted = [
    "diff --git a/generated.txt b/generated.txt",
    "deleted file mode 100644",
    "--- a/generated.txt",
    "+++ /dev/null",
    "@@ -1,4001 +0,0 @@",
    ...lines,
    "",
  ].join("\n");
  try {
    b.state(
      [
        {
          id: "deleted-comment",
          body: "Check generated output.",
          status: "current",
          anchor: {
            file: "generated.txt",
            side: "old",
            start: 4001,
            end: 4001,
            text: ["line 4001"],
          },
        },
      ],
      { patch: largeDeleted },
    );
    b.w.document
      .querySelector<HTMLButtonElement>(
        '[data-index-comment-id="deleted-comment"] button',
      )!
      .click();
    assert.ok(b.w.document.querySelector('[data-review-line="4001"]'));
    assert.ok(
      b.w.document.querySelector('[data-comment-id="deleted-comment"]'),
    );
  } finally {
    b.dom.window.close();
  }
});

test("named review controls, tree navigation, persisted layout, and batch drafts", () => {
  const b = browser({ mode: "inline" });
  try {
    b.state([], {
      repo: "/repo",
      reviewId: "review-1",
      reviewName: "API cleanup",
      repos: ["/repo", "/other"],
      reviews: [
        {
          id: "review-1",
          name: "API cleanup",
          updatedAt: "2025-01-02T03:04:05.000Z",
          command: "sl diff --git --rev .",
        },
        {
          id: "review-2",
          name: "Docs",
          updatedAt: "2025-02-03T03:04:05.000Z",
          command: "sl diff --git --rev .^",
        },
      ],
      viewMode: "split",
      patch: patch
        .replaceAll("a/a/example.ts", "a/src/example.ts")
        .replaceAll("b/a/example.ts", "b/docs/readme.md"),
    });
    const repositories =
      b.w.document.querySelector<HTMLSelectElement>("#review-repo")!;
    const reviews =
      b.w.document.querySelector<HTMLSelectElement>("#review-review")!;
    assert.deepEqual(
      [...repositories.options].map((option) => option.textContent),
      ["/repo", "/other"],
    );
    assert.match(reviews.options[0].textContent ?? "", /API cleanup/);
    assert.match(reviews.options[0].textContent ?? "", /Jan 2, 2025/);
    assert.equal(
      b.w.document
        .querySelector<HTMLButtonElement>('[data-mode="split"]')
        ?.getAttribute("aria-pressed"),
      "true",
    );
    assert.ok(b.w.document.querySelector(".review-toc details"));
    assert.ok(
      [...b.w.document.querySelectorAll(".review-toc a")].every((anchor) =>
        anchor.getAttribute("title")?.includes("/"),
      ),
    );
    b.w.document
      .querySelector<HTMLButtonElement>('[data-mode="inline"]')!
      .click();
    assert.deepEqual(b.messages.at(-1), { type: "viewMode", mode: "inline" });

    b.line(2).querySelector<HTMLButtonElement>("button")!.click();
    const first = b.w.document.querySelector<HTMLTextAreaElement>(
      ".review-composer textarea",
    )!;
    first.value = "First draft";
    first.dispatchEvent(new b.w.Event("input"));
    b.line(3).querySelector<HTMLButtonElement>("button")!.click();
    const second = b.w.document.querySelector<HTMLTextAreaElement>(
      ".review-composer textarea",
    )!;
    second.value = "Second draft";
    second.dispatchEvent(new b.w.Event("input"));
    b.button("Save all comments").click();
    const batch = b.messages.at(-1);
    assert.equal(batch.type, "saveComments");
    assert.deepEqual(
      batch.comments.map((comment: any) => comment.body),
      ["First draft", "Second draft"],
    );
    assert.ok(batch.comments[0].anchor.file.includes("/"));
    const acknowledged = batch.comments.map((comment: any, index: number) => ({
      ...comment,
      id: `new-${index}`,
      status: "current",
    }));
    b.state(acknowledged, {
      repo: "/repo",
      reviewId: "review-1",
      patch: patch
        .replaceAll("a/a/example.ts", "a/src/example.ts")
        .replaceAll("b/a/example.ts", "b/docs/readme.md"),
    });
    assert.deepEqual(Object.keys(b.stored().drafts ?? {}), []);
  } finally {
    b.dom.window.close();
  }
});

test("comment index jumps into folded files and deletes saved comments", () => {
  const b = browser();
  try {
    const current = {
      id: "current",
      body: "Please fix\nthis expression",
      status: "current",
      anchor: {
        file: "a/example.ts",
        side: "new",
        start: 2,
        end: 3,
        text: ["const two = 3;", "const three = 3;"],
      },
    };
    const outdated = {
      id: "old",
      body: "A removed file comment",
      status: "outdated",
      anchor: {
        file: "gone.ts",
        side: "old",
        start: 10,
        end: 10,
        text: ["gone"],
      },
    };
    b.state([current, outdated]);
    const entries = () => [
      ...b.w.document.querySelectorAll<HTMLElement>(".review-comment-index li"),
    ];
    assert.equal(entries().length, 2);
    assert.match(entries()[0].textContent!, /a\/example.ts:2–3 \(new\)/);
    assert.match(entries()[0].textContent!, /Please fix this expression/);
    assert.match(entries()[1].textContent!, /Outdated/);
    const wrapper = b.w.document.querySelector(".d2h-file-wrapper")!;
    wrapper.querySelector<HTMLButtonElement>(".review-file-toggle")!.click();
    assert.ok(wrapper.classList.contains("review-collapsed"));
    entries()[0]
      .querySelector<HTMLButtonElement>(".review-comment-jump")!
      .click();
    assert.equal(wrapper.classList.contains("review-collapsed"), false);
    assert.equal(
      (b.w.document.activeElement as HTMLElement).dataset.commentId,
      "current",
    );
    assert.equal(
      b.messages.some((message) => message.type === "open"),
      false,
    );
    entries()[1]
      .querySelector<HTMLButtonElement>(".review-comment-jump")!
      .click();
    assert.equal(
      (b.w.document.activeElement as HTMLElement).dataset.commentId,
      "old",
    );
    entries()[0]
      .querySelector<HTMLButtonElement>('button[aria-label^="Delete"]')!
      .click();
    assert.deepEqual(b.messages.at(-1), {
      type: "deleteComment",
      id: "current",
    });
    assert.equal(
      entries().length,
      2,
      "retain index entry until storage acknowledges deletion",
    );
    assert.ok(
      entries()[0].querySelector<HTMLButtonElement>(
        'button[aria-label^="Delete"]',
      )!.disabled,
    );
    b.state([outdated]);
    assert.equal(entries().length, 1);
    assert.equal(
      b.w.document.querySelector(".review-comment-count")!.textContent,
      "1",
    );
    b.w.document
      .querySelector<HTMLButtonElement>('[data-mode="split"]')!
      .click();
    assert.equal(entries().length, 1);
  } finally {
    b.dom.window.close();
  }
});

test("review manager shows actions immediately, searches, and scopes delete all", () => {
  const b = browser();
  try {
    const reviews = [
      {
        id: "review-1",
        name: "API cleanup",
        updatedAt: "2025-01-02T03:04:05.000Z",
        command: "sl diff --git --rev .",
        commentCount: 2,
      },
      {
        id: "review-2",
        name: "Docs",
        updatedAt: "2025-02-03T03:04:05.000Z",
        command: "sl diff --git --rev .^",
        commentCount: 0,
      },
    ];
    b.state([], { repo: "/repo", reviewId: "review-1", reviews });
    b.button("Manage reviews…").click();
    const dialog = () =>
      b.w.document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog());
    assert.equal(
      dialog()!.querySelectorAll<HTMLElement>('[role="listitem"]').length,
      2,
    );
    const first = dialog()!.querySelector<HTMLElement>(
      '[data-review-id="review-1"]',
    )!;
    assert.deepEqual(
      [...first.querySelectorAll("button")].map(
        (button) => button.getAttribute("aria-label") || button.textContent,
      ),
      ["Open", "Rename", "Export", "Delete"],
    );
    assert.match(first.textContent ?? "", /2 comments/);
    assert.ok(first.classList.contains("is-current"));

    const focusable = [
      ...dialog()!.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])",
      ),
    ];
    focusable.at(-1)!.focus();
    focusable
      .at(-1)!
      .dispatchEvent(
        new b.w.KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
    assert.equal(b.w.document.activeElement, focusable[0]);
    focusable[0].focus();
    focusable[0].dispatchEvent(
      new b.w.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
      }),
    );
    assert.equal(b.w.document.activeElement, focusable.at(-1));

    const search = dialog()!.querySelector<HTMLInputElement>(
      ".review-manager-search",
    )!;
    search.value = "docs";
    search.dispatchEvent(new b.w.Event("input", { bubbles: true }));
    assert.equal(search.value, "docs");
    assert.deepEqual(
      [...dialog()!.querySelectorAll<HTMLElement>('[role="listitem"]')].map(
        (item) => item.dataset.reviewId,
      ),
      ["review-2"],
    );

    dialog()!
      .querySelector<HTMLButtonElement>('[data-review-id="review-2"] button')!
      .click();
    assert.deepEqual(b.messages.at(-1), {
      type: "manageReviewAction",
      action: "open",
      repo: "/repo",
      id: "review-2",
    });
    assert.equal(dialog(), null, "opening a review closes the manager");

    b.button("Manage reviews…").click();
    const manager = dialog()!;
    manager
      .querySelector<HTMLButtonElement>(
        '[data-review-id="review-1"] button:nth-of-type(2)',
      )!
      .click();
    assert.deepEqual(b.messages.at(-1), {
      type: "manageReviewAction",
      action: "rename",
      repo: "/repo",
      id: "review-1",
    });
    manager
      .querySelector<HTMLButtonElement>(
        '[data-review-id="review-1"] button:nth-of-type(3)',
      )!
      .click();
    assert.deepEqual(b.messages.at(-1), {
      type: "manageReviewAction",
      action: "export",
      repo: "/repo",
      id: "review-1",
    });
    manager
      .querySelector<HTMLButtonElement>(
        '[data-review-id="review-1"] button:nth-of-type(4)',
      )!
      .click();
    assert.deepEqual(b.messages.at(-1), {
      type: "manageReviewAction",
      action: "delete",
      repo: "/repo",
      id: "review-1",
    });

    manager
      .querySelector<HTMLButtonElement>(".review-manager-delete-all")!
      .click();
    assert.deepEqual(b.messages.at(-1), {
      type: "manageReviewAction",
      action: "deleteAll",
      repo: "/repo",
    });

    const reopenedSearch = manager.querySelector<HTMLInputElement>(
      ".review-manager-search",
    )!;
    reopenedSearch.value = "docs";
    reopenedSearch.dispatchEvent(new b.w.Event("input", { bubbles: true }));

    b.state([], {
      repo: "/other",
      reviews: [
        {
          id: "other-review",
          name: "Other docs",
          updatedAt: "2025-03-04T03:04:05.000Z",
          command: "sl diff --git --rev .",
          commentCount: 1,
        },
      ],
    });
    assert.ok(dialog(), "state updates keep the manager open");
    assert.equal(
      dialog()!.querySelector<HTMLInputElement>(".review-manager-search")!
        .value,
      "docs",
    );
    assert.deepEqual(
      [...dialog()!.querySelectorAll<HTMLElement>('[role="listitem"]')].map(
        (item) => item.dataset.reviewId,
      ),
      ["other-review"],
    );
  } finally {
    b.dom.window.close();
  }
});
