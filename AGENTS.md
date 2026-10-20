# GM Sapling Review

## Scope and workflow

- This is a standalone VS Code extension for Sapling diffs and local reviews.
- Check for nested AGENTS.md files before editing a subdirectory.
- Use Sapling (`sl`) for version control in this checkout. Check status before edits; preserve unrelated user changes. Do not commit or publish unless requested.
- Use parallel agents for independent subtasks when useful; assign non-overlapping file ownership and review their results. Handle small, coupled changes directly.
- Keep the extension version unchanged during iterative development unless the user requests a version bump.
- The upstream Sapling checkout is not required. README.md links to the pinned upstream reference; retain Meta's MIT attribution and third-party icon attribution.

## Code layout

- `src/core.ts`: command parsing, repository discovery, review storage, anchors, and Markdown export.
- `src/extension.ts`: VS Code host integration, Sapling execution, persistence, and webview messages.
- `webview/main.ts` and `webview/style.css`: diff2html rendering, highlighting, review UI, and theme styles.
- `test/*.test.ts`: core, mocked VS Code host, webview, and real Sapling integration tests.
- `test/visual/rendering.test.ts`: browser checks using Playwright and installed Chrome.
- `build.mjs`: bundles the extension and copies styles into `dist/`.

## Behavior to preserve

- Support multiple workspace folders and repositories nested under non-repository workspace roots.
- Reviews are identified by repository plus stable review ID, not diff command or display name. Preserve saved comments, migrations, and crash-recoverable drafts.
- Acknowledge saves only after durable storage succeeds. Deleting imported reviews must not allow legacy migration to resurrect them.
- Mark comments outdated when their original file, side, line range, or source text no longer matches; do not silently relocate them.
- Invoke Sapling with argument arrays, never a shell. Custom commands run only on explicit Refresh or Enter, since they can have side effects. Selecting a built-in preset refreshes immediately.
- Keep editor file/line navigation, file folding, tree navigation, both diff layouts, and the persisted layout preference working.
- Use VS Code theme variables, accessible labels, keyboard navigation, and tooltips for icon buttons. Keep destructive review actions confirmed and repository-scoped.

## Validation and packaging

- Install dependencies with `npm ci` when needed.
- Run `npm run check` and `npm test` for code changes. Use focused tests during iteration; avoid tests that merely duplicate trivial implementation details.
- For layout/theme changes, also run `npm run test:visual`. It defaults to macOS Google Chrome; set `CHROME_PATH` for another Chrome/Chromium executable.
- The real Sapling integration test needs `sl` on PATH and skips if unavailable. Note skipped or unavailable checks in the result.
- Format changed code with `npx prettier --write <files>`; avoid rewriting unrelated local configuration.
- For an installable update, run `npm run package`. This runs type checking and builds the VSIX. Reinstall same-version builds with `code --install-extension <file>.vsix --force`, then reload VS Code.
- Do not track `node_modules/`, `dist/`, or `*.vsix`. Track shared VS Code launch/tasks files; keep local settings ignored. Keep development files out of the VSIX via `.vscodeignore`.
- Create temporary files inside a unique directory from `mkdtemp`/`mktemp -d`, never directly in a shared temporary directory.

## Creating a GitHub release

- Confirm the working copy is clean, the release version matches in `package.json` and `package-lock.json`, and the intended release commit is present on `remote/main`. Do not publish from an uncommitted or local-only revision.
- Check that the `v<version>` tag and GitHub release do not already exist. Follow the existing convention: tag `v<version>` and release title `GM Sapling Review <version>`.
- Run `npm run check`, `npm test`, and `npm run test:visual`, then run `npm run package` to rebuild the versioned VSIX from the release commit. Set `TMPDIR` to the session temporary root for tests that create artifacts.
- Create release notes summarizing user-visible changes since the previous release. State the VS Code and Sapling requirements and retain the Remote SSH and reload guidance when applicable.
- Publish the GitHub release from the verified commit with the versioned `gm-sapling-review-<version>.vsix` and `install-latest.py` assets. The installer is version-independent; obtain the validated copy from the previous release when it is unchanged.
- After publishing, verify that the release is public (not a draft or prerelease), targets the intended commit, contains exactly the expected assets, and reports the locally calculated SHA-256 digest for each asset.
