import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { buildSync } from "esbuild";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const longContextValue = "x".repeat(320);

const patch = `diff --git a/config.toml b/config.toml
--- a/config.toml
+++ b/config.toml
@@ -1232,4 +1232,7 @@
 [[package]]
 name = "regex"
-version = "1.12.4"
+version = "1.13.1"
 checksum = "${longContextValue}"
+
+[[package]]
+name = "another-package"
@@ -1300,4 +1303,4 @@
 [[package]]
 name = "tail-package"
-version = "1.0.0"
+version = "1.0.1"
 checksum = "tail"
diff --git a/docs/REVIEW.md b/docs/REVIEW.md
--- a/docs/REVIEW.md
+++ b/docs/REVIEW.md
@@ -1,7 +1,8 @@
 # Review
-Old paragraph with one word
+New paragraph with another word
-
+Inserted replacement line
+Second inserted line
 Existing context
-Removed paragraph
+Added paragraph
 
 Trailing context
`;

const comments = [
  {
    id: "comment-1",
    anchor: {
      file: "config.toml",
      side: "new" as const,
      start: 1234,
      end: 1234,
      text: ['version = "1.13.1"'],
    },
    body: "Please confirm this version bump.",
    status: "current" as const,
  },
];

const reviewState = {
  repo: "/workspace/project",
  reviewId: "review-1",
  reviewName: "Release review",
  repos: ["/workspace/project", "/workspace/other"],
  reviews: [
    {
      id: "review-1",
      name: "Release review",
      updatedAt: "2026-10-17T12:00:00.000Z",
      command: "sl diff --git --rev .^",
    },
  ],
};

test("real browser: readable themed diffs and aligned four-digit gutters in both layouts", async (t) => {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const artifacts = await mkdtemp(join(tmpdir(), "sapling-review-rendering-"));
  t.diagnostic(`Screenshots: ${artifacts}`);
  const bundle = buildSync({
    entryPoints: ["webview/main.ts"],
    bundle: true,
    write: false,
    platform: "browser",
    loader: { ".css": "empty" },
  }).outputFiles[0].text;
  const styles = await Promise.all(
    [
      "dist/highlight.css",
      "node_modules/diff2html/bundles/css/diff2html.min.css",
      "webview/style.css",
    ].map((p) => readFile(p, "utf8")),
  );
  try {
    for (const theme of ["dark", "light"] as const) {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        colorScheme: theme === "dark" ? "light" : "dark",
      });
      await page.setContent(
        `<body class="vscode-${theme}" style="--vscode-editor-background:${theme === "dark" ? "#1e1e1e" : "#ffffff"};--vscode-editor-foreground:${theme === "dark" ? "#d4d4d4" : "#24292e"};--vscode-descriptionForeground:${theme === "dark" ? "#aaaaaa" : "#555555"};--vscode-sideBar-background:${theme === "dark" ? "#252526" : "#f3f3f3"};--vscode-editorWidget-background:${theme === "dark" ? "#252526" : "#f3f3f3"};--vscode-panel-border:${theme === "dark" ? "#3c3c3c" : "#dddddd"};--vscode-font-family:Arial;--vscode-font-size:13px;--vscode-editor-font-size:13px"><div id="toolbar"></div><div id="status"></div><main id="diff"></main><section id="comments"></section></body>`,
      );
      await page.evaluate(() =>
        document.documentElement.setAttribute(
          "style",
          document.body.getAttribute("style")!,
        ),
      );
      await page.evaluate("globalThis.__name = fn => fn"); // tsx function-name helper for serialized callbacks
      for (const content of styles) await page.addStyleTag({ content });
      await page.evaluate(() => {
        (window as any).acquireVsCodeApi = () => ({
          postMessage: () => {},
          getState: () => undefined,
          setState: () => {},
        });
      });
      await page.addScriptTag({ content: bundle });
      await page.evaluate(
        ({ patch, comments, reviewState }) =>
          window.dispatchEvent(
            new MessageEvent("message", {
              data: {
                type: "state",
                ...reviewState,
                command: "sl diff --git --rev .^",
                patch,
                comments,
              },
            }),
          ),
        { patch, comments, reviewState },
      );
      for (const layout of ["Inline", "Side by side"]) {
        await page.getByRole("button", { name: layout, exact: true }).click();
        await page.evaluate(() => {
          document
            .querySelector<HTMLButtonElement>(
              '[data-review-file="config.toml"][data-review-side="new"][data-review-line="1235"] .review-line-action',
            )
            ?.click();
        });
        const metrics = await page.evaluate(() => {
          const d = document;
          const get = <T extends Element = HTMLElement>(s: string) =>
            d.querySelector<T>(s)!;
          const getAll = <T extends Element>(root: ParentNode, s: string) => [
            ...root.querySelectorAll<T>(s),
          ];
          const rgb = (color: string) => {
            const canvas = d.createElement("canvas");
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext("2d")!;
            ctx.fillStyle = color;
            ctx.fillRect(0, 0, 1, 1);
            return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
          };
          const numbers = [
            ...d.querySelectorAll<HTMLElement>('[data-review-line="1234"]'),
          ];
          const gutter = numbers[0].closest("td")!;
          const row = gutter.closest("tr")!;
          const code = row.querySelector<HTMLElement>(
            ".d2h-code-line,.d2h-code-side-line",
          )!;
          const markdown = get('.d2h-file-wrapper[data-lang="md"]');
          const markdownGutters = [
            ...markdown.querySelectorAll<HTMLElement>(
              ".d2h-code-linenumber,.d2h-code-side-linenumber",
            ),
          ];
          const gutterStates = markdownGutters.map((el) => {
            const style = getComputedStyle(el);
            return {
              classes: el.className,
              borderRightColor: style.borderRightColor,
              borderRightStyle: style.borderRightStyle,
              borderRightWidth: style.borderRightWidth,
            };
          });
          const centerSides = [
            ...getAll<HTMLElement>(markdown, ".d2h-file-side-diff"),
          ];
          const markdownWords = [
            ...markdown.querySelectorAll<HTMLElement>(
              ".d2h-code-line ins,.d2h-code-line del,.d2h-code-side-line ins,.d2h-code-side-line del",
            ),
          ];
          const deletedBlank = [
            ...markdown.querySelectorAll<HTMLElement>("td.d2h-del"),
          ].find(
            (cell) =>
              cell.querySelector(".d2h-code-line-ctn")?.textContent === "",
          );
          const contextBlank = [
            ...markdown.querySelectorAll<HTMLElement>("td.d2h-cntx"),
          ].find(
            (cell) =>
              cell.querySelector(".d2h-code-line-ctn")?.textContent === "",
          );
          const commentCard = d.querySelector<HTMLElement>(
            ".review-thread-row .review-comment",
          );
          const composer = d.querySelector<HTMLElement>(
            ".review-thread-row .review-composer",
          );
          const composerScroller = composer?.closest<HTMLElement>(
            ".d2h-file-side-diff,.d2h-file-diff",
          );
          const contextRows = [
            ...d.querySelectorAll<HTMLElement>(
              '[data-review-file="config.toml"][data-review-line="1235"]',
            ),
          ].map((anchor) => ({
            side: anchor.dataset.reviewSide,
            top: anchor.closest("tr")?.getBoundingClientRect().top,
          }));
          return {
            repoValue: get<HTMLSelectElement>("#review-repo").value,
            reviewValue: get<HTMLSelectElement>("#review-review").value,
            reviewOptionText:
              get<HTMLSelectElement>("#review-review").selectedOptions[0]
                ?.textContent ?? "",
            backgrounds: [
              ...d.querySelectorAll<HTMLElement>(
                "td.d2h-change,td.d2h-emptyplaceholder,td.d2h-code-side-emptyplaceholder, .d2h-code-line ins,.d2h-code-line del",
              ),
            ].map((el) => rgb(getComputedStyle(el).backgroundColor)),
            text: rgb(getComputedStyle(get(".d2h-info")).color),
            rowHeight: row.getBoundingClientRect().height,
            indent:
              code.getBoundingClientRect().left -
              gutter.getBoundingClientRect().right,
            numbers: numbers.map((el) => {
              const r = d.createRange();
              r.selectNodeContents(el.firstChild!);
              return {
                width: el.clientWidth,
                textWidth: r.getBoundingClientRect().width,
                number: el.firstChild!.textContent,
              };
            }),
            inlinePositions: [
              ...d.querySelectorAll<HTMLElement>(
                ".d2h-cntx .line-num1,.d2h-cntx .line-num2",
              ),
            ]
              .slice(0, 2)
              .map((el) => el.getBoundingClientRect().top),
            center: centerSides.map((side) => {
              const rect = side.getBoundingClientRect();
              const style = getComputedStyle(side);
              return {
                left: rect.left,
                right: rect.right,
                borderRightColor: style.borderRightColor,
                borderRightStyle: style.borderRightStyle,
                borderRightWidth: style.borderRightWidth,
              };
            }),
            gutterStates,
            markdownWords: markdownWords.map((el) => {
              const style = getComputedStyle(el);
              return {
                display: style.display,
                background: style.backgroundColor,
                radius: style.borderRadius,
              };
            }),
            deletedBlankBackground: deletedBlank
              ? getComputedStyle(deletedBlank).backgroundColor
              : undefined,
            contextBlankBackground: contextBlank
              ? getComputedStyle(contextBlank).backgroundColor
              : undefined,
            contextBlankRgb: contextBlank
              ? rgb(getComputedStyle(contextBlank).backgroundColor)
              : undefined,
            comment: commentCard
              ? (() => {
                  const style = getComputedStyle(commentCard);
                  return {
                    background: style.backgroundColor,
                    borderStyle: style.borderStyle,
                    borderWidth: style.borderWidth,
                    radius: style.borderRadius,
                  };
                })()
              : undefined,
            composerBounds:
              composer && composerScroller
                ? {
                    composer: composer.getBoundingClientRect().toJSON(),
                    scroller: composerScroller.getBoundingClientRect().toJSON(),
                  }
                : undefined,
            contextButtonBounds: [
              ...d.querySelectorAll<HTMLElement>(
                ".review-context-expansion-button",
              ),
            ].map((button) => ({
              button: button.getBoundingClientRect().toJSON(),
              scroller: button
                .closest<HTMLElement>(".d2h-file-side-diff,.d2h-file-diff")!
                .getBoundingClientRect()
                .toJSON(),
            })),
            contextButtonPaneCounts: [
              ...d.querySelectorAll<HTMLElement>(".d2h-file-side-diff"),
            ].map(
              (pane) =>
                pane.querySelectorAll(".review-context-expansion-button")
                  .length,
            ),
            contextHeaders: [
              ...d.querySelectorAll<HTMLElement>(
                ".review-context-expansion-row .review-context-expansion-code .d2h-code-line, .review-context-expansion-row .review-context-expansion-code .d2h-code-side-line",
              ),
            ].map((header) => header.textContent?.trim() ?? ""),
            contextHeaderColors: [
              ...d.querySelectorAll<HTMLElement>(
                ".review-context-expansion-row .review-context-expansion-code .d2h-code-line, .review-context-expansion-row .review-context-expansion-code .d2h-code-side-line",
              ),
            ].map((header) => getComputedStyle(header).color),
            contextButtonStyles: [
              ...d.querySelectorAll<HTMLButtonElement>(
                ".review-context-expansion-button",
              ),
            ].map((button) => {
              const row = button.closest("tr")!;
              const cell = row.querySelector("td")!;
              const style = getComputedStyle(cell);
              const buttonStyle = getComputedStyle(button);
              return {
                cells: row.querySelectorAll(":scope > td").length,
                colSpan: (cell as HTMLTableCellElement).colSpan,
                icons: button.querySelectorAll("svg").length,
                label: button.querySelector(".review-context-expansion-label")
                  ?.textContent,
                labelDisplay: getComputedStyle(
                  button.querySelector(".review-context-expansion-label")!,
                ).display,
                background: style.backgroundColor,
                backgroundRgb: rgb(style.backgroundColor),
                contextBlankRgb: contextBlank
                  ? rgb(getComputedStyle(contextBlank).backgroundColor)
                  : undefined,
                text: buttonStyle.color,
                textRgb: rgb(buttonStyle.color),
                borderTopColor: style.borderTopColor,
                borderTopStyle: style.borderTopStyle,
                borderTopWidth: style.borderTopWidth,
                borderBottomColor: style.borderBottomColor,
                borderBottomStyle: style.borderBottomStyle,
                borderBottomWidth: style.borderBottomWidth,
              };
            }),
            contextRows,
          };
        });
        await page.screenshot({
          path: join(
            artifacts,
            `${theme}-${layout === "Inline" ? "inline" : "split"}.png`,
          ),
          fullPage: true,
        });
        assert.ok(metrics.rowHeight <= 24, `row height ${metrics.rowHeight}`);
        assert.equal(metrics.repoValue, reviewState.repo);
        assert.equal(metrics.reviewValue, reviewState.reviewId);
        assert.match(metrics.reviewOptionText, /Release review/);
        assert.match(metrics.reviewOptionText, /2026/);
        assert.ok(
          metrics.indent >= 0 && metrics.indent < 24,
          `code indent ${metrics.indent}`,
        );
        for (const n of metrics.numbers) {
          assert.equal(n.number?.trim(), "1234");
          assert.ok(
            n.width >= n.textWidth + 16,
            "line number has room for comment button",
          );
        }
        if (layout === "Inline")
          assert.equal(
            metrics.inlinePositions[0],
            metrics.inlinePositions[1],
            "old/new numbers must share a row",
          );
        assert.ok(metrics.gutterStates.length > 0, "markdown gutters exist");
        if (layout === "Side by side")
          assert.ok(
            metrics.gutterStates.some((state) =>
              state.classes.includes("emptyplaceholder"),
            ),
            `${layout} has a one-sided placeholder gutter`,
          );
        assert.ok(
          metrics.gutterStates.some((state) =>
            state.classes.includes("d2h-info"),
          ),
          `${layout} has a hunk gutter`,
        );
        const populatedGutter = metrics.gutterStates.find(
          (state) =>
            !state.classes.includes("emptyplaceholder") &&
            !state.classes.includes("d2h-info"),
        );
        assert.ok(populatedGutter, "populated markdown gutter exists");
        for (const state of metrics.gutterStates) {
          assert.equal(
            state.borderRightWidth,
            populatedGutter.borderRightWidth,
            `gutter width is continuous (${state.classes})`,
          );
          assert.equal(
            state.borderRightStyle,
            populatedGutter.borderRightStyle,
            `gutter style is continuous (${state.classes})`,
          );
          assert.equal(
            state.borderRightColor,
            populatedGutter.borderRightColor,
            `gutter color is continuous (${state.classes})`,
          );
        }
        if (layout === "Side by side") {
          assert.equal(metrics.center.length, 2, "split has two panes");
          assert.equal(
            metrics.center[0].borderRightWidth,
            "1px",
            "split center divider has width",
          );
          assert.equal(
            metrics.center[0].borderRightStyle,
            "solid",
            "split center divider is visible",
          );
          assert.ok(
            Math.abs(metrics.center[0].right - metrics.center[1].left) <= 1,
            "split panes meet at the center divider",
          );
          const contextTop = new Map(
            metrics.contextRows.map((row) => [row.side, row.top]),
          );
          assert.ok(contextTop.has("old") && contextTop.has("new"));
          assert.ok(
            Math.abs(contextTop.get("old")! - contextTop.get("new")!) <= 1,
            "split context rows stay aligned after an inline comment",
          );
        }
        assert.notEqual(
          metrics.deletedBlankBackground,
          metrics.contextBlankBackground,
          "deleted blank line keeps its deletion background",
        );
        for (const word of metrics.markdownWords) {
          assert.equal(word.display, "inline");
          assert.equal(word.radius, "0px");
        }
        assert.ok(metrics.comment, "inline comment card is rendered");
        assert.notEqual(
          metrics.comment.background,
          "rgba(0, 0, 0, 0)",
          "comment card has a surface",
        );
        assert.equal(metrics.comment.borderStyle, "solid");
        assert.equal(metrics.comment.borderWidth, "1px");
        assert.notEqual(metrics.comment.radius, "0px");
        assert.ok(metrics.composerBounds, "comment composer is rendered");
        assert.ok(
          metrics.composerBounds.composer.left >=
            metrics.composerBounds.scroller.left - 1,
          `${layout} composer starts within its visible pane`,
        );
        assert.ok(
          metrics.composerBounds.composer.right <=
            metrics.composerBounds.scroller.right + 1,
          `${layout} composer ends within its visible pane`,
        );
        assert.ok(
          metrics.contextButtonBounds.length > 0,
          `${layout} has context expansion controls`,
        );
        for (const bounds of metrics.contextButtonBounds) {
          assert.ok(
            bounds.button.width >= 28 && bounds.button.height >= 28,
            `${layout} context expansion control has a large click target: ${JSON.stringify(bounds.button)}`,
          );
          assert.ok(
            bounds.button.left >= bounds.scroller.left - 1 &&
              bounds.button.right <= bounds.scroller.right + 1,
            `${layout} context expansion control stays within its visible pane: ${JSON.stringify(bounds)}`,
          );
        }
        assert.ok(
          metrics.contextHeaders.length > 0 &&
            metrics.contextHeaders.every((header) => header.startsWith("@@")),
          `${theme}/${layout} expansion separators retain actual hunk headers: ${JSON.stringify(metrics.contextHeaders)}`,
        );
        assert.equal(
          new Set(metrics.contextHeaderColors).size,
          1,
          `${theme}/${layout} expansion hunk headers use one foreground color: ${JSON.stringify(metrics.contextHeaderColors)}`,
        );
        if (layout === "Side by side") {
          assert.ok(metrics.contextButtonPaneCounts.length >= 2);
          assert.ok(
            metrics.contextButtonPaneCounts.every((count) => count > 0),
            `${theme}/${layout} both line-number gutters have expansion controls: ${metrics.contextButtonPaneCounts}`,
          );
        }
        assert.ok(
          metrics.contextButtonStyles.every(
            (separator) =>
              separator.cells === 2 &&
              separator.colSpan === 1 &&
              separator.icons === 1 &&
              separator.label?.startsWith("Show ") &&
              separator.labelDisplay === "block" &&
              separator.borderTopStyle === "solid" &&
              separator.borderTopWidth === "1px" &&
              separator.borderBottomStyle === "solid" &&
              separator.borderBottomWidth === "1px" &&
              separator.background !== "rgba(0, 0, 0, 0)" &&
              separator.text !== "rgba(0, 0, 0, 0)" &&
              separator.borderTopColor !== separator.background &&
              separator.borderBottomColor !== separator.background &&
              separator.contextBlankRgb !== undefined &&
              separator.backgroundRgb.some(
                (channel, index) =>
                  Math.abs(channel - separator.contextBlankRgb![index]) > 4,
              ) &&
              separator.textRgb.some(
                (channel, index) =>
                  Math.abs(channel - separator.backgroundRgb[index]) > 30,
              ),
          ),
          `${theme}/${layout} expansion separators have icons, contrast, and borders`,
        );
        for (const color of metrics.backgrounds) {
          const brightness = color.reduce((a, b) => a + b, 0) / 3;
          assert.ok(
            theme === "dark" ? brightness < 110 : brightness > 150,
            `${theme} unexpected diff background ${color}`,
          );
        }
        assert.ok(
          theme === "dark"
            ? Math.min(...metrics.text) > 100
            : Math.max(...metrics.text) < 150,
          `${theme}/${layout} hunk label contrast: ${metrics.text}`,
        );
      }
      await page
        .getByRole("button", { name: "Manage reviews…", exact: true })
        .click();
      const manager = page.getByRole("dialog");
      await manager.waitFor({ state: "visible" });
      for (const name of ["Open", "Rename", "Export", "Delete", "Delete all"]) {
        assert.ok(
          await manager
            .getByRole("button", {
              name: name === "Delete all" ? /^Delete all/ : name,
              exact: true,
            })
            .isVisible(),
          `${name} directly visible in manager`,
        );
      }
      await page.screenshot({ path: join(artifacts, `${theme}-manager.png`) });
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
