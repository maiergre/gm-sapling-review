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
    assert.equal(
      command.value,
      "sl diff --git --rev ancestor(.,interestingmaster())",
    );
    assert.deepEqual(b.messages.at(-1), {
      type: "refresh",
      choice: "stack",
      command: "sl diff --git --rev ancestor(.,interestingmaster())",
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
    command.value = "sl diff --git --rev abc123 --include src/app.ts";
    command.dispatchEvent(new b.w.Event("input"));
    b.w.document
      .querySelector<HTMLButtonElement>(".review-refresh-button")!
      .click();
    assert.deepEqual(b.messages.at(-1), {
      type: "refresh",
      choice: "custom",
      command: "sl diff --git --rev abc123 --include src/app.ts",
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
