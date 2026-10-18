import { parse } from "diff2html";
import { Diff2HtmlUI } from "diff2html/lib/ui/js/diff2html-ui.js";
import "./style.css";

type DiffSide = "old" | "new";
type ViewMode = "split" | "inline";

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
  command?: string;
  reviewId?: string;
  reviewName?: string;
  repos?: string[];
  reviews?: ReviewSummary[];
  viewMode?: ViewMode;
  patch?: string;
  comments?: ReviewComment[];
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
let collapsed = new Set<string>(restored.collapsed ?? []);
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

const PRESET_COMMANDS: Record<string, string> = {
  uncommitted: "sl diff --git --rev .",
  head: "sl diff --git --rev .^",
  stack: "sl diff --git --rev ancestor(.,interestingmaster())",
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
      customCommandInput!.value = PRESET_COMMANDS[preset.value] ?? "";
      toolbar
        .querySelector<HTMLButtonElement>(".review-refresh-button")
        ?.click();
    }
    updateCommandControls();
  });

  customCommandInput = document.createElement("input");
  customCommandInput.type = "text";
  customCommandInput.className = "review-command-input";
  customCommandInput.placeholder = "sl diff --git …";
  customCommandInput.setAttribute(
    "aria-label",
    "Sapling command producing a diff",
  );
  customCommandInput.spellcheck = false;
  customCommandInput.value = review.command ?? PRESET_COMMANDS.uncommitted;
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

function fileKey(name: string, index: number): string {
  return `${index}:${name}`;
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

  const output = document.createElement("div");
  output.className = "review-diff-output";
  diff.append(output);

  try {
    // Diff2HtmlUI's regular build includes the complete highlight.js language
    // registry. draw() calls highlightCode() with that registry.
    const ui = new Diff2HtmlUI(output, patch, {
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
    const name = fileName(files[index]);
    const key = fileKey(name, index);
    wrapper.id = `review-file-${index}`;
    wrapper.dataset.reviewFile = name;
    wrapper.dataset.reviewFileKey = key;
    if (/\.(?:md|markdown)$/i.test(name)) {
      wrapper.classList.add("review-markdown-file");
      stripMarkdownIntralineMarkup(wrapper);
    }
    decorateFileHeader(wrapper, name, key, files[index]);
    decorateLines(
      wrapper,
      sideFileName(files[index], "old"),
      sideFileName(files[index], "new"),
    );

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
  if (renderedName) renderedName.textContent = name;
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
    isCollapsed ? `Expand ${key}` : `Fold ${key}`,
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
  const card = [
    ...document.querySelectorAll<HTMLElement>(".review-comment"),
  ].find((element) => element.dataset.commentId === id);
  if (!card) return;
  const wrapper = card.closest<HTMLElement>(".d2h-file-wrapper");
  const key = wrapper?.dataset.reviewFileKey;
  const toggle = wrapper?.querySelector<HTMLButtonElement>(
    ".review-file-toggle",
  );
  if (wrapper && key && toggle && collapsed.delete(key)) {
    applyCollapsed(wrapper, toggle, key);
    persist();
    alignSplitThreads();
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
        element.dataset.reviewFile === comment.anchor.file &&
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

function onState(message: ReviewStateMessage): void {
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
  if (reviewChanged) {
    // Keep draft text and pending operations for crash recovery, but never
    // display an anchor from a different repository/comparison in this diff.
    selection = undefined;
    activeComposerKey = undefined;
    editingComment = undefined;
  }
  review = {
    type: "state",
    repo: message.repo,
    command: message.command,
    reviewId: message.reviewId,
    reviewName: message.reviewName,
    repos: message.repos,
    reviews: message.reviews,
    viewMode: message.viewMode,
    patch: message.patch ?? "",
    comments: Array.isArray(message.comments) ? message.comments : [],
  };
  if (!hasAuthoritativeState) {
    if (message.viewMode === "inline" || message.viewMode === "split")
      mode = message.viewMode;
    hasAuthoritativeState = true;
  }
  acknowledge(review.comments ?? []);
  if (customCommandInput && document.activeElement !== customCommandInput)
    customCommandInput.value = review.command ?? "";
  updatePresetFromCommand();
  const location = review.repo
    ? `Repository: ${review.repo}`
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
    | { type: "error"; message?: string }
    | { type: "reviewsDeleted"; repo?: string; ids?: string[] }
    | undefined;
  if (!message || typeof message.type !== "string") return;
  if (message.type === "state") onState(message);
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
    renderComments();
  }
});

buildToolbar();
renderDiff();
send({ type: "ready" });
