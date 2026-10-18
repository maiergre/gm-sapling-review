import { build, transform } from "esbuild";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  outfile: "dist/extension.js",
  sourcemap: true,
});
await build({
  entryPoints: ["webview/main.ts"],
  bundle: true,
  platform: "browser",
  outfile: "dist/main.js",
  sourcemap: true,
  minify: true,
});
await copyFile("webview/style.css", "dist/style.css");
await copyFile(
  "node_modules/diff2html/bundles/css/diff2html.min.css",
  "dist/diff2html.css",
);
const dark = await readFile(
  "node_modules/highlight.js/styles/github-dark.css",
  "utf8",
);
const light = await readFile(
  "node_modules/highlight.js/styles/github.css",
  "utf8",
);
const scopedLight = await transform(
  `:is(body.vscode-light, body.vscode-high-contrast-light) { ${light} }`,
  { loader: "css", target: "chrome100" },
);
await writeFile("dist/highlight.css", dark + "\n" + scopedLight.code);
