# Sapling Review

A separate VS Code extension for reviewing Sapling diffs, with syntax highlighting and durable local comments. Source and build files live in this directory.

## Install the latest release

Download the versioned VSIX from the [latest GitHub release](https://github.com/maiergre/gm-sapling-review/releases/latest) and run **Extensions: Install from VSIX…** in VS Code.

Sapling's `sl` must be installed where the workspace runs. Run **Developer: Reload Window** after installing.

In a Remote SSH window, use **Extensions: Install from VSIX…** in the connected window to install on the remote host. A local installation does not also install the remote extension.

## Build and run from source

Requires Node.js 24 LTS (24.15 or newer) to build and test, VS Code 1.86 or newer, and `sl` on PATH (or set `gmSapling.commandPath`).

```sh
npm ci
npm run check
npm test
npm run build
npm run package
code --install-extension gm-sapling-review-0.1.2.vsix --force
```

For subsequent local updates, run `./build-and-install.sh`. It packages the current version and installs it into VS Code with `--force`; run `npm ci` first on a fresh checkout. Then run **Developer: Reload Window** in VS Code. The script can be invoked from any working directory.

For development, run `npm run build`, open this directory in VS Code, and press F5. In the Extension Development Host, open your project and run **GM Sapling Review: Open Diff** from the Command Palette.

## Reviewing

**GM Sapling Review: Open Diff** opens uncommitted changes. If more than one repository is found, choose one before the first diff runs. Use the **Repository** dropdown to switch repositories, and choose uncommitted, head, stack, or a custom command in the toolbar. All workspace folders are searched, including repositories nested under non-repository folders. Workspace folders inside an existing repository are supported too. Repository metadata, dependency directories, and symbolic links are excluded from recursive scanning.

The custom field contains only arguments passed to `sl diff`; the extension always adds `sl diff --git` and fetches full context for local expansion. Quoted arguments are supported. For example:

```sh
--rev 'ancestor(.,interestingmaster())'
--rev abc123 --rev def456
--rev abc123 --include src/app.ts
```

`--git`, `--unified`, and `-U` are managed internally. Shell pipelines, redirects, and command substitutions are unsupported. Custom arguments run only when explicitly refreshed, not automatically when a file is saved or the window is restored. Color is disabled for patch parsing.

Selecting a preset immediately refreshes the diff in the selected repository. Selecting **Custom command** leaves the current diff unchanged until you run the command. Clicking or focusing the command field switches to **Custom command**; edit the command and click **Refresh** (or press Enter) to run it. Use the **Repository** dropdown to select another repository. Running **GM Sapling Review: Open Diff** again also rescans workspace folders for newly created repositories.

Use the toolbar to switch between inline and side-by-side views. Your last layout is remembered across panel closes and restarts. The collapsible file tree at the top groups files by directory and links to each file. File headers fold/unfold their contents. Diff comparisons show controls above, below, and between hunks; each control expands only its own unchanged block. Click a line number to open the working-copy file in an editor; historical/deleted-side numbers refer to the original diff and may not match the working copy. Deleted files cannot be opened in the working copy.

Use a line's **+** button to start a comment; Shift-click another line's **+** button on the same side of the same file to select a range. Save, edit, or delete comments in the review view. **Save all comments** saves all nonempty new/edit drafts in the selected review in one atomic operation; other reviews’ drafts remain separate. **Export review** writes one Markdown file containing review name, repository, command, filenames, old/new sides, line ranges, quoted source, comment text, and outdated status. The suggested filename is `00-review-{reviewname}-yyyy-mm-dd.md`, using the local date. Export again after further edits to update that file. The comment index at the bottom lists all saved comments; click one to jump to it, or delete it directly from the list.

## Persistence and changed lines

Each repository starts with a **Default** review. Use the **Review** dropdown to select a review by name and last-modified date, **New review** to create another, and **Rename review** to change its name. Leaving a new review's name blank creates an “Untitled review”. **Manage reviews…** opens a searchable list for the selected repository showing comment counts and modification dates. Each review row has Open, Rename, Export, and Delete buttons. **Delete all** removes all reviews for the selected repository and starts an empty Default review. Both deletion actions require confirmation. Deleting the current review selects another, or starts an empty Default review if none remain. Reviews have stable IDs, so changing a name or the diff command does not lose or switch comments. Selecting a review restores its last command and snapshot; custom commands only rerun on explicit Refresh.

Saved comments and the last successful diff snapshot are written immediately to JSON in VS Code's extension global storage, keyed by repository and review ID. Writes use a temporary file, file sync, and atomic rename; save failures are shown instead of acknowledged. Closing/reopening restores the selected review. Webview drafts are kept separately by review; the layout preference is also stored in extension global state. Exported Markdown is a snapshot, not the storage backing the review.

Existing command-keyed reviews are imported automatically. Uncommitted reviews become Default where possible; other comparisons appear as “Imported: <command>”. Original files are retained and imports are idempotent, so repeated starts and renaming imported reviews do not duplicate comments.

The extension version stays at **0.1.2** during these iterations. Reinstall the rebuilt VSIX with `--force`, then run **Developer: Reload Window**.

Refreshing compares each comment's original source text against the same side and line range of the new patch. Changed, moved, or missing ranges are marked **outdated**, including comments on files no longer present. This deliberately conservative check does not silently relocate comments. Preset diffs refresh on editor saves; use **Refresh** for external changes and custom commands.

This is a review-focused companion, with its own command IDs. Keep the official Sapling SCM extension installed for smartlog, SCM status, commit/amend, blame, worktrees, and remote review integrations. Those features are not copied into this extension. The three preset revsets match [upstream comparison definitions](https://github.com/facebook/sapling/blob/79071c2a3ea20c36ed71332608535e5801101bba/addons/shared/Comparison.ts). The [upstream extension](https://github.com/facebook/sapling/tree/79071c2a3ea20c36ed71332608535e5801101bba/addons/vscode) already supports syntax highlighting, split/inline views, and context expansion; this implementation uses diff2html with highlight.js and adds the local review workflow and recursive repository discovery.

## Validation

`npm test` exercises command parsing, repository discovery, named-review migration and persistence, batch comment saving, repository switching, layout preferences, stale anchors, and review export. `npm run check` checks host and webview TypeScript. For real-browser theme and layout checks, run `npm run test:visual`. It uses the installed Google Chrome on macOS; set `CHROME_PATH` to a Chrome/Chromium executable on other systems. Screenshots are saved in a unique temporary directory reported by the test. The checks cover both layouts and deliberately use opposite OS/editor themes to catch palette leaks.

For a manual extension-host smoke test:

1. Open a non-repository folder containing two Sapling repos, then repeat with a multi-root workspace. Verify repository selection and command working directory.
2. Open each preset and a quoted custom revset. Toggle layout, follow file-list anchors, fold/unfold files, and click line numbers.
3. Add a single-line and a multiline comment on each side. Edit/delete a comment, export, and inspect the Markdown references.
4. Reload VS Code and reopen the same comparison. Verify saved comments remain. Change a commented line, save/refresh, and verify outdated styling; remove the file from the patch and verify its comments remain accessible.
5. Test light/dark themes, added/deleted/renamed files, empty diffs, and command failures.

## Icon attribution

The refresh, edit, add, trash, and close icons are from [Microsoft VS Code Codicons](https://github.com/microsoft/vscode-codicons/tree/main/src/icons), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Their paths are unchanged; sizing and color follow the extension theme.
