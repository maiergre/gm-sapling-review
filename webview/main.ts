import { parse } from "diff2html";
import { Diff2HtmlUI } from "diff2html/lib/ui/js/diff2html-ui.js";
import "./style.css";

type DiffSide = "old" | "new";
type ViewMode = "split" | "inline";
type ContextExpansionDirection = "above" | "below" | "between";

const DEFAULT_CONTEXT_LINES = 4;
/** Maximum number of lines requested for one context expansion. */
const CONTEXT_EXPANSION_LINES = 30;
/** Keep the initial review body bounded across all files. */
const MAX_INITIAL_RENDERED_FILE_ROWS = 4000;
/** Refuse to create an unbounded DOM even after an explicit reveal. */
const MAX_HARD_RENDERED_FILE_ROWS = 100_000;

export interface ReviewAnchor {
  file: string;
  side: DiffSide;
  start: number;
  end: number;
  text: string[];
}

export interface ReviewComment {
  id: string;
  anchor: ReviewAnchor;
  body: string;
  createdAt?: string;
  updatedAt?: string;
  status?: "current" | "outdated";
}

interface ReviewStateMessage {
  type: "state";
  repo?: string;
  directory?: string;
  command?: string;
  reviewId?: string;
  reviewName?: string;
  repos?: string[];
  reviews?: ReviewSummary[];
  viewMode?: ViewMode;
  /** The unified context requested for the current patch, when known. */
  contextLines?: number;
  canExpandContext?: boolean;
  /** Arguments shown in the custom diff field, without internal flags. */
  customCommand?: string;
  patch?: string;
  comments?: ReviewComment[];
  /** Optional host metadata for bounded context and body loading. */
  snapshotId?: string;
  expandedRanges?: Array<{
    id: string;
    file: string;
    direction: ContextExpansionDirection;
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
  }>;
  snapshot?: SnapshotMetadata;
}

interface ContextExpandedMessage {
  type: "contextExpanded";
  regionId?: string;
  file?: string;
  direction?: ContextExpansionDirection;
  oldStart?: number;
  oldEnd?: number;
  newStart?: number;
  newEnd?: number;
  oldLines?: string[];
  newLines?: string[];
  patch?: string;
  endOfFile?: boolean;
}

interface ContextErrorMessage {
  type: "contextError";
  regionId?: string;
  message?: string;
}

interface SnapshotSourceRange {
  endOfFile?: boolean;
  id: string;
  file: string;
  oldStart?: number;
  oldLines?: string[];
  newStart?: number;
  newLines?: string[];
  sourceKey?: string;
}

interface SnapshotMetadata {
  patch?: string;
  expandedRanges?: ReviewStateMessage["expandedRanges"];
  sourceRanges?: SnapshotSourceRange[];
}

interface ReviewSummary {
  id: string;
  name: string;
  updatedAt: string;
  command: string;
  /** Older hosts may omit this while their state is being upgraded. */
  commentCount?: number;
}

interface WebviewState {
  reviewScope?: string;
  mode?: ViewMode;
  viewMode?: ViewMode;
  drafts?: Record<string, string>;
  draftAnchors?: Record<string, ReviewAnchor>;
  draftScopes?: Record<string, string>;
  collapsed?: string[];
  pending?: PersistedPending[];
  selection?: Selection;
  activeComposerKey?: string;
  editingComment?: string;
  revealedFiles?: string[];
}

interface PersistedPending {
  key: string;
  scope?: string;
  id?: string;
  body: string;
  anchor?: ReviewAnchor;
  deleting?: boolean;
}

interface PendingSave {
  key: string;
  scope?: string;
  id?: string;
  body: string;
  anchor?: ReviewAnchor;
  deleting?: boolean;
}

interface Selection extends ReviewAnchor {}

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
}

declare global {
  // The VS Code webview API is injected into the page and is absent in a
  // regular browser, which is useful for developing and testing this UI.
  function acquireVsCodeApi<T = unknown>(): T;
}

const noopApi: VsCodeApi = {
  postMessage: () => undefined,
  getState: () => undefined,
  setState: () => undefined,
};

function getApi(): VsCodeApi {
  try {
    if (typeof acquireVsCodeApi === "function") {
      return acquireVsCodeApi<VsCodeApi>();
    }
  } catch {
    // Keep the webview usable in a browser preview.
  }
  return noopApi;
}

const vscode = getApi();
const restored = vscode.getState?.() ?? {};
const restoredReviewScope = restored.reviewScope;
const restoredPendingKeys = new Set(
  (restored.pending ?? [])
    .map((item) => item?.key)
    .filter((key): key is string => !!key),
);
const toolbar = requireElement<HTMLDivElement>("toolbar");
const status = requireElement<HTMLDivElement>("status");
const diff = requireElement<HTMLElement>("diff");
const comments = requireElement<HTMLElement>("comments");

let review: ReviewStateMessage = { type: "state", patch: "", comments: [] };
let mode: ViewMode =
  restored.viewMode === "split" || restored.mode === "split"
    ? "split"
    : "inline";
let drafts: Record<string, string> = { ...(restored.drafts ?? {}) };
let draftAnchors: Record<string, ReviewAnchor> = {
  ...(restored.draftAnchors ?? {}),
};
let draftScopes: Record<string, string> = { ...(restored.draftScopes ?? {}) };
// Index-based fold keys from early versions are intentionally discarded. A
// reordered diff must never apply an old fold choice to another file.
let collapsed = new Set<string>(
  (restored.collapsed ?? []).filter((key) => !/^\d+:/.test(key)),
);
let revealedFiles = new Set<string>(restored.revealedFiles ?? []);
let pending = new Map<string, PendingSave>();
let selection: Selection | undefined = restored.selection;
let editingComment: string | undefined = restored.editingComment;
let activeComposerKey: string | undefined = restored.activeComposerKey;
let customCommandInput: HTMLInputElement | undefined;
let repoSelect: HTMLSelectElement | undefined;
let reviewSelect: HTMLSelectElement | undefined;
let saveAllButton: HTMLButtonElement | undefined;
let threadObserver: ResizeObserver | undefined;
let hasAuthoritativeState = false;
let legacyDraftsForeign = false;
let reviewManager: HTMLElement | undefined;
let reviewManagerSearch = "";
let reviewManagerFocus: HTMLElement | null = null;
let pendingContextExpansion: { id: string } | undefined;
let pendingCommentNavigation: { id: string } | undefined;
const expandedContextBlocks = new Set<string>();
const exhaustedContextRegions = new Set<string>();
const contextExpansionErrors = new Map<string, string>();
const localExpansionProgress = new Map<string, { up: number; down: number }>();

const PRESET_COMMANDS: Record<string, string> = {
  uncommitted: "sl diff --git --rev .",
  head: "sl diff --git --rev .^",
  stack: "sl diff --git --rev ancestor(.,interestingmaster())",
};
const PRESET_ARGUMENTS: Record<string, string> = {
  uncommitted: "--rev .",
  head: "--rev .^",
  stack: "--rev ancestor(.,interestingmaster())",
};

for (const item of restored.pending ?? []) {
  if (item?.key && typeof item.body === "string") {
    pending.set(item.key, {
      key: item.key,
      scope: item.scope,
      id: item.id,
      body: item.body,
      anchor: item.anchor,
      deleting: item.deleting,
    });
  }
}

function requireElement<T extends HTMLElement>(id: string): T {
  const existing = document.getElementById(id);
  if (existing) return existing as T;
  const created = document.createElement("div");
  created.id = id;
  document.body.append(created);
  return created as unknown as T;
}

function send(message: Record<string, unknown>): void {
  try {
    vscode.postMessage(message);
  } catch (error) {
    showError(
      `Could not contact Sapling Review: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function persist(): void {
  try {
    vscode.setState({
      reviewScope: currentReviewScope(),
      mode,
      viewMode: mode,
      drafts,
      draftAnchors,
      draftScopes,
      collapsed: [...collapsed],
      revealedFiles: [...revealedFiles],
      pending: [...pending.values()].map(
        ({ key, scope, id, body, anchor, deleting }) => ({
          key,
          scope,
          id,
          body,
          anchor,
          deleting,
        }),
      ),
      selection,
      activeComposerKey,
      editingComment,
    });
  } catch {
    // A failed state write must not prevent a user from continuing to edit.
  }
}

function showError(message: string): void {
  status.textContent = message;
  status.dataset.kind = "error";
}

function showInfo(message: string): void {
  status.textContent = message;
  status.dataset.kind = "info";
}

function clearError(): void {
  if (status.dataset.kind === "error") status.dataset.kind = "info";
}

// Microsoft VS Code Codicons, CC BY 4.0; attribution in README.
const buttonIcons = {
  refresh: [
    {
      d: "M3 8C3 5.23858 5.23858 3 8 3C9.63527 3 11.0878 3.78495 12.0005 5H10C9.72386 5 9.5 5.22386 9.5 5.5C9.5 5.77614 9.72386 6 10 6H12.8904C12.8973 6.00014 12.9041 6.00014 12.911 6H13C13.2761 6 13.5 5.77614 13.5 5.5V2.5C13.5 2.22386 13.2761 2 13 2C12.7239 2 12.5 2.22386 12.5 2.5V4.03138C11.4009 2.78613 9.79253 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14C11.1301 14 13.6999 11.6035 13.9756 8.54488C14.0003 8.26985 13.7975 8.0268 13.5225 8.00202C13.2474 7.97723 13.0044 8.1801 12.9796 8.45512C12.75 11.003 10.6079 13 8 13C5.23858 13 3 10.7614 3 8Z",
    },
  ],
  edit: [
    {
      d: "M14.236 1.76386C13.2123 0.740172 11.5525 0.740171 10.5289 1.76386L2.65722 9.63549C2.28304 10.0097 2.01623 10.4775 1.88467 10.99L1.01571 14.3755C0.971767 14.5467 1.02148 14.7284 1.14646 14.8534C1.27144 14.9783 1.45312 15.028 1.62432 14.9841L5.00978 14.1151C5.52234 13.9836 5.99015 13.7168 6.36433 13.3426L14.236 5.47097C15.2596 4.44728 15.2596 2.78755 14.236 1.76386ZM11.236 2.47097C11.8691 1.8378 12.8957 1.8378 13.5288 2.47097C14.162 3.10413 14.162 4.1307 13.5288 4.76386L12.75 5.54269L10.4571 3.24979L11.236 2.47097ZM9.75002 3.9569L12.0429 6.24979L5.65722 12.6355C5.40969 12.883 5.10023 13.0595 4.76117 13.1465L2.19447 13.8053L2.85327 11.2386C2.9403 10.8996 3.1168 10.5901 3.36433 10.3426L9.75002 3.9569Z",
    },
  ],
  add: [
    {
      d: "M8 1.5C8 1.22386 7.77614 1 7.5 1C7.22386 1 7 1.22386 7 1.5V7H1.5C1.22386 7 1 7.22386 1 7.5C1 7.77614 1.22386 8 1.5 8H7V13.5C7 13.7761 7.22386 14 7.5 14C7.77614 14 8 13.7761 8 13.5V8H13.5C13.7761 8 14 7.77614 14 7.5C14 7.22386 13.7761 7 13.5 7H8V1.5Z",
    },
  ],
  trash: [
    {
      d: "M14 2H10C10 0.897 9.103 0 8 0C6.897 0 6 0.897 6 2H2C1.724 2 1.5 2.224 1.5 2.5C1.5 2.776 1.724 3 2 3H2.54L3.349 12.708C3.456 13.994 4.55 15 5.84 15H10.159C11.449 15 12.543 13.993 12.65 12.708L13.459 3H13.999C14.275 3 14.499 2.776 14.499 2.5C14.499 2.224 14.275 2 13.999 2H14ZM8 1C8.551 1 9 1.449 9 2H7C7 1.449 7.449 1 8 1ZM11.655 12.625C11.591 13.396 10.934 14 10.16 14H5.841C5.067 14 4.41 13.396 4.346 12.625L3.544 3H12.458L11.656 12.625H11.655ZM7 5.5V11.5C7 11.776 6.776 12 6.5 12C6.224 12 6 11.776 6 11.5V5.5C6 5.224 6.224 5 6.5 5C6.776 5 7 5.224 7 5.5ZM10 5.5V11.5C10 11.776 9.776 12 9.5 12C9.224 12 9 11.776 9 11.5V5.5C9 5.224 9.224 5 9.5 5C9.776 5 10 5.224 10 5.5Z",
    },
  ],
  close: [
    {
      d: "M13.85 13.1502C14.05 13.3502 14.05 13.6602 13.85 13.8602C13.75 13.9602 13.62 14.0102 13.5 14.0102C13.38 14.0102 13.24 13.9602 13.15 13.8602L8 8.71023L2.85 13.8602C2.75 13.9602 2.62 14.0102 2.5 14.0102C2.38 14.0102 2.24 13.9602 2.15 13.8602C1.95 13.6602 1.95 13.3502 2.15 13.1502L7.3 8.00023L2.15 2.85023C1.95 2.65023 1.95 2.34023 2.15 2.14023C2.35 1.94023 2.66 1.94023 2.86 2.14023L8.01 7.29023L13.16 2.14023C13.36 1.94023 13.67 1.94023 13.87 2.14023C14.07 2.34023 14.07 2.65023 13.87 2.85023L8.72 8.00023L13.87 13.1502H13.85Z",
    },
  ],
} as const;

function setButtonIcon(
  button: HTMLButtonElement,
  icon: keyof typeof buttonIcons,
  label: string,
): void {
  button.textContent = "";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.classList.add("review-icon-button");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 16 16",
    width: "16",
    height: "16",
    fill: "currentColor",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(key, value);
  for (const attributes of buttonIcons[icon]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    for (const [key, value] of Object.entries(attributes))
      path.setAttribute(key, value);
    svg.append(path);
  }
  button.append(svg);
}

function makeButton(
  label: string,
  onClick: (event: MouseEvent) => void,
  className = "",
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) button.className = className;
  const icon = (
    {
      "New review": "add",
      "Rename review": "edit",
      Rename: "edit",
      Edit: "edit",
      Close: "close",
    } as const
  )[label as "New review" | "Rename review" | "Rename" | "Edit" | "Close"];
  if (icon) setButtonIcon(button, icon, label);
  button.addEventListener("click", onClick);
  return button;
}

function formatReviewDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

type ReviewManagerAction =
  "open" | "rename" | "export" | "delete" | "deleteAll";

function sendReviewManagerAction(
  action: ReviewManagerAction,
  summary?: ReviewSummary,
): void {
  const message: Record<string, unknown> = {
    type: "manageReviewAction",
    action,
    repo: review.repo,
  };
  if (action !== "deleteAll" && summary) message.id = summary.id;
  send(message);
  if (action === "open") closeReviewManager();
}

function matchingReviewSummaries(): ReviewSummary[] {
  const query = reviewManagerSearch.trim().toLocaleLowerCase();
  const summaries = Array.isArray(review.reviews) ? review.reviews : [];
  if (!query) return summaries;
  return summaries.filter((summary) =>
    [summary.name, summary.id, summary.command]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query),
  );
}

function renderReviewManagerList(): void {
  if (!reviewManager) return;
  const list = reviewManager.querySelector<HTMLElement>(".review-manager-list");
  if (!list) return;
  list.replaceChildren();
  const summaries = matchingReviewSummaries();
  if (!summaries.length) {
    const empty = document.createElement("p");
    empty.className = "review-manager-empty";
    empty.textContent = reviewManagerSearch.trim()
      ? "No reviews match this search."
      : "There are no saved reviews for this repository.";
    list.append(empty);
    return;
  }
  for (const summary of summaries) {
    const row = document.createElement("article");
    row.className = "review-manager-item";
    row.setAttribute("role", "listitem");
    row.dataset.reviewId = summary.id;
    const isCurrent = summary.id === review.reviewId;
    if (isCurrent) {
      row.classList.add("is-current");
      row.setAttribute("aria-current", "true");
    }

    const details = document.createElement("div");
    details.className = "review-manager-item-details";
    const name = document.createElement("strong");
    name.className = "review-manager-item-name";
    name.textContent = summary.name || "Unnamed review";
    details.append(name);
    if (isCurrent) {
      const current = document.createElement("span");
      current.className = "review-manager-current";
      current.textContent = "Current review";
      details.append(current);
    }
    const metadata = document.createElement("span");
    metadata.className = "review-manager-item-metadata";
    const comments =
      typeof summary.commentCount === "number"
        ? `${summary.commentCount} comment${summary.commentCount === 1 ? "" : "s"}`
        : "";
    metadata.textContent = [
      `Modified ${formatReviewDate(summary.updatedAt)}`,
      comments,
    ]
      .filter(Boolean)
      .join(" · ");
    details.append(metadata);

    const actions = document.createElement("div");
    actions.className = "review-manager-item-actions";
    actions.append(
      makeButton("Open", () => sendReviewManagerAction("open", summary)),
      makeButton("Rename", () => sendReviewManagerAction("rename", summary)),
      makeButton("Export", () => sendReviewManagerAction("export", summary)),
      makeButton("Delete", () => sendReviewManagerAction("delete", summary)),
    );
    row.append(details, actions);
    list.append(row);
  }
}

function renderReviewManager(): void {
  if (!reviewManager) return;
  const repo = reviewManager.querySelector<HTMLElement>(
    ".review-manager-repository",
  );
  if (repo) {
    repo.textContent = review.repo
      ? `Repository: ${review.repo}`
      : "Choose a repository to manage reviews.";
  }
  const search = reviewManager.querySelector<HTMLInputElement>(
    ".review-manager-search",
  );
  if (search && search.value !== reviewManagerSearch)
    search.value = reviewManagerSearch;
  const deleteAll = reviewManager.querySelector<HTMLButtonElement>(
    ".review-manager-delete-all",
  );
  if (deleteAll) {
    const count = Array.isArray(review.reviews) ? review.reviews.length : 0;
    deleteAll.disabled = !review.repo || count === 0;
    deleteAll.textContent = count ? `Delete all (${count})` : "Delete all";
  }
  renderReviewManagerList();
}

function closeReviewManager(): void {
  if (!reviewManager) return;
  const focus = reviewManagerFocus;
  reviewManager.remove();
  reviewManager = undefined;
  reviewManagerFocus = null;
  reviewManagerSearch = "";
  if (focus?.isConnected) focus.focus();
}

function openReviewManager(): void {
  if (!reviewManager) {
    reviewManagerFocus = document.activeElement as HTMLElement | null;
    const backdrop = document.createElement("div");
    backdrop.className = "review-manager-backdrop";
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeReviewManager();
    });
    backdrop.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeReviewManager();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled])",
        ),
      ];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    const dialog = document.createElement("section");
    dialog.className = "review-manager-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "review-manager-title");
    const header = document.createElement("header");
    header.className = "review-manager-header";
    const heading = document.createElement("div");
    const title = document.createElement("h2");
    title.id = "review-manager-title";
    title.textContent = "Manage reviews";
    heading.append(title);
    const repository = document.createElement("p");
    repository.className = "review-manager-repository";
    heading.append(repository);
    header.append(heading);
    header.append(
      makeButton("Close", () => closeReviewManager(), "review-manager-close"),
    );
    dialog.append(header);

    const controls = document.createElement("div");
    controls.className = "review-manager-controls";
    const searchLabel = document.createElement("label");
    searchLabel.textContent = "Search reviews";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "review-manager-search";
    search.placeholder = "Name or command";
    search.setAttribute("aria-label", "Search reviews");
    search.value = reviewManagerSearch;
    search.addEventListener("input", () => {
      reviewManagerSearch = search.value;
      renderReviewManagerList();
    });
    searchLabel.append(search);
    controls.append(searchLabel);
    controls.append(
      makeButton(
        "Delete all",
        () => sendReviewManagerAction("deleteAll"),
        "review-manager-delete-all review-danger-action",
      ),
    );
    dialog.append(controls);

    const list = document.createElement("div");
    list.className = "review-manager-list";
    list.setAttribute("role", "list");
    dialog.append(list);
    backdrop.append(dialog);
    document.body.append(backdrop);
    reviewManager = backdrop;
  }
  renderReviewManager();
  reviewManager
    .querySelector<HTMLInputElement>(".review-manager-search")
    ?.focus();
}

function updateReviewControls(): void {
  if (repoSelect) {
    const repositories = Array.isArray(review.repos) ? review.repos : [];
    repoSelect.replaceChildren();
    if (!repositories.length) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = review.repo || "Choose a repository";
      repoSelect.append(empty);
    } else {
      for (const repo of repositories) {
        const option = document.createElement("option");
        option.value = repo;
        option.textContent = repo;
        repoSelect.append(option);
      }
      if (review.repo && !repositories.includes(review.repo)) {
        const option = document.createElement("option");
        option.value = review.repo;
        option.textContent = review.repo;
        repoSelect.append(option);
      }
      repoSelect.value = review.repo ?? "";
    }
  }
  if (reviewSelect) {
    const reviews = Array.isArray(review.reviews) ? review.reviews : [];
    reviewSelect.replaceChildren();
    if (!reviews.length) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = review.reviewName || "Choose a review";
      reviewSelect.append(empty);
    } else {
      for (const item of reviews) {
        const option = document.createElement("option");
        option.value = item.id;
        option.dataset.reviewId = item.id;
        option.dataset.updatedAt = item.updatedAt;
        option.textContent = `${item.name} — ${formatReviewDate(item.updatedAt)}`;
        option.title = `${item.name} · ${item.updatedAt}`;
        reviewSelect.append(option);
      }
      if (
        review.reviewId &&
        !reviews.some((item) => item.id === review.reviewId)
      ) {
        const option = document.createElement("option");
        option.value = review.reviewId;
        option.textContent = `${review.reviewName || review.reviewId}`;
        reviewSelect.append(option);
      }
      reviewSelect.value = review.reviewId ?? "";
    }
  }
}

function buildToolbar(): void {
  toolbar.replaceChildren();
  toolbar.setAttribute("aria-label", "Sapling review controls");

  const managementRow = document.createElement("div");
  managementRow.className = "review-toolbar-row review-management-row";
  managementRow.setAttribute("role", "group");
  managementRow.setAttribute("aria-label", "Repository and review management");
  const actionRow = document.createElement("div");
  actionRow.className = "review-toolbar-row review-actions-row";
  actionRow.setAttribute("role", "group");
  actionRow.setAttribute("aria-label", "Current review actions");
  toolbar.append(managementRow, actionRow);

  const title = document.createElement("span");
  title.className = "review-title";
  title.textContent = "Sapling Review";
  managementRow.append(title);

  const repoLabel = document.createElement("label");
  repoLabel.className = "review-control-label";
  repoLabel.htmlFor = "review-repo";
  repoLabel.textContent = "Repository";
  managementRow.append(repoLabel);
  repoSelect = document.createElement("select");
  repoSelect.id = "review-repo";
  repoSelect.className = "review-repo-select";
  repoSelect.setAttribute("aria-label", "Repository");
  repoSelect.addEventListener("change", () => {
    if (!repoSelect?.value) return;
    send({ type: "selectRepo", repo: repoSelect.value });
    showInfo(`Loading reviews for ${repoSelect.value}…`);
  });
  managementRow.append(repoSelect);

  const reviewLabel = document.createElement("label");
  reviewLabel.className = "review-control-label";
  reviewLabel.htmlFor = "review-review";
  reviewLabel.textContent = "Review";
  managementRow.append(reviewLabel);
  reviewSelect = document.createElement("select");
  reviewSelect.id = "review-review";
  reviewSelect.className = "review-review-select";
  reviewSelect.setAttribute("aria-label", "Review");
  reviewSelect.addEventListener("change", () => {
    if (!reviewSelect?.value) return;
    send({ type: "selectReview", id: reviewSelect.value });
    showInfo("Loading review…");
  });
  managementRow.append(reviewSelect);

  managementRow.append(
    makeButton("New review", () => send({ type: "newReview" })),
    makeButton("Rename review", () => send({ type: "renameReview" })),
    makeButton("Manage reviews…", () => openReviewManager()),
  );

  const presetLabel = document.createElement("label");
  presetLabel.className = "review-control-label";
  presetLabel.htmlFor = "review-preset";
  presetLabel.textContent = "Diff";
  actionRow.append(presetLabel);

  const preset = document.createElement("select");
  preset.id = "review-preset";
  preset.setAttribute("aria-label", "Diff preset");
  for (const [value, label] of [
    ["uncommitted", "Uncommitted"],
    ["head", "Head"],
    ["stack", "Stack"],
    ["custom", "Custom command"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    preset.append(option);
  }
  actionRow.append(preset);
  preset.addEventListener("change", () => {
    if (preset.value !== "custom") {
      customCommandInput!.value = PRESET_ARGUMENTS[preset.value] ?? "";
      toolbar
        .querySelector<HTMLButtonElement>(".review-refresh-button")
        ?.click();
    }
    updateCommandControls();
  });

  customCommandInput = document.createElement("input");
  customCommandInput.type = "text";
  customCommandInput.className = "review-command-input";
  customCommandInput.placeholder = "--rev . --include src/app.ts";
  customCommandInput.setAttribute("aria-label", "Arguments passed to sl diff");
  customCommandInput.spellcheck = false;
  customCommandInput.value = review.customCommand ?? "";
  const selectCustomCommand = () => {
    if (preset.value !== "custom") {
      preset.value = "custom";
      updateCommandControls();
    }
  };
  customCommandInput.addEventListener("focus", selectCustomCommand);
  customCommandInput.addEventListener("click", selectCustomCommand);
  customCommandInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter")
      toolbar
        .querySelector<HTMLButtonElement>(".review-refresh-button")
        ?.click();
  });
  customCommandInput.addEventListener("input", () => {
    preset.value = "custom";
    updateCommandControls();
  });
  actionRow.append(customCommandInput);

  const refreshButton = makeButton(
    "Refresh",
    () => {
      const choice =
        toolbar.querySelector<HTMLSelectElement>("#review-preset")?.value ??
        "uncommitted";
      const command = customCommandInput?.value.trim() ?? "";
      send({ type: "refresh", choice, command });
      showInfo(
        review.repo
          ? "Refreshing diff…"
          : "Choosing a Sapling repository and diff…",
      );
    },
    "review-refresh-button",
  );
  setButtonIcon(refreshButton, "refresh", "Refresh diff");
  actionRow.append(refreshButton);

  actionRow.append(makeButton("Export review", () => send({ type: "export" })));

  saveAllButton = makeButton(
    "Save all comments",
    () => saveAllComments(),
    "review-save-all-button",
  );
  actionRow.append(saveAllButton);

  const viewGroup = document.createElement("span");
  viewGroup.className = "review-view-toggle";
  viewGroup.setAttribute("role", "group");
  viewGroup.setAttribute("aria-label", "Diff layout");
  const inline = makeButton("Inline", () => setMode("inline"));
  const split = makeButton("Side by side", () => setMode("split"));
  inline.dataset.mode = "inline";
  split.dataset.mode = "split";
  viewGroup.append(inline, split);
  actionRow.append(viewGroup);
  updateCommandControls();
  updateReviewControls();
  updateModeButtons();
}

function updateCommandControls(): void {
  if (!customCommandInput) return;
  // Keep the command visible and editable for every preset. Focusing or
  // clicking it switches the selection to Custom command, which makes the
  // command that will run explicit before the next refresh.
  customCommandInput.disabled = false;
  customCommandInput.setAttribute("aria-hidden", "false");
}

function updatePresetFromCommand(): void {
  const preset = toolbar.querySelector<HTMLSelectElement>("#review-preset");
  if (!preset || !review.command) return;
  const matchingPreset = Object.entries(PRESET_COMMANDS).find(
    ([, command]) => command === review.command,
  )?.[0];
  preset.value = matchingPreset ?? "custom";
  if (customCommandInput) customCommandInput.value = review.customCommand ?? "";
  updateCommandControls();
}

function setMode(next: ViewMode): void {
  if (mode === next) return;
  mode = next;
  persist();
  send({ type: "viewMode", mode: next });
  renderDiff();
  updateModeButtons();
}

function updateModeButtons(): void {
  toolbar
    .querySelectorAll<HTMLButtonElement>("[data-mode]")
    .forEach((button) => {
      const selected = button.dataset.mode === mode;
      button.setAttribute("aria-pressed", String(selected));
      button.classList.toggle("selected", selected);
    });
}

function fileName(
  file: { oldName?: string; newName?: string } | undefined,
): string {
  const candidate =
    file?.newName && file.newName !== "/dev/null"
      ? file.newName
      : file?.oldName;
  if (!candidate || candidate === "/dev/null") return "unknown file";
  // Diff2Html normally removes a/ and b/ itself. Keep this normalization for
  // hand-written patches and avoid ever treating a path as HTML.
  return candidate;
}

function sideFileName(
  file: { oldName?: string; newName?: string } | undefined,
  side: DiffSide,
): string {
  const candidate = side === "old" ? file?.oldName : file?.newName;
  if (candidate && candidate !== "/dev/null") return candidate;
  return fileName(file);
}

function normalizeFilePath(value: string | undefined): string {
  if (!value || value === "/dev/null") return "/dev/null";
  return value
    .replace(/^a\//, "")
    .replace(/^b\//, "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "");
}

function fileIdentity(file: { oldName?: string; newName?: string }): string {
  const oldName = normalizeFilePath(file.oldName);
  const newName = normalizeFilePath(file.newName);
  return `${oldName}→${newName}`;
}

function fileKey(file: { oldName?: string; newName?: string }): string {
  return `file:${fileIdentity(file)}`;
}

function fileDisplayName(
  file: { oldName?: string; newName?: string } | undefined,
): string {
  const oldName = normalizeFilePath(file?.oldName);
  const newName = normalizeFilePath(file?.newName);
  if (oldName !== "/dev/null" && newName !== "/dev/null" && oldName !== newName)
    return `${oldName} → ${newName}`;
  return fileName(file);
}

interface HunkRange {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

interface ContextRun {
  rows: HTMLTableRowElement[];
  previousChange?: HTMLTableRowElement[];
  nextChange?: HTMLTableRowElement[];
}

interface AlignedContextRun {
  rowsByTable: Array<Array<HTMLTableRowElement | undefined>>;
  previousChange: boolean;
  nextChange: boolean;
}

interface ContextBounds {
  oldStart?: number;
  oldEnd?: number;
  newStart?: number;
  newEnd?: number;
}

const contextExpansionIconPath =
  "M11.854 10.146C12.049 10.341 12.049 10.658 11.854 10.853L8.35401 14.353C8.15901 14.548 7.84201 14.548 7.64701 14.353L4.14701 10.853C3.95201 10.658 3.95201 10.341 4.14701 10.146C4.34201 9.95098 4.65901 9.95098 4.85401 10.146L8.00001 13.293L11.146 10.146C11.341 9.95098 11.658 9.95098 11.853 10.146H11.854ZM4.85401 5.85398L8.00001 2.70798L11.146 5.85398C11.341 6.04898 11.658 6.04898 11.853 5.85398C12.048 5.65898 12.048 5.34198 11.853 5.14698L8.35301 1.64698C8.15801 1.45198 7.84101 1.45198 7.64601 1.64698L4.14601 5.14698C3.95101 5.34198 3.95101 5.65898 4.14601 5.85398C4.34101 6.04898 4.65901 6.04898 4.85401 5.85398Z";

function contextBlockKey(
  file: string,
  direction: ContextExpansionDirection,
  ordinal: number,
  bounds?: ContextBounds,
): string {
  if (bounds) {
    const values = [
      bounds.oldStart,
      bounds.oldEnd,
      bounds.newStart,
      bounds.newEnd,
    ];
    if (values.some((value) => value !== undefined))
      return `${file}:${direction}:${bounds.oldStart ?? "_"}-${bounds.oldEnd ?? "_"}:${bounds.newStart ?? "_"}-${bounds.newEnd ?? "_"}`;
  }
  return `${file}:${direction}:${ordinal}`;
}

function contextRegionKey(
  file: string,
  direction: ContextExpansionDirection,
): string {
  return `${file}:${direction}`;
}

function contextExpansionAvailable(): boolean {
  return (
    review.canExpandContext ??
    (review.command === PRESET_COMMANDS.uncommitted ||
      review.command === PRESET_COMMANDS.head ||
      review.command === PRESET_COMMANDS.stack)
  );
}

function parseHunkRange(row: HTMLTableRowElement): HunkRange | undefined {
  const text = row.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const match = text.match(
    /^@@+\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/,
  );
  if (!match) return undefined;
  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
  };
}

function hunkRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return [...table.querySelectorAll<HTMLTableRowElement>("tr")].filter(
    (row) => row.querySelector("td.d2h-info") && !lineRows(table).includes(row),
  );
}

function lineRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return [...table.querySelectorAll<HTMLTableRowElement>("tbody > tr")].filter(
    (row) =>
      !!row.querySelector(".d2h-code-linenumber, .d2h-code-side-linenumber") &&
      !!row.querySelector(".d2h-code-line, .d2h-code-side-line") &&
      !row.querySelector(".d2h-info") &&
      !row.classList.contains("review-context-expansion-row"),
  );
}

function contextBounds(
  rows: HTMLTableRowElement[],
  sideHint?: "old" | "new",
): ContextBounds | undefined {
  const old: number[] = [];
  const next: number[] = [];
  for (const row of rows) {
    const numbers = row.querySelector<HTMLElement>(
      ".d2h-code-linenumber, .d2h-code-side-linenumber",
    );
    const oldLine = parseLine(
      numbers?.querySelector(".line-num1")?.textContent,
    );
    const newLine = parseLine(
      numbers?.querySelector(".line-num2")?.textContent,
    );
    if (oldLine !== undefined) old.push(oldLine);
    if (newLine !== undefined) next.push(newLine);
    if (oldLine === undefined && newLine === undefined) {
      const line = parseLine(numbers?.textContent);
      if (line !== undefined) {
        if (sideHint === "old") old.push(line);
        else next.push(line);
      }
    }
  }
  if (!old.length && !next.length) return undefined;
  return {
    ...(old.length
      ? { oldStart: Math.min(...old), oldEnd: Math.max(...old) }
      : {}),
    ...(next.length
      ? { newStart: Math.min(...next), newEnd: Math.max(...next) }
      : {}),
  };
}

function combineContextBounds(
  left: ContextBounds | undefined,
  right: ContextBounds | undefined,
): ContextBounds | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    ...(left.oldStart !== undefined || right.oldStart !== undefined
      ? {
          oldStart: Math.min(
            left.oldStart ?? Number.POSITIVE_INFINITY,
            right.oldStart ?? Number.POSITIVE_INFINITY,
          ),
          oldEnd: Math.max(left.oldEnd ?? 0, right.oldEnd ?? 0),
        }
      : {}),
    ...(left.newStart !== undefined || right.newStart !== undefined
      ? {
          newStart: Math.min(
            left.newStart ?? Number.POSITIVE_INFINITY,
            right.newStart ?? Number.POSITIVE_INFINITY,
          ),
          newEnd: Math.max(left.newEnd ?? 0, right.newEnd ?? 0),
        }
      : {}),
  };
}

function expandedContextCovers(
  file: string,
  direction: ContextExpansionDirection,
  bounds: ContextBounds | undefined,
): boolean {
  if (!bounds) return false;
  const covers = (range: ContextBounds): boolean =>
    (bounds.oldStart === undefined ||
      (range.oldStart !== undefined &&
        range.oldEnd !== undefined &&
        bounds.oldEnd !== undefined &&
        range.oldStart <= bounds.oldStart &&
        range.oldEnd >= bounds.oldEnd)) &&
    (bounds.newStart === undefined ||
      (range.newStart !== undefined &&
        range.newEnd !== undefined &&
        bounds.newEnd !== undefined &&
        range.newStart <= bounds.newStart &&
        range.newEnd >= bounds.newEnd));
  if (
    (review.expandedRanges ?? []).some(
      (range) =>
        range.file === file && range.direction === direction && covers(range),
    )
  )
    return true;
  const prefix = `${file}:${direction}:`;
  return [...expandedContextBlocks].some((id) => {
    if (!id.startsWith(prefix)) return false;
    const match = id
      .slice(prefix.length)
      .match(/^(\d+|_)-(\d+|_):(\d+|_)-(\d+|_)$/);
    if (!match) return false;
    return covers({
      ...(match[1] !== "_" ? { oldStart: Number(match[1]) } : {}),
      ...(match[2] !== "_" ? { oldEnd: Number(match[2]) } : {}),
      ...(match[3] !== "_" ? { newStart: Number(match[3]) } : {}),
      ...(match[4] !== "_" ? { newEnd: Number(match[4]) } : {}),
    });
  });
}

function isChangedRow(row: HTMLTableRowElement): boolean {
  return (
    row.matches(".d2h-change, .d2h-del, .d2h-ins") ||
    !!row.querySelector(".d2h-change, .d2h-del, .d2h-ins")
  );
}

function contextRuns(table: HTMLTableElement): ContextRun[] {
  const rows = lineRows(table);
  const runs: ContextRun[] = [];
  let current: ContextRun | undefined;
  let previousChange: HTMLTableRowElement[] | undefined;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (isChangedRow(row)) {
      if (current) {
        const changeRows = [row];
        while (index + 1 < rows.length && isChangedRow(rows[index + 1]))
          changeRows.push(rows[++index]);
        current.nextChange = changeRows;
        runs.push(current);
        current = undefined;
        previousChange = changeRows;
        continue;
      }
      const changeRows = [row];
      while (index + 1 < rows.length && isChangedRow(rows[index + 1]))
        changeRows.push(rows[++index]);
      previousChange = changeRows;
      continue;
    }
    if (!current) current = { rows: [], previousChange };
    current.rows.push(row);
  }
  if (current) runs.push(current);
  return runs;
}

function alignedContextRuns(tables: HTMLTableElement[]): AlignedContextRun[] {
  const rowsByTable = tables.map(lineRows);
  const runs: AlignedContextRun[] = [];
  const rowCount = Math.max(...rowsByTable.map((rows) => rows.length), 0);
  let current: AlignedContextRun | undefined;
  let previousChange = false;
  for (let index = 0; index < rowCount; index += 1) {
    const changed = rowsByTable.some((rows) => {
      const row = rows[index];
      return row !== undefined && isChangedRow(row);
    });
    if (changed) {
      if (current) {
        current.nextChange = true;
        runs.push(current);
        current = undefined;
      }
      previousChange = true;
      continue;
    }
    if (!current) {
      current = {
        rowsByTable: rowsByTable.map(() => []),
        previousChange,
        nextChange: false,
      };
    }
    rowsByTable.forEach((rows, tableIndex) => {
      current!.rowsByTable[tableIndex].push(rows[index]);
    });
  }
  if (current) runs.push(current);
  return runs;
}

type ContextExpansionEdge = "up" | "down";

interface ContextExpansionAction {
  file: string;
  direction: ContextExpansionDirection;
  edge: ContextExpansionEdge;
  id: string;
  needsHost: boolean;
  hiddenLines?: number;
  bounds?: ContextBounds;
}

function contextActionId(
  id: string,
  direction: ContextExpansionDirection,
  edge: ContextExpansionEdge,
): string {
  // Preserve the identifiers used by older snapshots for the one-sided
  // controls. Middle gaps need one identifier per edge so either side can be
  // loaded and persisted independently.
  return direction === "between" ? `${id}:${edge}` : id;
}

function contextActionExpanded(action: ContextExpansionAction): boolean {
  return (
    expandedContextBlocks.has(action.id) ||
    expandedContextBlocks.has(
      contextActionId(action.id, action.direction, action.edge),
    )
  );
}

function contextHeaderText(row: HTMLTableRowElement): string {
  const content = row.querySelector<HTMLElement>(
    ".d2h-code-line, .d2h-code-side-line",
  );
  return (content?.textContent ?? row.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contextHeaderBefore(
  table: HTMLTableElement,
  row: HTMLTableRowElement,
): string {
  let header = "";
  for (const candidate of hunkRows(table)) {
    if (
      candidate === row ||
      !!(
        candidate.compareDocumentPosition(row) &
        Node.DOCUMENT_POSITION_FOLLOWING
      )
    )
      header = contextHeaderText(candidate);
  }
  return header;
}

function contextIcon(edge: ContextExpansionEdge): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 16 16",
    width: "16",
    height: "16",
    fill: "currentColor",
    "aria-hidden": "true",
    focusable: "false",
  }))
    svg.setAttribute(key, value);
  svg.classList.add("codicon", "review-context-expansion-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    edge === "up"
      ? "M8 1.25 2.75 6.5l1.06 1.06L7.25 4.18v8.57h1.5V4.18l3.44 3.38L13.25 6.5 8 1.25Z"
      : "m8 14.75 5.25-5.25-1.06-1.06-3.44 3.38V3.25h-1.5v8.57L4.31 8.44 3.25 9.5 8 14.75Z",
  );
  svg.append(path);
  return svg;
}

function contextExpansionButton(
  action: ContextExpansionAction,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "review-context-expansion-button";
  button.dataset.reviewContextDirection = action.direction;
  button.dataset.reviewContextEdge = action.edge;
  button.dataset.reviewContextExpansionEdge = action.edge;
  button.dataset.reviewContextFile = action.file;
  button.dataset.reviewContextId = action.id;
  const actionId = contextActionId(action.id, action.direction, action.edge);
  button.dataset.reviewContextActionId = actionId;
  button.dataset.reviewContextLogicalId = action.id;
  if (action.needsHost) button.dataset.reviewContextNeedsHost = "true";
  if (action.hiddenLines !== undefined && action.hiddenLines > 0)
    button.dataset.reviewContextHiddenLines = String(action.hiddenLines);
  for (const [name, value] of Object.entries(action.bounds ?? {})) {
    if (value !== undefined)
      button.dataset[`reviewContext${name[0]!.toUpperCase()}${name.slice(1)}`] =
        String(value);
  }
  const directionWord = action.edge === "up" ? "earlier" : "later";
  const location =
    action.direction === "between" ? " between hunks" : " in this file";
  const count =
    action.hiddenLines !== undefined && action.hiddenLines > 0
      ? Math.min(action.hiddenLines, CONTEXT_EXPANSION_LINES)
      : CONTEXT_EXPANSION_LINES;
  const accessibleLabel = `Show ${count} ${directionWord} context line${count === 1 ? "" : "s"}${location}`;
  button.setAttribute("aria-label", accessibleLabel);
  button.title = accessibleLabel;
  const label = document.createElement("span");
  label.className = "review-context-expansion-label";
  label.textContent = accessibleLabel;
  button.append(contextIcon(action.edge), label);
  button.addEventListener("click", () =>
    requestContextExpansion(
      action.file,
      action.direction,
      actionId,
      action.needsHost,
    ),
  );
  return button;
}

function expansionCells(
  reference: HTMLTableRowElement,
  header: string,
): { gutter: HTMLTableCellElement; code: HTMLTableCellElement } {
  const sourceGutter = reference.cells[0];
  const sourceCode = reference.cells[1];
  const gutter = document.createElement("td");
  gutter.className = `${sourceGutter?.className ?? "d2h-code-linenumber d2h-info"} review-context-expansion-gutter`;
  gutter.replaceChildren();
  const code = document.createElement("td");
  code.className = `${sourceCode?.className ?? "d2h-info"} review-context-expansion-code`;
  const codeLine = document.createElement("div");
  codeLine.className =
    sourceCode?.querySelector<HTMLElement>(
      ".d2h-code-line, .d2h-code-side-line",
    )?.className ?? "d2h-code-line";
  codeLine.textContent = header || "@@";
  code.append(codeLine);
  return { gutter, code };
}

function addContextExpansionRow(
  reference: HTMLTableRowElement,
  position: "before" | "after",
  actions: ContextExpansionAction[],
  header: string,
): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.className = "review-context-expansion-row";
  row.dataset.reviewContextSeparator = "true";
  const { gutter, code } = expansionCells(reference, header);
  for (const action of actions) gutter.append(contextExpansionButton(action));
  const error = actions
    .map(
      (action) =>
        contextExpansionErrors.get(action.id) ??
        contextExpansionErrors.get(
          contextActionId(action.id, action.direction, action.edge),
        ),
    )
    .find((message): message is string => !!message);
  if (error) {
    const errorMessage = document.createElement("span");
    errorMessage.className = "review-context-expansion-error";
    errorMessage.setAttribute("role", "alert");
    errorMessage.textContent = error;
    code.append(errorMessage);
  }
  row.append(gutter, code);
  if (position === "before") reference.before(row);
  else reference.after(row);
  return row;
}

function decorateHunkRow(
  row: HTMLTableRowElement,
  actions: ContextExpansionAction[],
  header: string,
): void {
  const { gutter, code } = expansionCells(row, header);
  // Keep the marker row in the table. It is the separator and carries the
  // actual @@ header in the content column, so controls never stack beside a
  // second hidden marker.
  row.classList.add("review-context-expansion-row");
  row.dataset.reviewContextSeparator = "true";
  row.replaceChildren(gutter, code);
  for (const action of actions) gutter.append(contextExpansionButton(action));
  const error = actions
    .map(
      (action) =>
        contextExpansionErrors.get(action.id) ??
        contextExpansionErrors.get(
          contextActionId(action.id, action.direction, action.edge),
        ),
    )
    .find((message): message is string => !!message);
  if (error) {
    const errorMessage = document.createElement("span");
    errorMessage.className = "review-context-expansion-error";
    errorMessage.setAttribute("role", "alert");
    errorMessage.textContent = error;
    code.append(errorMessage);
  }
}

function requestContextExpansion(
  file: string,
  direction: ContextExpansionDirection,
  id: string,
  needsHost = false,
): void {
  if (!contextExpansionAvailable()) return;
  contextExpansionErrors.delete(id);
  if (needsHost) {
    pendingContextExpansion = { id };
    showInfo("Loading more unchanged lines…");
    const button = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".review-context-expansion-button",
      ),
    ].find(
      (candidate) =>
        candidate.dataset.reviewContextActionId === id ||
        candidate.dataset.reviewContextId === id,
    );
    const number = (name: string): number | undefined => {
      const value = Number(button?.dataset[name]);
      return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
    };
    send({
      type: "expandContext",
      file,
      direction,
      regionId: id,
      ...(number("reviewContextOldStart") !== undefined
        ? { oldStart: number("reviewContextOldStart") }
        : {}),
      ...(number("reviewContextOldEnd") !== undefined
        ? { oldEnd: number("reviewContextOldEnd") }
        : {}),
      ...(number("reviewContextNewStart") !== undefined
        ? { newStart: number("reviewContextNewStart") }
        : {}),
      ...(number("reviewContextNewEnd") !== undefined
        ? { newEnd: number("reviewContextNewEnd") }
        : {}),
    });
    return;
  }
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>(
      ".review-context-expansion-button",
    ),
  ].find(
    (candidate) =>
      candidate.dataset.reviewContextActionId === id ||
      candidate.dataset.reviewContextId === id,
  );
  if (button) {
    const logicalId = button.dataset.reviewContextLogicalId ?? id;
    const edge = button.dataset.reviewContextEdge as
      ContextExpansionEdge | undefined;
    if (edge === "up" || edge === "down") {
      const progress = localExpansionProgress.get(logicalId) ?? {
        up: 0,
        down: 0,
      };
      const hidden = Number(button.dataset.reviewContextHiddenLines);
      progress[edge] += Math.min(
        CONTEXT_EXPANSION_LINES,
        Number.isSafeInteger(hidden) && hidden > 0
          ? hidden
          : CONTEXT_EXPANSION_LINES,
      );
      localExpansionProgress.set(logicalId, progress);
    }
  }
  expandedContextBlocks.add(id);
  renderDiff();
}

function decorateContextExpansion(
  wrapper: HTMLElement,
  file: string,
  tables: HTMLTableElement[],
  parsedFile: ReturnType<typeof parse>[number] | undefined,
): void {
  if (!contextExpansionAvailable() || !tables.length) return;
  const actionIsAvailable = (action: ContextExpansionAction): boolean =>
    (!action.needsHost || !contextActionExpanded(action)) &&
    !(
      action.needsHost &&
      exhaustedContextRegions.has(
        contextRegionKey(action.file, action.direction),
      )
    ) &&
    !expandedContextCovers(action.file, action.direction, action.bounds);
  const addActions = (
    reference: HTMLTableRowElement,
    position: "before" | "after",
    actions: ContextExpansionAction[],
    header: string,
  ) => {
    const available = actions.filter(actionIsAvailable);
    if (!available.length) return;
    addContextExpansionRow(reference, position, available, header);
  };

  const hasCommentInRows = (rows: HTMLTableRowElement[]): boolean => {
    const lineNumbers = rows.flatMap((row) => {
      const numberCell = row.querySelector<HTMLElement>(
        ".d2h-code-linenumber, .d2h-code-side-linenumber",
      );
      return [
        parseLine(numberCell?.querySelector(".line-num1")?.textContent),
        parseLine(numberCell?.querySelector(".line-num2")?.textContent),
        parseLine(numberCell?.textContent),
      ].filter((value): value is number => value !== undefined);
    });
    if (!lineNumbers.length) return false;
    const min = Math.min(...lineNumbers);
    const max = Math.max(...lineNumbers);
    return (review.comments ?? []).some(
      (comment) =>
        comment.status !== "outdated" &&
        comment.anchor.file === file &&
        comment.anchor.start <= max &&
        comment.anchor.end >= min,
    );
  };

  const actionFor = (
    direction: ContextExpansionDirection,
    edge: ContextExpansionEdge,
    id: string,
    bounds: ContextBounds | undefined,
    needsHost: boolean,
    hiddenLines?: number,
  ): ContextExpansionAction => ({
    file,
    direction,
    edge,
    id,
    needsHost,
    hiddenLines,
    bounds,
  });

  let localTailCollapsed = false;
  const collapseRun = (
    runIndex: number,
    rowsByTable: Array<Array<HTMLTableRowElement | undefined>>,
    previousChange: boolean,
    nextChange: boolean,
  ) => {
    const allRows = rowsByTable.flatMap((rows) =>
      rows.filter((row): row is HTMLTableRowElement => row !== undefined),
    );
    if (!allRows.length) return;
    const runLength = Math.max(...rowsByTable.map((rows) => rows.length), 0);
    const keepBefore = previousChange ? DEFAULT_CONTEXT_LINES : 0;
    const keepAfter = nextChange ? DEFAULT_CONTEXT_LINES : 0;
    const hiddenStart = keepBefore;
    const hiddenEnd = runLength - keepAfter;
    if (
      hiddenStart >= hiddenEnd ||
      hasCommentInRows(allRows) ||
      hiddenEnd - hiddenStart <= 0
    )
      return;
    const direction: ContextExpansionDirection = previousChange
      ? nextChange
        ? "between"
        : "below"
      : "above";
    // A source-backed gap owns a separator at its hunk marker. Leave the
    // leading context visible in that case so it cannot produce two controls
    // for the same gap. Local trailing context still collapses and becomes
    // the next visible edge of the file.
    if (!previousChange && !(review.expandedRanges?.length ?? 0)) {
      const firstHunk = hunkRows(tables[0])[0];
      const firstRange = firstHunk ? parseHunkRange(firstHunk) : undefined;
      if (firstRange && (firstRange.oldStart > 1 || firstRange.newStart > 1))
        return;
    }
    const logicalId = contextBlockKey(file, direction, runIndex);
    const progress = localExpansionProgress.get(logicalId) ?? {
      up: 0,
      down: 0,
    };
    const revealUp = Math.min(progress.up, hiddenEnd - hiddenStart);
    const revealDown = Math.min(
      progress.down,
      Math.max(0, hiddenEnd - hiddenStart - revealUp),
    );
    // The up action reveals the rows nearest the lower hunk; the down action
    // reveals the rows nearest the upper hunk. Keep the other edge collapsed.
    const remainingStart = hiddenStart + revealDown;
    const remainingEnd = hiddenEnd - revealUp;
    if (remainingStart >= remainingEnd) return;
    const hiddenRows = rowsByTable.flatMap((rows) =>
      rows
        .slice(remainingStart, remainingEnd)
        .filter((row): row is HTMLTableRowElement => row !== undefined),
    );
    if (!hiddenRows.length) return;
    const bounds = rowsByTable.reduce<ContextBounds | undefined>(
      (current, rows, tableIndex) =>
        combineContextBounds(
          current,
          contextBounds(
            rows
              .slice(remainingStart, remainingEnd)
              .filter((row): row is HTMLTableRowElement => row !== undefined),
            tables.length > 1 ? (tableIndex === 0 ? "old" : "new") : undefined,
          ),
        ),
      undefined,
    );
    const edges: ContextExpansionEdge[] =
      direction === "between"
        ? ["up", "down"]
        : [direction === "above" ? "up" : "down"];
    const actions = edges.map((edge) =>
      actionFor(
        direction,
        edge,
        logicalId,
        bounds,
        false,
        remainingEnd - remainingStart,
      ),
    );
    for (const rows of rowsByTable) {
      for (const row of rows.slice(remainingStart, remainingEnd))
        if (row) row.hidden = true;
    }
    if (direction === "below") localTailCollapsed = true;
    rowsByTable.forEach((rows, tableIndex) => {
      const table = tables[tableIndex];
      const reference =
        rows[remainingEnd] ?? rows[remainingStart - 1] ?? rows.at(-1);
      if (!reference) return;
      const header = contextHeaderBefore(table, reference);
      addActions(
        reference,
        rows[remainingEnd] ? "before" : "after",
        actions,
        header,
      );
    });
  };

  // Source-backed expansions already return bounded synthetic hunks. Keeping
  // their rows visible lets the rendered hunk ranges describe every remaining
  // gap, including when the user alternates between its two edges.
  if (!(review.expandedRanges?.length ?? 0)) {
    if (tables.length > 1) {
      for (const [runIndex, run] of alignedContextRuns(tables).entries())
        collapseRun(
          runIndex,
          run.rowsByTable,
          run.previousChange,
          run.nextChange,
        );
    } else {
      for (const [runIndex, run] of contextRuns(tables[0]).entries())
        collapseRun(
          runIndex,
          [run.rows],
          !!run.previousChange,
          !!run.nextChange,
        );
    }
  }

  // Capture marker rows before replacing any of them with separator content.
  // In split mode both panes must receive the same logical action, even while
  // the first pane is being decorated.
  const hunkRowsByTable = tables.map(hunkRows);
  const primaryHunks = hunkRowsByTable[0] ?? [];
  const ranges = primaryHunks.map(parseHunkRange);
  if (ranges.some((range) => !range) || !ranges.length) return;
  const headers = primaryHunks.map(contextHeaderText);
  const hasChanged =
    parsedFile?.blocks.some((block) =>
      block.lines.some((line) => line.type !== "context"),
    ) ?? tables.some((table) => lineRows(table).some(isChangedRow));
  if (!hasChanged) return;
  const rangeEnd = (start: number, count: number): number => start + count;
  const gap = (
    previous: HunkRange | undefined,
    current: HunkRange,
  ): ContextBounds | undefined => {
    const oldStart = previous
      ? rangeEnd(previous.oldStart, previous.oldCount)
      : 1;
    const newStart = previous
      ? rangeEnd(previous.newStart, previous.newCount)
      : 1;
    const oldEnd = current.oldStart - 1;
    const newEnd = current.newStart - 1;
    if (oldEnd < oldStart && newEnd < newStart) return undefined;
    return {
      ...(oldEnd >= oldStart ? { oldStart, oldEnd } : {}),
      ...(newEnd >= newStart ? { newStart, newEnd } : {}),
    };
  };
  const edgeBounds = (
    bounds: ContextBounds,
    edge: ContextExpansionEdge,
  ): ContextBounds => {
    const slice = (start: number | undefined, end: number | undefined) => {
      if (start === undefined || end === undefined || end < start) return {};
      return edge === "up"
        ? {
            start: Math.max(start, end - CONTEXT_EXPANSION_LINES + 1),
            end,
          }
        : {
            start,
            end: Math.min(end, start + CONTEXT_EXPANSION_LINES - 1),
          };
    };
    const old = slice(bounds.oldStart, bounds.oldEnd);
    const next = slice(bounds.newStart, bounds.newEnd);
    return {
      ...(old.start !== undefined
        ? { oldStart: old.start, oldEnd: old.end }
        : {}),
      ...(next.start !== undefined
        ? { newStart: next.start, newEnd: next.end }
        : {}),
    };
  };
  const addHunkActions = (index: number, actions: ContextExpansionAction[]) => {
    for (const [tableIndex] of tables.entries()) {
      const row = hunkRowsByTable[tableIndex]?.[index];
      if (!row) continue;
      decorateHunkRow(
        row,
        actions.filter(actionIsAvailable),
        headers[index] ?? contextHeaderText(row),
      );
    }
  };

  const firstGap = gap(undefined, ranges[0]!);
  if (firstGap) {
    const bounds = edgeBounds(firstGap, "up");
    const baseId = contextBlockKey(file, "above", 0, bounds);
    addHunkActions(0, [
      actionFor(
        "above",
        "up",
        baseId,
        bounds,
        true,
        Math.max(
          firstGap.oldEnd !== undefined
            ? firstGap.oldEnd - firstGap.oldStart! + 1
            : 0,
          firstGap.newEnd !== undefined
            ? firstGap.newEnd - firstGap.newStart! + 1
            : 0,
        ),
      ),
    ]);
  }
  for (let index = 1; index < ranges.length; index += 1) {
    const bounds = gap(ranges[index - 1], ranges[index]!);
    if (!bounds) continue;
    const baseId = contextBlockKey(file, "between", index, bounds);
    const hiddenLines = Math.max(
      bounds.oldEnd !== undefined ? bounds.oldEnd - bounds.oldStart! + 1 : 0,
      bounds.newEnd !== undefined ? bounds.newEnd - bounds.newStart! + 1 : 0,
    );
    addHunkActions(
      index,
      (["up", "down"] as ContextExpansionEdge[]).map((edge) =>
        actionFor(
          "between",
          edge,
          baseId,
          edgeBounds(bounds, edge),
          true,
          hiddenLines,
        ),
      ),
    );
  }

  if (!localTailCollapsed) {
    const last = ranges.at(-1)!;
    const oldStart = rangeEnd(last.oldStart, last.oldCount);
    const newStart = rangeEnd(last.newStart, last.newCount);
    const bounds: ContextBounds = {
      oldStart,
      oldEnd: oldStart + CONTEXT_EXPANSION_LINES - 1,
      newStart,
      newEnd: newStart + CONTEXT_EXPANSION_LINES - 1,
    };
    const baseId = contextBlockKey(file, "below", ranges.length, bounds);
    const actions = [actionFor("below", "down", baseId, bounds, true)];
    for (const table of tables) {
      const rows = lineRows(table);
      const target =
        rows.at(-1) ?? hunkRowsByTable[tables.indexOf(table)]?.at(-1);
      if (target) addActions(target, "after", actions, headers.at(-1) ?? "@@");
    }
  }
}

function reviewScope(
  repo = review.repo,
  reviewId?: string,
  command = review.command,
): string {
  // Named reviews are stable across command edits. Legacy states have no id,
  // so continue to use the command as their identity for old webview state.
  return `${repo ?? ""}|${reviewId || command || ""}`;
}

function currentReviewScope(): string | undefined {
  return review.repo || review.reviewId || review.command
    ? reviewScope(review.repo, review.reviewId, review.command)
    : restoredReviewScope;
}

function migrateLegacyDrafts(oldScope: string, nextScope: string): void {
  if (oldScope === nextScope) return;
  const migrateKey = (key: string): string =>
    key.startsWith(`new:${oldScope}:`)
      ? `new:${nextScope}:${key.slice(`new:${oldScope}:`.length)}`
      : key;
  for (const oldKey of Object.keys(drafts)) {
    const nextKey = migrateKey(oldKey);
    if (nextKey === oldKey) continue;
    drafts[nextKey] = drafts[oldKey];
    delete drafts[oldKey];
    if (draftAnchors[oldKey]) {
      draftAnchors[nextKey] = draftAnchors[oldKey];
      delete draftAnchors[oldKey];
    }
    if (draftScopes[oldKey]) {
      draftScopes[nextKey] = nextScope;
      delete draftScopes[oldKey];
    }
  }
  for (const key of Object.keys(draftScopes)) {
    if (draftScopes[key] === oldScope) draftScopes[key] = nextScope;
  }
  for (const [oldKey, operation] of pending) {
    const nextKey = migrateKey(oldKey);
    if (nextKey === oldKey) {
      if (operation.scope === oldScope) operation.scope = nextScope;
      continue;
    }
    pending.delete(oldKey);
    pending.set(nextKey, { ...operation, key: nextKey, scope: nextScope });
    if (restoredPendingKeys.delete(oldKey)) restoredPendingKeys.add(nextKey);
  }
  if (activeComposerKey) activeComposerKey = migrateKey(activeComposerKey);
}

function scopeForDraft(key: string): string | undefined {
  if (draftScopes[key]) return draftScopes[key];
  const scope = currentReviewScope();
  if (!scope) return undefined;
  if (key.startsWith(`new:${scope}:`)) return scope;
  if (legacyDraftsForeign) return undefined;
  if (
    key.startsWith("comment:") &&
    review.comments?.some((comment) => `comment:${comment.id}` === key)
  )
    return scope;
  return undefined;
}

function rememberDraft(
  key: string,
  body: string,
  anchor: ReviewAnchor | undefined,
  scope = currentReviewScope(),
): void {
  drafts[key] = body;
  if (anchor) draftAnchors[key] = anchor;
  if (scope) draftScopes[key] = scope;
}

interface TocDirectory {
  directories: Map<string, TocDirectory>;
  files: Array<{ name: string; wrapper: HTMLElement; index: number }>;
}

function appendTocDirectory(
  list: HTMLOListElement,
  directory: TocDirectory,
): void {
  for (const [name, child] of directory.directories) {
    const item = document.createElement("li");
    const details = document.createElement("details");
    details.className = "review-toc-directory";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = name;
    details.append(summary);
    const nested = document.createElement("ol");
    nested.className = "review-toc-list";
    appendTocDirectory(nested, child);
    details.append(nested);
    item.append(details);
    list.append(item);
  }
  for (const file of directory.files) {
    const item = document.createElement("li");
    item.className = "review-toc-file";
    const anchor = document.createElement("a");
    anchor.href = `#${file.wrapper.id}`;
    anchor.textContent = file.name.split("/").at(-1) || file.name;
    anchor.title = file.name;
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      file.wrapper.scrollIntoView({ block: "start" });
      history.replaceState(undefined, "", `#${file.wrapper.id}`);
    });
    item.append(anchor);
    list.append(item);
  }
}

function fileBodyRowCount(file: ReturnType<typeof parse>[number]): number {
  return file.blocks.reduce((count, block) => count + block.lines.length, 0);
}

function shouldGateFile(file: ReturnType<typeof parse>[number]): boolean {
  const rows = fileBodyRowCount(file);
  // Deleted files are commonly all changed lines, so their body can be much
  // larger than a normal hunk while still looking like a small diff header.
  // Gate every oversized body and always gate a deleted body over the limit.
  return rows > MAX_INITIAL_RENDERED_FILE_ROWS;
}

/**
 * Keep the file header and metadata for a gated file while omitting its hunks
 * before Diff2Html builds any rows. The complete patch stays in `review.patch`
 * and is rendered only after the reviewer explicitly reveals that file.
 */
function patchForVisibleFiles(patch: string, gated: Set<number>): string {
  if (!gated.size) return patch;
  const sections = patch.split(/(?=^diff --git )/m);
  let fileIndex = -1;
  return sections
    .map((section) => {
      if (!/^diff --git /m.test(section)) return section;
      fileIndex += 1;
      if (!gated.has(fileIndex)) return section;
      const lines = section.split("\n");
      const hunk = lines.findIndex((line) => /^@@/.test(line));
      if (hunk < 0) return section;
      const prefix = lines.slice(0, hunk).join("\n");
      return `${prefix}\n`;
    })
    .join("");
}

function fileMatchesAnchor(
  wrapper: HTMLElement | undefined,
  file: string,
): boolean {
  if (!wrapper) return false;
  return [
    wrapper.dataset.reviewFile,
    wrapper.dataset.reviewOldFile,
    wrapper.dataset.reviewNewFile,
  ].includes(file);
}

function gatedFileLabel(file: ReturnType<typeof parse>[number]): string {
  const count = fileBodyRowCount(file);
  if (count > MAX_HARD_RENDERED_FILE_ROWS)
    return `File too large to render (${count.toLocaleString()} lines)`;
  const noun = file.isDeleted ? "deleted file" : "file";
  return `Show ${noun} (${count.toLocaleString()} lines)`;
}

function decorateGatedFile(
  wrapper: HTMLElement,
  file: ReturnType<typeof parse>[number],
  key: string,
  force = false,
): void {
  const hardLimited = fileBodyRowCount(file) > MAX_HARD_RENDERED_FILE_ROWS;
  if (
    (!force && !shouldGateFile(file) && !hardLimited) ||
    (revealedFiles.has(key) && !hardLimited)
  )
    return;
  const header = wrapper.querySelector<HTMLElement>(".d2h-file-header");
  if (!header) return;
  const controls = document.createElement("div");
  controls.className = "review-large-file-gate";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "review-large-file-button";
  button.textContent = gatedFileLabel(file);
  button.title = hardLimited
    ? "This file is too large to render in the review"
    : "Render this file's complete diff";
  button.setAttribute("aria-label", button.textContent);
  button.dataset.reviewRevealFile = key;
  if (hardLimited) button.dataset.reviewHardLimit = "true";
  button.addEventListener("click", () => {
    if (hardLimited) {
      showError(
        `${fileDisplayName(file)} has ${fileBodyRowCount(file).toLocaleString()} lines and exceeds the ${MAX_HARD_RENDERED_FILE_ROWS.toLocaleString()}-line render limit. Narrow the diff to review it here.`,
      );
      return;
    }
    revealedFiles.add(key);
    persist();
    renderDiff();
  });
  controls.append(button);
  header.after(controls);
}

function renderDiff(): void {
  diff.replaceChildren();
  const patch = review.patch ?? "";
  if (!patch.trim()) {
    const empty = document.createElement("div");
    empty.className = "review-empty-state";
    empty.textContent = review.repo
      ? "No changes in this diff."
      : "Choose a Sapling repository and diff to begin.";
    diff.append(empty);
    renderComments();
    return;
  }

  let files: ReturnType<typeof parse> = [];
  try {
    files = parse(patch);
  } catch (error) {
    showError(
      `Could not parse diff: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const toc = document.createElement("nav");
  toc.className = "review-toc";
  toc.setAttribute("aria-label", "Files changed");
  const tocHeading = document.createElement("span");
  tocHeading.className = "review-toc-heading";
  tocHeading.textContent = "Files changed";
  toc.append(tocHeading);
  const tocList = document.createElement("ol");
  tocList.className = "review-toc-list";
  toc.append(tocList);
  diff.append(toc);

  const gatedFiles = new Set<number>();
  let initialRows = 0;
  files.forEach((file, index) => {
    const rows = fileBodyRowCount(file);
    const key = fileKey(file);
    const hardLimited = rows > MAX_HARD_RENDERED_FILE_ROWS;
    const explicitlyRevealed = revealedFiles.has(key) && !hardLimited;
    if (
      hardLimited ||
      (!explicitlyRevealed &&
        (rows > MAX_INITIAL_RENDERED_FILE_ROWS ||
          initialRows + rows > MAX_INITIAL_RENDERED_FILE_ROWS))
    ) {
      gatedFiles.add(index);
      return;
    }
    initialRows += rows;
  });
  const visiblePatch = patchForVisibleFiles(patch, gatedFiles);
  let visibleFiles: ReturnType<typeof parse> = files;
  if (visiblePatch !== patch) {
    try {
      visibleFiles = parse(visiblePatch);
    } catch {
      // A malformed hand-written patch should still get Diff2Html's normal
      // error/fallback path rather than losing the complete review.
      visibleFiles = files;
    }
  }

  const output = document.createElement("div");
  output.className = "review-diff-output";
  diff.append(output);

  try {
    // Diff2HtmlUI's regular build includes the complete highlight.js language
    // registry. draw() calls highlightCode() with that registry.
    const ui = new Diff2HtmlUI(output, visiblePatch, {
      drawFileList: false,
      outputFormat: mode === "split" ? "side-by-side" : "line-by-line",
      matching: "lines",
      highlight: true,
      fileContentToggle: false,
      stickyFileHeaders: true,
    });
    ui.draw();
  } catch (error) {
    showError(
      `Could not render diff: ${error instanceof Error ? error.message : String(error)}`,
    );
    const fallback = document.createElement("pre");
    fallback.className = "review-diff-fallback";
    fallback.textContent = patch;
    output.replaceChildren(fallback);
    return;
  }

  const wrappers = [
    ...output.querySelectorAll<HTMLElement>(".d2h-file-wrapper"),
  ];
  const tocRoot: TocDirectory = { directories: new Map(), files: [] };
  wrappers.forEach((wrapper, index) => {
    const sourceFile = files[index];
    const renderedFile = visibleFiles[index];
    const name = fileName(sourceFile);
    const oldName = sideFileName(sourceFile, "old");
    const newName = sideFileName(sourceFile, "new");
    const key = sourceFile ? fileKey(sourceFile) : `file:${name}`;
    wrapper.id = `review-file-${index}`;
    wrapper.dataset.reviewFile = name;
    wrapper.dataset.reviewOldFile = oldName;
    wrapper.dataset.reviewNewFile = newName;
    wrapper.dataset.reviewFileKey = key;
    if (/\.(?:md|markdown)$/i.test(name)) {
      wrapper.classList.add("review-markdown-file");
      stripMarkdownIntralineMarkup(wrapper);
    }
    decorateFileHeader(wrapper, name, key, sourceFile);
    decorateLines(wrapper, oldName, newName);
    decorateContextExpansion(
      wrapper,
      name,
      [...wrapper.querySelectorAll<HTMLTableElement>(".d2h-diff-table")],
      renderedFile,
    );
    if (sourceFile && gatedFiles.has(index))
      decorateGatedFile(wrapper, sourceFile, key, true);

    const parts = name.split("/").filter(Boolean);
    let directory = tocRoot;
    for (const part of parts.slice(0, -1)) {
      let child = directory.directories.get(part);
      if (!child) {
        child = { directories: new Map(), files: [] };
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push({ name, wrapper, index });
  });
  appendTocDirectory(tocList, tocRoot);

  if (!wrappers.length) {
    const empty = document.createElement("div");
    empty.className = "review-empty-state";
    empty.textContent = "No files were found in this diff.";
    output.append(empty);
  }
  renderComments();
}

function stripMarkdownIntralineMarkup(wrapper: HTMLElement): void {
  // Diff2Html wraps changed words in <ins>/<del> (or .d2h-change). Unwrap
  // those markers for Markdown files so one changed line receives one visual
  // treatment while retaining any syntax-highlight spans inside the marker.
  wrapper
    .querySelectorAll<HTMLElement>(
      ".d2h-code-line-ctn del, .d2h-code-line-ctn ins, .d2h-code-line-ctn .d2h-change",
    )
    .forEach((element) => {
      const parent = element.parentNode;
      if (!parent) return;
      while (element.firstChild)
        parent.insertBefore(element.firstChild, element);
      element.remove();
    });
}

function decorateFileHeader(
  wrapper: HTMLElement,
  name: string,
  key: string,
  file: ReturnType<typeof parse>[number] | undefined,
): void {
  const header = wrapper.querySelector<HTMLElement>(".d2h-file-header");
  if (!header) return;

  for (const tag of header.querySelectorAll(".d2h-tag")) {
    if (tag.textContent?.trim() === "CHANGED") tag.remove();
  }
  if (file) {
    const stats = document.createElement("span");
    stats.className = "review-file-diffstat";
    stats.setAttribute(
      "aria-label",
      `${file.addedLines} lines added, ${file.deletedLines} lines deleted`,
    );
    stats.title = `${file.addedLines} lines added, ${file.deletedLines} lines deleted`;
    const added = document.createElement("span");
    added.className = "review-lines-added";
    added.textContent = `+${file.addedLines}`;
    const deleted = document.createElement("span");
    deleted.className = "review-lines-deleted";
    deleted.textContent = `−${file.deletedLines}`;
    stats.append(added, deleted);
    header.append(stats);
  }

  const renderedName = header.querySelector<HTMLElement>(".d2h-file-name");
  if (renderedName) {
    renderedName.textContent = fileDisplayName(file) || name;
    renderedName.title = fileDisplayName(file) || name;
  }
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "review-file-toggle";
  toggle.setAttribute("aria-controls", wrapper.id);
  toggle.addEventListener("click", () => {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    persist();
    applyCollapsed(wrapper, toggle, key);
  });
  header.prepend(toggle);
  applyCollapsed(wrapper, toggle, key);
}

function applyCollapsed(
  wrapper: HTMLElement,
  toggle: HTMLButtonElement,
  key: string,
): void {
  const isCollapsed = collapsed.has(key);
  wrapper.classList.toggle("review-collapsed", isCollapsed);
  toggle.textContent = isCollapsed ? "▶" : "▼";
  toggle.title = isCollapsed ? "Expand file" : "Fold file";
  toggle.setAttribute(
    "aria-label",
    isCollapsed
      ? `Expand ${wrapper.dataset.reviewFile ?? key}`
      : `Fold ${wrapper.dataset.reviewFile ?? key}`,
  );
  toggle.setAttribute("aria-expanded", String(!isCollapsed));
}

function decorateLines(
  wrapper: HTMLElement,
  oldFile: string,
  newFile: string,
): void {
  if (mode === "split") {
    const sides = [
      ...wrapper.querySelectorAll<HTMLElement>(".d2h-file-side-diff"),
    ];
    decorateSide(sides[0], "old", oldFile);
    decorateSide(sides[1], "new", newFile);
    return;
  }

  wrapper.querySelectorAll<HTMLTableRowElement>("tr").forEach((row) => {
    const numberCell = row.querySelector<HTMLElement>(".d2h-code-linenumber");
    const codeCell = row.querySelector<HTMLElement>(".d2h-code-line");
    if (!numberCell || !codeCell) return;
    const oldNumber = parseLine(
      numberCell.querySelector(".line-num1")?.textContent,
    );
    const newNumber = parseLine(
      numberCell.querySelector(".line-num2")?.textContent,
    );
    const text = lineText(codeCell);
    const oldLine = numberCell.querySelector<HTMLElement>(".line-num1");
    const newLine = numberCell.querySelector<HTMLElement>(".line-num2");
    if (oldNumber !== undefined && oldLine)
      attachLine(oldLine, row, oldFile, "old", oldNumber, text);
    if (newNumber !== undefined && newLine)
      attachLine(newLine, row, newFile, "new", newNumber, text);
    if (oldNumber !== undefined && !oldLine)
      attachLine(numberCell, row, oldFile, "old", oldNumber, text);
    if (newNumber !== undefined && !newLine && oldNumber === undefined)
      attachLine(numberCell, row, newFile, "new", newNumber, text);
  });
}

function decorateSide(
  side: HTMLElement | undefined,
  diffSide: DiffSide,
  file: string,
): void {
  if (!side) return;
  side.querySelectorAll<HTMLTableRowElement>("tr").forEach((row) => {
    const numberCell = row.querySelector<HTMLElement>(
      ".d2h-code-side-linenumber",
    );
    const codeCell = row.querySelector<HTMLElement>(
      ".d2h-code-side-line, .d2h-code-line",
    );
    if (!numberCell || !codeCell) return;
    const number = parseLine(numberCell.textContent);
    if (
      number === undefined ||
      numberCell.classList.contains("d2h-emptyplaceholder")
    )
      return;
    attachLine(numberCell, row, file, diffSide, number, lineText(codeCell));
  });
}

function parseLine(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/\d+/);
  if (!match) return undefined;
  const line = Number(match[0]);
  return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

function lineText(cell: HTMLElement): string {
  const content = cell.querySelector<HTMLElement>(".d2h-code-line-ctn");
  // The prefix (`+`, `-`, or a context space) is a sibling span in Diff2Html.
  // Reading only the content span gives the host exactly the source line.
  return content?.textContent ?? "";
}

function attachLine(
  element: HTMLElement,
  row: HTMLTableRowElement,
  file: string,
  side: DiffSide,
  line: number,
  text: string,
): void {
  element.classList.add("review-line-anchor");
  element.dataset.reviewSide = side;
  element.dataset.reviewFile = file;
  element.dataset.reviewLine = String(line);
  element.title = `${file}:${line} (${side === "old" ? "before" : "after"})`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "review-line-action";
  button.textContent = "+";
  button.title = "Add review comment";
  button.setAttribute("aria-label", `Add comment on ${file}:${line}`);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    chooseLine(file, side, line, text, row, event.shiftKey);
  });
  element.append(button);
  element.addEventListener("click", (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest(".review-line-action")
    )
      return;
    if (event.shiftKey) {
      event.preventDefault();
      chooseLine(file, side, line, text, row, true);
      return;
    }
    send({ type: "open", file, line });
  });
}

function chooseLine(
  file: string,
  side: DiffSide,
  line: number,
  text: string,
  row: HTMLTableRowElement,
  extend: boolean,
): void {
  if (
    extend &&
    selection &&
    selection.file === file &&
    selection.side === side
  ) {
    const start = Math.min(selection.start, line);
    const end = Math.max(selection.end, line);
    const lines = collectSelectedText(file, side, start, end);
    if (!lines) {
      showInfo("Select a contiguous range within one hunk.");
      return;
    }
    selection = { ...selection, start, end, text: lines };
  } else {
    selection = { file, side, start: line, end: line, text: [text] };
  }
  updateSelectedLines();
  openComposer(selection, row);
}

function collectSelectedText(
  file: string,
  side: DiffSide,
  start: number,
  end: number,
): string[] | undefined {
  const values: Array<{ line: number; text: string }> = [];
  diff
    .querySelectorAll<HTMLElement>("[data-review-side]")
    .forEach((element) => {
      if (
        element.dataset.reviewFile !== file ||
        element.dataset.reviewSide !== side
      )
        return;
      const line = Number(element.dataset.reviewLine);
      if (line >= start && line <= end)
        values.push({ line, text: lineTextFromAnchor(element) });
    });
  values.sort((left, right) => left.line - right.line);
  const byLine = new Map(values.map((value) => [value.line, value.text]));
  if (
    values.length !== end - start + 1 ||
    values.some((value) => !byLine.has(value.line))
  )
    return undefined;
  return Array.from(
    { length: end - start + 1 },
    (_, index) => byLine.get(start + index) ?? "",
  );
}

function lineTextFromAnchor(element: HTMLElement): string {
  const row = element.closest("tr");
  if (!row) return "";
  const codeCell = row.querySelector<HTMLElement>(
    ".d2h-code-line, .d2h-code-side-line",
  );
  return codeCell ? lineText(codeCell) : "";
}

function updateSelectedLines(): void {
  diff
    .querySelectorAll<HTMLElement>("[data-review-side]")
    .forEach((element) => {
      const line = Number(element.dataset.reviewLine);
      const selected =
        !!selection &&
        element.dataset.reviewFile === selection.file &&
        element.dataset.reviewSide === selection.side &&
        line >= selection.start &&
        line <= selection.end;
      element.classList.toggle("review-selected-line", selected);
    });
}

function anchorKey(anchor: ReviewAnchor): string {
  return `${currentReviewScope() ?? ""}:${anchor.file}:${anchor.side}:${anchor.start}-${anchor.end}`;
}

function openComposer(anchor: ReviewAnchor, _row?: HTMLTableRowElement): void {
  const key = `new:${anchorKey(anchor)}`;
  activeComposerKey = key;
  if (!draftAnchors[key]) draftAnchors[key] = anchor;
  if (!draftScopes[key]) draftScopes[key] = currentReviewScope() ?? "";
  persist();
  renderComments();
  const composer = document.querySelector<HTMLElement>(".review-composer");
  composer?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
}

function buildComposer(anchor: ReviewAnchor): HTMLElement {
  const key = `new:${anchorKey(anchor)}`;
  const form = document.createElement("form");
  form.className = "review-composer";
  form.dataset.reviewDraftKey = key;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pending.has(key)) return;
    const body =
      form.querySelector<HTMLTextAreaElement>("textarea")?.value.trim() ?? "";
    if (!body) {
      showError("Enter a review comment before saving.");
      return;
    }
    saveComment(key, undefined, anchor, body);
  });
  const heading = document.createElement("div");
  heading.className = "review-composer-heading";
  heading.textContent = `${anchor.file}:${anchor.start}${anchor.end === anchor.start ? "" : `–${anchor.end}`} (${anchor.side === "old" ? "before" : "after"})`;
  form.append(heading);
  const quote = document.createElement("pre");
  quote.className = "review-comment-quote";
  quote.textContent = anchor.text.join("\n");
  form.append(quote);
  const textarea = document.createElement("textarea");
  textarea.rows = 3;
  textarea.placeholder = "Leave a review comment…";
  textarea.value = drafts[key] ?? "";
  textarea.dataset.reviewDraftKey = key;
  textarea.setAttribute("aria-label", "Review comment");
  textarea.addEventListener("input", () => {
    rememberDraft(key, textarea.value, anchor);
    persist();
  });
  form.append(textarea);
  const actions = document.createElement("div");
  actions.className = "review-comment-actions";
  const operation = pending.get(key);
  const save = makeButton(
    operation ? "Saving…" : "Save comment",
    () => undefined,
    "review-save-button",
  );
  save.type = "submit";
  save.disabled = !!operation;
  actions.append(save);
  actions.append(
    makeButton("Cancel", () => {
      activeComposerKey = undefined;
      delete drafts[key];
      delete draftAnchors[key];
      delete draftScopes[key];
      selection = undefined;
      persist();
      updateSelectedLines();
      renderComments();
    }),
  );
  form.append(actions);
  return form;
}

function saveComment(
  key: string,
  id: string | undefined,
  anchor: ReviewAnchor,
  body: string,
): void {
  const operation: PendingSave = {
    key,
    scope: currentReviewScope(),
    id,
    body,
    anchor,
  };
  rememberDraft(key, body, anchor, operation.scope);
  pending.set(key, operation);
  persist();
  send({ type: "saveComment", ...(id ? { id } : {}), anchor, body });
  showInfo("Saving comment… Your draft will remain until it is acknowledged.");
  renderComments();
}

function syncDraftInputs(): void {
  document
    .querySelectorAll<HTMLTextAreaElement>(
      ".review-composer textarea, textarea[data-review-draft-key]",
    )
    .forEach((textarea) => {
      const key = textarea.dataset.reviewDraftKey;
      if (!key) return;
      const anchor =
        draftAnchors[key] ??
        (key === activeComposerKey ? selection : undefined);
      rememberDraft(key, textarea.value, anchor);
    });
}

function saveAllComments(): void {
  syncDraftInputs();
  const scope = currentReviewScope();
  if (!scope) {
    showError("Choose a review before saving comments.");
    return;
  }
  const entries: Array<{
    key: string;
    id?: string;
    anchor: ReviewAnchor;
    body: string;
  }> = [];
  for (const [key, value] of Object.entries(drafts)) {
    if (!value.trim() || scopeForDraft(key) !== scope || pending.has(key))
      continue;
    const anchor =
      draftAnchors[key] ??
      (key.startsWith("comment:")
        ? review.comments?.find((comment) => `comment:${comment.id}` === key)
            ?.anchor
        : undefined);
    if (!anchor) continue;
    entries.push({
      key,
      ...(key.startsWith("comment:")
        ? { id: key.slice("comment:".length) }
        : {}),
      anchor,
      body: value.trim(),
    });
  }
  if (!entries.length) {
    showInfo("There are no unsaved comments in this review.");
    return;
  }
  for (const entry of entries) {
    pending.set(entry.key, {
      key: entry.key,
      scope,
      id: entry.id,
      anchor: entry.anchor,
      body: entry.body,
    });
    rememberDraft(entry.key, entry.body, entry.anchor, scope);
  }
  persist();
  send({
    type: "saveComments",
    comments: entries.map(({ id, anchor, body }) => ({
      ...(id ? { id } : {}),
      anchor,
      body,
    })),
  });
  showInfo("Saving comments… Your drafts will remain until acknowledged.");
  renderComments();
}

function deleteComment(comment: ReviewComment): void {
  const key = `comment:${comment.id}`;
  if (pending.has(key)) return;
  pending.set(key, {
    key,
    scope: currentReviewScope(),
    id: comment.id,
    body: comment.body,
    anchor: comment.anchor,
    deleting: true,
  });
  persist();
  send({ type: "deleteComment", id: comment.id });
  showInfo("Deleting comment…");
  renderComments();
}

function jumpToComment(id: string): void {
  const comment = review.comments?.find((item) => item.id === id);
  if (!comment) return;
  const card = [
    ...document.querySelectorAll<HTMLElement>(".review-comment"),
  ].find((element) => element.dataset.commentId === id);
  if (!card) return;
  if (comment.status === "outdated") {
    card.scrollIntoView({ block: "center" });
    card.focus({ preventScroll: true });
    return;
  }
  const wrapper =
    card.closest<HTMLElement>(".d2h-file-wrapper") ??
    [...diff.querySelectorAll<HTMLElement>(".d2h-file-wrapper")].find(
      (candidate) => fileMatchesAnchor(candidate, comment.anchor.file),
    );
  const key = wrapper?.dataset.reviewFileKey;
  const toggle = wrapper?.querySelector<HTMLButtonElement>(
    ".review-file-toggle",
  );
  if (wrapper && key && toggle && collapsed.delete(key)) {
    applyCollapsed(wrapper, toggle, key);
    persist();
    alignSplitThreads();
  }

  const anchor = [
    ...diff.querySelectorAll<HTMLElement>("[data-review-side]"),
  ].find(
    (element) =>
      fileMatchesAnchor(
        element.closest<HTMLElement>(".d2h-file-wrapper")!,
        comment.anchor.file,
      ) &&
      element.dataset.reviewSide === comment.anchor.side &&
      element.dataset.reviewLine === String(comment.anchor.end),
  );
  if (!anchor) {
    const gate = wrapper?.querySelector<HTMLButtonElement>(
      "[data-review-reveal-file]",
    );
    if (gate) {
      if (gate.dataset.reviewHardLimit === "true") {
        pendingCommentNavigation = undefined;
        gate.click();
        return;
      }
      pendingCommentNavigation = { id };
      gate.click();
      const pendingNavigation = pendingCommentNavigation;
      pendingCommentNavigation = undefined;
      if (pendingNavigation && key && revealedFiles.has(key))
        jumpToComment(pendingNavigation.id);
      return;
    }
    const control = wrapper
      ? ([
          ...wrapper.querySelectorAll<HTMLButtonElement>(
            ".review-context-expansion-button",
          ),
        ].find((button) => {
          const line = comment.anchor.start;
          const start = Number(
            button.dataset[
              comment.anchor.side === "old"
                ? "reviewContextOldStart"
                : "reviewContextNewStart"
            ],
          );
          const end = Number(
            button.dataset[
              comment.anchor.side === "old"
                ? "reviewContextOldEnd"
                : "reviewContextNewEnd"
            ],
          );
          if (Number.isFinite(start) && Number.isFinite(end))
            return line >= start && line <= end;
          return false;
        }) ??
        wrapper.querySelector<HTMLButtonElement>(
          ".review-context-expansion-button",
        ))
      : undefined;
    if (control) {
      pendingCommentNavigation = { id };
      control.click();
      // Webview-local expansion rerenders synchronously. Host expansion will
      // retry from onState after its bounded range arrives.
      if (!pendingContextExpansion) {
        const pendingNavigation = pendingCommentNavigation;
        pendingCommentNavigation = undefined;
        if (pendingNavigation) jumpToComment(pendingNavigation.id);
      }
      return;
    }
  }
  card.scrollIntoView({ block: "center" });
  card.focus({ preventScroll: true });
}

function buildCommentIndex(items: ReviewComment[]): HTMLElement {
  const index = document.createElement("ul");
  index.className = "review-comment-index";
  index.setAttribute("aria-label", "All review comments");
  for (const comment of items) {
    const row = document.createElement("li");
    row.dataset.indexCommentId = comment.id;
    const location = `${comment.anchor.file}:${comment.anchor.start}${comment.anchor.end === comment.anchor.start ? "" : `–${comment.anchor.end}`} (${comment.anchor.side})`;
    const jump = makeButton(
      "",
      () => jumpToComment(comment.id),
      "review-comment-jump",
    );
    jump.title = `Go to comment on ${location}`;
    const label = document.createElement("span");
    label.className = "review-comment-index-location";
    label.textContent = location;
    const preview = document.createElement("span");
    preview.className = "review-comment-preview";
    const body = comment.body.replace(/\s+/g, " ").trim();
    preview.textContent = body.length > 120 ? `${body.slice(0, 120)}…` : body;
    jump.append(label, preview);
    if (comment.status === "outdated") {
      const badge = document.createElement("span");
      badge.className = "review-outdated-label";
      badge.textContent = "Outdated";
      jump.append(badge);
    }
    const operation = pending.get(`comment:${comment.id}`);
    const remove = makeButton(
      operation?.deleting ? "Deleting…" : "Delete",
      () => deleteComment(comment),
    );
    setButtonIcon(
      remove,
      "trash",
      operation?.deleting ? "Deleting…" : "Delete",
    );
    remove.disabled = !!operation;
    remove.setAttribute("aria-label", `Delete comment on ${location}`);
    row.append(jump, remove);
    index.append(row);
  }
  return index;
}

function buildComment(comment: ReviewComment): HTMLElement {
  const key = `comment:${comment.id}`;
  const card = document.createElement("article");
  card.className = `review-comment${comment.status === "outdated" ? " outdated" : ""}`;
  card.dataset.commentId = comment.id;
  card.tabIndex = -1;
  const heading = document.createElement("header");
  heading.className = "review-comment-header";
  const location = document.createElement("button");
  location.type = "button";
  location.className = "review-comment-location";
  location.textContent = `${comment.anchor.file}:${comment.anchor.start}${comment.anchor.end === comment.anchor.start ? "" : `–${comment.anchor.end}`} (${comment.anchor.side})`;
  location.title = "Open this location in the editor";
  location.addEventListener("click", () =>
    send({
      type: "open",
      file: comment.anchor.file,
      line: comment.anchor.start,
    }),
  );
  heading.append(location);
  if (comment.status === "outdated") {
    const outdated = document.createElement("span");
    outdated.className = "review-outdated-label";
    outdated.textContent = "Outdated in current diff";
    outdated.title =
      "The source lines no longer match the lines reviewed when this comment was made.";
    heading.append(outdated);
  }
  card.append(heading);

  const operation = pending.get(key);
  if (
    editingComment === comment.id ||
    (operation?.id === comment.id && !operation.deleting)
  ) {
    const textarea = document.createElement("textarea");
    textarea.rows = 4;
    textarea.value = drafts[key] ?? operation?.body ?? comment.body;
    textarea.dataset.reviewDraftKey = key;
    rememberDraft(key, textarea.value, comment.anchor);
    textarea.setAttribute("aria-label", "Edit review comment");
    textarea.addEventListener("input", () => {
      rememberDraft(key, textarea.value, comment.anchor);
      persist();
    });
    card.append(textarea);
    const actions = document.createElement("div");
    actions.className = "review-comment-actions";
    const save = makeButton(
      operation ? "Saving…" : "Save changes",
      () => {
        const body = textarea.value.trim();
        if (!body) {
          showError("Enter a review comment before saving.");
          return;
        }
        saveComment(key, comment.id, comment.anchor, body);
      },
      "review-save-button",
    );
    save.disabled = !!operation;
    actions.append(
      save,
      makeButton("Cancel", () => {
        editingComment = undefined;
        if (!pending.has(key)) {
          delete drafts[key];
          delete draftAnchors[key];
          delete draftScopes[key];
        }
        persist();
        renderComments();
      }),
    );
    card.append(actions);
  } else {
    const body = document.createElement("p");
    body.className = "review-comment-body";
    body.textContent = comment.body;
    card.append(body);
    const actions = document.createElement("div");
    actions.className = "review-comment-actions";
    const edit = makeButton("Edit", () => {
      editingComment = comment.id;
      rememberDraft(key, comment.body, comment.anchor);
      persist();
      renderComments();
    });
    const deleting = !!operation?.deleting;
    const remove = makeButton(deleting ? "Deleting…" : "Delete", () =>
      deleteComment(comment),
    );
    setButtonIcon(remove, "trash", deleting ? "Deleting…" : "Delete");
    remove.disabled = deleting;
    actions.append(edit, remove);
    card.append(actions);
  }
  return card;
}

function renderComments(): void {
  threadObserver?.disconnect();
  document
    .querySelectorAll(".review-thread-spacer")
    .forEach((element) => element.remove());
  document
    .querySelectorAll(".review-thread-row")
    .forEach((element) => element.remove());
  document
    .querySelectorAll(".review-composer")
    .forEach((element) => element.remove());
  const heading = document.createElement("div");
  heading.className = "review-comments-heading";
  const title = document.createElement("h2");
  title.textContent = "Review comments";
  heading.append(title);
  const count = document.createElement("span");
  count.className = "review-comment-count";
  count.textContent = String(review.comments?.length ?? 0);
  heading.append(count);

  const content = document.createDocumentFragment();
  content.append(heading);
  const items = review.comments ?? [];
  if (items.length) content.append(buildCommentIndex(items));
  if (!items.length && !activeComposerKey) {
    const empty = document.createElement("p");
    empty.className = "review-comments-empty";
    empty.textContent = "Select a line in the diff to add the first comment.";
    content.append(empty);
  }
  const list = document.createElement("div");
  list.className = "review-comment-list";
  for (const comment of items) list.append(buildComment(comment));
  content.append(list);
  comments.replaceChildren(content);
  placeComposer();
  placeInlineComments(list);
  alignSplitThreads();
  if (typeof ResizeObserver !== "undefined") {
    threadObserver = new ResizeObserver(alignSplitThreads);
    diff
      .querySelectorAll(".review-thread-row")
      .forEach((row) => threadObserver!.observe(row));
  }
}

/** Keep corresponding source rows aligned when one pane contains a review
 * thread. Spacer rows also carry the opposite gutter through the thread. */
function alignSplitThreads(): void {
  diff.querySelectorAll(".review-thread-spacer").forEach((row) => row.remove());
  if (mode !== "split") return;
  diff.querySelectorAll(".d2h-files-diff").forEach((container) => {
    const sides = [...container.querySelectorAll(".d2h-file-side-diff")];
    if (sides.length !== 2) return;
    const rows = sides.map((side) =>
      [
        ...side.querySelectorAll<HTMLTableRowElement>(
          ".d2h-diff-table > tbody > tr",
        ),
      ].filter((row) => !row.classList.contains("review-thread-row")),
    );
    const group = (row: HTMLTableRowElement) => {
      let after: Element = row;
      let height = 0;
      while (
        after.nextElementSibling?.classList.contains("review-thread-row")
      ) {
        after = after.nextElementSibling;
        height += after.getBoundingClientRect().height;
      }
      return { after, height };
    };
    for (let i = 0; i < Math.min(rows[0].length, rows[1].length); i++) {
      const pair = [group(rows[0][i]), group(rows[1][i])];
      const difference = pair[0].height - pair[1].height;
      if (Math.abs(difference) < 0.5) continue;
      const shorter = difference < 0 ? pair[0] : pair[1];
      const spacer = document.createElement("tr");
      spacer.className = "review-thread-spacer";
      spacer.setAttribute("aria-hidden", "true");
      spacer.style.height = `${Math.abs(difference)}px`;
      const gutter = document.createElement("td");
      gutter.className = "d2h-code-side-linenumber";
      const cell = document.createElement("td");
      spacer.append(gutter, cell);
      shorter.after.after(spacer);
    }
  });
}

function threadRow(
  content: HTMLElement,
  row: HTMLTableRowElement,
): HTMLTableRowElement {
  const thread = document.createElement("tr");
  thread.className = "review-thread-row";
  const cell = document.createElement("td");
  cell.colSpan = Math.max(1, row.cells.length);
  cell.append(content);
  thread.append(cell);
  return thread;
}

function placeComposer(): void {
  document
    .querySelectorAll(".review-composer")
    .forEach((element) => element.remove());
  if (
    !activeComposerKey ||
    !selection ||
    activeComposerKey !== `new:${anchorKey(selection)}`
  )
    return;
  const composer = buildComposer(selection);
  const anchor = [
    ...diff.querySelectorAll<HTMLElement>("[data-review-side]"),
  ].find(
    (element) =>
      element.dataset.reviewFile === selection?.file &&
      element.dataset.reviewSide === selection?.side &&
      element.dataset.reviewLine === String(selection?.start),
  );
  const row = anchor?.closest("tr");
  if (row?.parentElement) row.after(threadRow(composer, row));
  else comments.prepend(composer);
}

function placeInlineComments(list: HTMLElement): void {
  for (const comment of review.comments ?? []) {
    if (comment.status === "outdated") continue;
    const card = [
      ...list.querySelectorAll<HTMLElement>("[data-comment-id]"),
    ].find((element) => element.dataset.commentId === comment.id);
    if (!card) continue;
    const anchor = [
      ...diff.querySelectorAll<HTMLElement>("[data-review-side]"),
    ].find(
      (element) =>
        fileMatchesAnchor(
          element.closest<HTMLElement>(".d2h-file-wrapper")!,
          comment.anchor.file,
        ) &&
        element.dataset.reviewSide === comment.anchor.side &&
        element.dataset.reviewLine === String(comment.anchor.end),
    );
    const row = anchor?.closest("tr");
    if (!row?.parentElement) continue;
    row.after(threadRow(card, row));
  }
}

function sameAnchor(
  left: ReviewAnchor | undefined,
  right: ReviewAnchor | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.file === right.file &&
    left.side === right.side &&
    left.start === right.start &&
    left.end === right.end &&
    left.text.join("\n") === right.text.join("\n")
  );
}

function acknowledge(nextComments: ReviewComment[]): void {
  for (const [key, operation] of pending) {
    if (operation.scope && operation.scope !== currentReviewScope()) continue;
    if (operation.deleting) {
      if (!nextComments.some((comment) => comment.id === operation.id)) {
        pending.delete(key);
        delete drafts[key];
        delete draftAnchors[key];
        delete draftScopes[key];
      }
      continue;
    }
    const acknowledged = operation.id
      ? nextComments.find(
          (comment) =>
            comment.id === operation.id && comment.body === operation.body,
        )
      : nextComments.find(
          (comment) =>
            sameAnchor(comment.anchor, operation.anchor) &&
            comment.body === operation.body,
        );
    if (acknowledged) {
      pending.delete(key);
      delete drafts[key];
      delete draftAnchors[key];
      delete draftScopes[key];
      if (key.startsWith("new:")) {
        activeComposerKey = undefined;
        selection = undefined;
      } else if (editingComment === acknowledged.id) {
        editingComment = undefined;
      }
    }
  }
  // A pending operation restored after a crash was sent before this webview
  // existed. Once the host's first authoritative state arrives, release any
  // unmatched operation so its draft can be edited and retried. Operations
  // created during this session remain pending across ordinary refreshes.
  if (restoredPendingKeys.size) {
    for (const key of restoredPendingKeys) {
      const operation = pending.get(key);
      if (operation?.scope === currentReviewScope()) pending.delete(key);
    }
    restoredPendingKeys.clear();
  }
  persist();
}

function sectionFileNames(section: string): { old?: string; new?: string } {
  try {
    const file = parse(section)[0];
    return { old: file?.oldName, new: file?.newName };
  } catch {
    return {};
  }
}

function hunkStart(line: string): { old: number; next: number } | undefined {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?/);
  if (!match) return undefined;
  return { old: Number(match[1]), next: Number(match[2]) };
}

function contextRows(oldLines: string[], newLines: string[]): string[] {
  const rows: string[] = [];
  const count = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < count; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];
    if (oldLine !== undefined && newLine !== undefined) {
      if (oldLine === newLine) rows.push(` ${oldLine}`);
      else rows.push(`-${oldLine}`, `+${newLine}`);
    } else if (oldLine !== undefined) rows.push(`-${oldLine}`);
    else if (newLine !== undefined) rows.push(`+${newLine}`);
  }
  return rows;
}

/**
 * Insert only the source rows returned for one requested range. Keeping these
 * as a separate hunk preserves other hidden gaps and previously loaded ranges
 * in the same file.
 */
function mergeContextRows(
  basePatch: string,
  fileName: string,
  range: {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
  },
  oldLines: string[],
  newLines: string[],
): string {
  const filePath = normalizeFilePath(fileName);
  const sectionPattern = /(?=^diff --git )/m;
  const sections = basePatch.split(sectionPattern);
  let merged = false;
  const result = sections.map((section) => {
    if (merged) return section;
    const names = sectionFileNames(section);
    if (
      ![names.old, names.new]
        .filter((name): name is string => !!name)
        .some((name) => normalizeFilePath(name) === filePath)
    )
      return section;

    const lines = section.split("\n");
    const hunkLines = lines
      .map((line, index) => ({ line, index, start: hunkStart(line) }))
      .filter(
        (
          entry,
        ): entry is {
          line: string;
          index: number;
          start: { old: number; next: number };
        } => entry.start !== undefined,
      );
    let parsedFile: ReturnType<typeof parse>[number] | undefined;
    try {
      parsedFile = parse(section)[0];
    } catch {
      parsedFile = undefined;
    }
    if (!parsedFile) return section;

    const existingOld = new Map<number, string>();
    const existingNew = new Map<number, string>();
    for (const block of parsedFile.blocks) {
      for (const line of block.lines) {
        if (line.oldNumber !== undefined)
          existingOld.set(line.oldNumber, line.content);
        if (line.newNumber !== undefined)
          existingNew.set(line.newNumber, line.content);
      }
    }
    const rowCount = Math.max(oldLines.length, newLines.length);
    const missing = Array.from(
      { length: rowCount },
      (_, index) => index,
    ).filter(
      (index) =>
        (oldLines[index] !== undefined &&
          !existingOld.has(range.oldStart + index)) ||
        (newLines[index] !== undefined &&
          !existingNew.has(range.newStart + index)),
    );
    if (!missing.length) {
      merged = true;
      return section;
    }

    const groups: Array<{ start: number; end: number }> = [];
    for (const index of missing) {
      const previous = groups.at(-1);
      if (previous && previous.end + 1 === index) previous.end = index;
      else groups.push({ start: index, end: index });
    }
    const insertions = groups
      .map((group) => {
        const oldValues = oldLines.slice(group.start, group.end + 1);
        const newValues = newLines.slice(group.start, group.end + 1);
        const rows: string[] = [];
        for (
          let offset = 0;
          offset < oldValues.length || offset < newValues.length;
          offset += 1
        ) {
          const absolute = group.start + offset;
          const oldLine = oldValues[offset];
          const newLine = newValues[offset];
          const oldMissing =
            oldLine !== undefined &&
            !existingOld.has(range.oldStart + absolute);
          const newMissing =
            newLine !== undefined &&
            !existingNew.has(range.newStart + absolute);
          if (oldMissing && newMissing) {
            if (oldLine === newLine) rows.push(` ${oldLine}`);
            else rows.push(`-${oldLine}`, `+${newLine}`);
          } else if (oldMissing) rows.push(`-${oldLine}`);
          else if (newMissing) rows.push(`+${newLine}`);
        }
        if (!rows.length) return undefined;
        const oldMissingCount = oldValues.filter(
          (_, offset) =>
            !existingOld.has(range.oldStart + group.start + offset),
        ).length;
        const newMissingCount = newValues.filter(
          (_, offset) =>
            !existingNew.has(range.newStart + group.start + offset),
        ).length;
        const oldStart = oldMissingCount ? range.oldStart + group.start : 0;
        const newStart = newMissingCount ? range.newStart + group.start : 0;
        const hunk = [
          `@@ -${oldMissingCount ? `${oldStart},${oldMissingCount}` : "0,0"} +${newMissingCount ? `${newStart},${newMissingCount}` : "0,0"} @@`,
          ...rows,
        ];
        const insertion =
          hunkLines.find(
            ({ start }) =>
              start.old > (oldStart || range.oldStart) ||
              start.next > (newStart || range.newStart),
          )?.index ?? lines.length;
        return { insertion, hunk };
      })
      .filter(
        (value): value is { insertion: number; hunk: string[] } =>
          value !== undefined,
      );
    for (const { insertion, hunk } of [...insertions].sort(
      (left, right) => right.insertion - left.insertion,
    ))
      lines.splice(insertion, 0, ...hunk);
    merged = true;
    return lines.join("\n");
  });
  return merged ? result.join("") : basePatch;
}

/** Replace one file in the saved multi-file patch with a bounded response. */
function mergeExpandedPatch(
  basePatch: string,
  expandedPatch: string,
  fileName: string,
): string {
  if (!expandedPatch.trim()) return basePatch;
  const sections = expandedPatch.split(/(?=^diff --git )/m);
  const expandedSection = sections.find((section) => {
    const names = sectionFileNames(section);
    return [names.old, names.new]
      .filter((name): name is string => !!name)
      .some((name) => normalizeFilePath(name) === normalizeFilePath(fileName));
  });
  if (!expandedSection) return basePatch;
  const baseSections = basePatch.split(/(?=^diff --git )/m);
  let replaced = false;
  const merged = baseSections.map((section) => {
    if (replaced) return section;
    const names = sectionFileNames(section);
    if (
      [names.old, names.new]
        .filter((name): name is string => !!name)
        .some((name) => normalizeFilePath(name) === normalizeFilePath(fileName))
    ) {
      replaced = true;
      return expandedSection;
    }
    return section;
  });
  return replaced ? merged.join("") : basePatch;
}

function onContextExpanded(message: ContextExpandedMessage): void {
  const id =
    typeof message.regionId === "string" && message.regionId
      ? message.regionId
      : pendingContextExpansion?.id;
  if (
    !id ||
    typeof message.file !== "string" ||
    (!message.patch &&
      (!Array.isArray(message.oldLines) || !Array.isArray(message.newLines)))
  )
    return;
  const hasSourceRows =
    Array.isArray(message.oldLines) &&
    Array.isArray(message.newLines) &&
    Number.isSafeInteger(message.oldStart) &&
    Number.isSafeInteger(message.oldEnd) &&
    Number.isSafeInteger(message.newStart) &&
    Number.isSafeInteger(message.newEnd);
  review.patch = hasSourceRows
    ? mergeContextRows(
        review.patch ?? "",
        message.file,
        {
          oldStart: message.oldStart!,
          oldEnd: message.oldEnd!,
          newStart: message.newStart!,
          newEnd: message.newEnd!,
        },
        message.oldLines!,
        message.newLines!,
      )
    : mergeExpandedPatch(review.patch ?? "", message.patch ?? "", message.file);
  expandedContextBlocks.add(id);
  contextExpansionErrors.delete(id);
  if (
    (message.endOfFile ||
      (message.direction === "below" &&
        Array.isArray(message.oldLines) &&
        Array.isArray(message.newLines) &&
        message.oldLines.length < CONTEXT_EXPANSION_LINES &&
        message.newLines.length < CONTEXT_EXPANSION_LINES)) &&
    typeof message.file === "string" &&
    message.direction
  )
    exhaustedContextRegions.add(
      contextRegionKey(message.file, message.direction),
    );
  pendingContextExpansion = undefined;
  review.expandedRanges = [
    ...(review.expandedRanges ?? []).filter((range) => range.id !== id),
    ...(message.direction &&
    Number.isSafeInteger(message.oldStart) &&
    Number.isSafeInteger(message.oldEnd) &&
    Number.isSafeInteger(message.newStart) &&
    Number.isSafeInteger(message.newEnd)
      ? [
          {
            id,
            file: message.file,
            direction: message.direction,
            oldStart: message.oldStart!,
            oldEnd: message.oldEnd!,
            newStart: message.newStart!,
            newEnd: message.newEnd!,
          },
        ]
      : []),
  ];
  renderDiff();
  updateModeButtons();
  if (pendingCommentNavigation) {
    const navigation = pendingCommentNavigation;
    pendingCommentNavigation = undefined;
    queueMicrotask(() => jumpToComment(navigation.id));
  }
}

function onContextError(message: ContextErrorMessage): void {
  const id =
    typeof message.regionId === "string" && message.regionId
      ? message.regionId
      : pendingContextExpansion?.id;
  if (!id) return;
  pendingContextExpansion = undefined;
  pendingCommentNavigation = undefined;
  contextExpansionErrors.set(
    id,
    message.message?.trim() || "Could not load more context. Try again.",
  );
  renderDiff();
}

function onState(message: ReviewStateMessage): void {
  const previousPatch = review.patch ?? "";
  const completedExpansion = pendingContextExpansion;
  const previousScope = currentReviewScope();
  const nextScope = reviewScope(
    message.repo,
    message.reviewId,
    message.command,
  );
  const legacyScope = `${message.repo ?? ""}|${message.command ?? ""}`;
  const isLegacyMigration =
    !hasAuthoritativeState &&
    !!message.reviewId &&
    !!restoredReviewScope &&
    restoredReviewScope === legacyScope &&
    restoredReviewScope !== nextScope;
  if (isLegacyMigration) migrateLegacyDrafts(legacyScope, nextScope);
  else if (
    !hasAuthoritativeState &&
    !!message.reviewId &&
    !!restoredReviewScope &&
    restoredReviewScope !== nextScope
  ) {
    legacyDraftsForeign = true;
  }
  const reviewChanged =
    !isLegacyMigration &&
    previousScope !== undefined &&
    previousScope !== nextScope;
  const hasSnapshotPatch = typeof message.snapshot?.patch === "string";
  if (reviewChanged) {
    // Keep draft text and pending operations for crash recovery, but never
    // display an anchor from a different repository/comparison in this diff.
    selection = undefined;
    activeComposerKey = undefined;
    editingComment = undefined;
    expandedContextBlocks.clear();
    localExpansionProgress.clear();
    exhaustedContextRegions.clear();
    contextExpansionErrors.clear();
    pendingContextExpansion = undefined;
  } else if (hasSnapshotPatch) {
    // A snapshot is authoritative. Rebuild the visible patch from its base
    // patch and source rows below so a refresh cannot retain rows from the
    // previous review or from an earlier version of the snapshot.
    expandedContextBlocks.clear();
    localExpansionProgress.clear();
    exhaustedContextRegions.clear();
    contextExpansionErrors.clear();
    pendingContextExpansion = undefined;
  } else if (completedExpansion) {
    expandedContextBlocks.add(completedExpansion.id);
    pendingContextExpansion = undefined;
  } else if ((message.patch ?? "") !== previousPatch) {
    expandedContextBlocks.clear();
    localExpansionProgress.clear();
  }
  const authoritativePatch = hasSnapshotPatch
    ? message.snapshot!.patch!
    : (message.patch ?? "");
  review = {
    type: "state",
    repo: message.repo,
    directory: message.directory,
    command: message.command,
    reviewId: message.reviewId,
    reviewName: message.reviewName,
    repos: message.repos,
    reviews: message.reviews,
    viewMode: message.viewMode,
    contextLines: message.contextLines,
    canExpandContext: message.canExpandContext,
    customCommand: message.customCommand,
    patch: authoritativePatch,
    comments: Array.isArray(message.comments) ? message.comments : [],
    expandedRanges: message.expandedRanges ?? message.snapshot?.expandedRanges,
  };
  if (hasSnapshotPatch) {
    const savedRanges = message.snapshot?.sourceRanges ?? [];
    const rangeMetadata =
      message.expandedRanges ?? message.snapshot?.expandedRanges ?? [];
    for (const source of savedRanges) {
      const range = rangeMetadata.find(
        (candidate) => candidate.id === source.id,
      );
      if (
        !range ||
        !Array.isArray(source.oldLines) ||
        !Array.isArray(source.newLines) ||
        !Number.isSafeInteger(source.oldStart) ||
        !Number.isSafeInteger(source.newStart)
      )
        continue;
      review.patch = mergeContextRows(
        review.patch ?? "",
        source.file,
        range,
        source.oldLines,
        source.newLines,
      );
      expandedContextBlocks.add(source.id);
      if (
        range.direction === "below" &&
        (source.endOfFile ??
          // Older snapshots used 20-line increments.
          (source.oldLines.length < 20 && source.newLines.length < 20))
      )
        exhaustedContextRegions.add(
          contextRegionKey(source.file, range.direction),
        );
    }
  }
  if (!hasAuthoritativeState) {
    if (message.viewMode === "inline" || message.viewMode === "split")
      mode = message.viewMode;
    hasAuthoritativeState = true;
  }
  acknowledge(review.comments ?? []);
  if (customCommandInput && document.activeElement !== customCommandInput)
    customCommandInput.value = review.customCommand ?? "";
  updatePresetFromCommand();
  const location = review.repo
    ? `Repository: ${review.repo}${
        review.directory && review.directory !== review.repo
          ? ` · Directory: ${review.directory}`
          : ""
      }`
    : "Choose a repository to review";
  showInfo(
    review.reviewName
      ? `${location}  •  ${review.reviewName}`
      : review.command
        ? `${location}  •  ${review.command}`
        : location,
  );
  clearError();
  updateReviewControls();
  renderReviewManager();
  renderDiff();
  updateModeButtons();
  if (pendingCommentNavigation) {
    const navigation = pendingCommentNavigation;
    pendingCommentNavigation = undefined;
    queueMicrotask(() => jumpToComment(navigation.id));
  }
}

function onReviewsDeleted(message: { repo?: string; ids?: string[] }): void {
  const scopes = new Set(
    (message.ids ?? []).map((id) => reviewScope(message.repo, id)),
  );
  if (!scopes.size) return;
  for (const key of Object.keys(draftScopes)) {
    if (!scopes.has(draftScopes[key])) continue;
    delete drafts[key];
    delete draftAnchors[key];
    delete draftScopes[key];
  }
  for (const [key, operation] of pending) {
    if (operation.scope && scopes.has(operation.scope)) pending.delete(key);
  }
  if (currentReviewScope() && scopes.has(currentReviewScope()!)) {
    selection = undefined;
    activeComposerKey = undefined;
    editingComment = undefined;
  }
  persist();
  renderComments();
}

window.addEventListener("message", (event) => {
  const message = event.data as
    | ReviewStateMessage
    | ContextExpandedMessage
    | ContextErrorMessage
    | { type: "error"; message?: string }
    | { type: "reviewsDeleted"; repo?: string; ids?: string[] }
    | undefined;
  if (!message || typeof message.type !== "string") return;
  if (message.type === "state") onState(message);
  else if (message.type === "contextExpanded") onContextExpanded(message);
  else if (message.type === "contextError") onContextError(message);
  else if (message.type === "reviewsDeleted") onReviewsDeleted(message);
  else if (message.type === "error") {
    for (const [key, operation] of pending) {
      if (!operation.scope || operation.scope === currentReviewScope())
        pending.delete(key);
    }
    persist();
    showError(
      message.message ||
        "Sapling Review reported an error. Drafts were kept locally.",
    );
    renderDiff();
  }
});

buildToolbar();
renderDiff();
send({ type: "ready" });
