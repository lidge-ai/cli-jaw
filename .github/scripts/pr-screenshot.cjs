"use strict";

/**
 * PR screenshot gate for cli-jaw.
 *
 * Ported from opencodex's `.github/scripts/pr-quality.cjs`, narrowed to the
 * screenshot gate only. `.github/workflows/pr-screenshot-gate.yml` runs on
 * `pull_request_target` — so the workflow file itself executes from the
 * repo's default branch — and fetches this file from the trusted
 * integration branch (`dev`, or `main` for main-targeting PRs) at run time
 * before calling `run()`. The workflow never checks out PR head code and
 * needs only `pull-requests: read` + `issues: read`.
 *
 * UI surface (decided here, mirrored in CONTRIBUTING.md):
 *
 *   - `public/**` — the manager dashboard / web frontend served by the app
 *     and loaded by the Electron shell. Every file counts: markup, script,
 *     styles, locales, and test *pages* such as `public/theme-test.html`,
 *     which render visible UI.
 *   - `electron/**` — only the desktop shell's rendered surface:
 *     `electron/src/preload/**` plus renderer/markup/style files
 *     (`*.html`, `*.css`, `*.tsx`, `*.jsx`, `*.vue`, `*.svelte`). Main-process
 *     TypeScript (spawning, IPC, window plumbing) is not rendered and does
 *     not arm the gate; neither do installer assets under `electron/build/`.
 *   - Pure test files never arm the gate: path segments named `test`,
 *     `tests`, `__tests__`, `__mocks__`, or `fixtures`, and file names ending
 *     in `.test.<ext>` or `.spec.<ext>`.
 *
 * Waivers (checked by `run`):
 *
 *   - The `ui-screenshot-waived` label, but only when the actor who applied
 *     it (from the issue event timeline) has write/maintain/admin access —
 *     checked via `repos.getCollaboratorPermissionLevel`.
 *   - A maintainer comment matching `UI_OVERRIDE_RE` (e.g. "no UI changes in
 *     this PR"), held to the same bar as the label: the author's collaborator
 *     permission is verified (association alone is not enough — MEMBER covers
 *     read-only org members), and the comment must postdate the head commit's
 *     server-side push time so a stale "no UI changes" cannot waive commits
 *     pushed later.
 */

/** Label that waives the gate when applied by a write+ collaborator. */
const UI_SCREENSHOT_WAIVER_LABEL = "ui-screenshot-waived";

/** Path segments that mark a file as a pure test artifact. */
const PURE_TEST_SEGMENT_RE = /^(?:tests?|__tests__|__mocks__|fixtures?)$/i;
/** File names that mark a file as a pure test artifact. */
const PURE_TEST_NAME_RE = /\.(?:test|spec)\.[^/]+$/i;
/** Electron files that render UI: preload surface plus markup/style/component types. */
const ELECTRON_UI_FILE_RE = /\.(?:x?html|css|tsx|jsx|vue|svelte)$/i;

/** HTML comments, which GitHub never renders. An unclosed comment runs through EOF. */
const HTML_COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
/** Fenced code blocks (``` or ~~~) whose content GitHub does not render. */
const FENCED_CODE_RE = /(?:^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*(?=\n|$)/gm;
/** Embedded markdown image (`![alt](url)`), as GitHub renders for dropped images. */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/;
/** Reference-style markdown image (`![alt][id]`, collapsed `![alt][]`). */
const MARKDOWN_REFERENCE_IMAGE_RE = /!\[([^\]]*)\]\[([^\]]*)\]/g;
/** Link definitions (`[id]: url`) that reference-style images depend on. */
const MARKDOWN_REFERENCE_DEF_RE = /^\s*\[([^\]]+)\]:\s*\S+/gm;
/** Embedded HTML image with a renderable `src` (`<img ... src="...">`). */
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>"']+)[^>]*>/i;

/**
 * Phrases in a maintainer comment that waive the UI-screenshot gate. A waiver
 * must assert that the UI does not change — a bare negation near `ui`/`gui` is
 * not enough, or "doesn't ship without a UI screenshot" would waive the gate
 * it complains about. So the match must couple a negation to a change-family
 * word (no UI changes, doesn't touch the UI, the UI is unchanged), and the
 * span cannot cross a sentence or line boundary: "This does not change the
 * API. Please add a ui screenshot." must not waive the gate.
 */
const UI_OVERRIDE_RE = new RegExp(
  [
    // "no UI changes", "not a ui change", "never any real gui impact",
    // "without ui changes", "no rendered ui changes"
    /\b(?:no|not|never|without)\s+(?:(?:a|an|any|the|this|that|real|actual|visible|rendered)\s+){0,2}(?:ui|gui)[-\s](?:changes?|impact|modifications?|difference)\b/.source,
    // "doesn't change the ui", "no changes to the ui" — the negation must
    // govern the change-verb within two plain words and the verb must reach
    // ui/gui directly (optional preposition + article), so "no idea if this
    // changes the ui" and "doesn't change the API, only the ui" cannot waive.
    /\b(?:doesn'?t|does not|didn'?t|did not|won'?t|will not|never|not|no)\s+(?:[\w']+\s+){0,2}(?:changes?|touch(?:es)?|modif(?:y|ies)|affects?|alters?|reverts?)\b(?:\s+(?:to|in|of|for|on|at|into))?\s+(?:the|a|an|any|this|that)?\s*(?:ui|gui)\b/.source,
    // "the ui is unchanged", "ui is not touched", "gui remains unmodified"
    /\b(?:ui|gui)\b\s+(?:(?:is|was|are|remains?|stays?|looks?)\s+)?(?:un(?:touched|changed|modified|affected|altered)|not\s+(?:touched|changed|modified|affected|altered))\b/.source,
    // Korean waivers ending in a final "no" — "UI 변경 없음",
    // "UI 변경이 없습니다", "GUI 영향 없어요"; 없이/없는 never waive.
    /(?:ui|gui)\s*(?:변경|수정|영향)[이가]?\s*없(?:음|습니다|습니까|어요|다)/.source,
  ].join("|"),
  "i"
);

/**
 * Affirmative statements that a PR changes the UI. A comment matching both
 * this and `UI_OVERRIDE_RE` is contradictory, not a waiver — e.g. "no ui
 * changes here, but this changes the ui tests". Past-tense forms only in
 * the trailing group: `ui changes` would collide with "no ui changes".
 */
const UI_CHANGE_CLAIM_RE = new RegExp(
  [
    // "this changes the ui", "it still modifies ui", "commits only touch gui"
    // — up to two adverbs may sit between subject and verb, but a negation
    // word there keeps the clause negative ("this doesn't change the ui").
    /\b(?:this|it|that|these|those|which|who|only|code|patch|pr|pull request|branch|commits?|changes?)\s+(?:(?!no\b|not\b|never\b|doesn'?t\b|does not\b|didn'?t\b|did not\b|won'?t\b|will not\b)[\w']+\s+){0,2}(?:changes?|touch(?:es)?|modif(?:y|ies)|affects?|alters?|updates?|reverts?)\b[^.!?\n]{0,20}?\b(?:ui|gui)\b/.source,
    // "the ui changed", "ui was modified", "gui is updated"
    /\b(?:ui|gui)\s+(?:was|is|were|has been|was being|gets?|got)?\s*(?:changed|modified|touched|altered|updated|affected|impacted)\b/.source,
    // Korean affirmative: "UI 변경 있음", "GUI 수정 있습니다"
    /(?:ui|gui)\s*(?:변경|수정|영향)[이가]?\s*있/.source,
  ].join("|"),
  "i"
);

function isPureTestFile(file) {
  if (typeof file !== "string" || !file) return false;
  const normalized = file.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => PURE_TEST_SEGMENT_RE.test(segment))) return true;
  return PURE_TEST_NAME_RE.test(segments.at(-1) ?? "");
}

/** True when a changed path is part of the rendered UI surface. */
function isUiSurfacePath(file) {
  if (typeof file !== "string" || !file) return false;
  const normalized = file.replace(/\\/g, "/");
  if (isPureTestFile(normalized)) return false;
  if (normalized === "public" || normalized.startsWith("public/")) return true;
  if (normalized === "electron" || normalized.startsWith("electron/")) {
    if (normalized.startsWith("electron/src/preload/")) return true;
    return ELECTRON_UI_FILE_RE.test(normalized);
  }
  return false;
}

function uiPathsChanged(files) {
  return (files ?? []).some(isUiSurfacePath);
}

/**
 * True when the changed-file list from `pulls.listFiles` cannot be trusted to
 * be complete for screenshot gating. Missing or non-integer counts, a head
 * mismatch between the count snapshot and the paginated list, or a count above
 * the returned list length all fail closed. (GitHub caps the list at 3,000.)
 */
function isChangedFileListTruncated(changedFilesCount, listedLength, headMatches = true) {
  if (!headMatches) return true;
  if (!Number.isInteger(changedFilesCount) || changedFilesCount < 0) return true;
  return changedFilesCount > listedLength;
}

/**
 * Logins of issue comments that look like screenshot-gate waivers: a trusted
 * author association (OWNER/COLLABORATOR/MEMBER), a `UI_OVERRIDE_RE` match
 * with no `UI_CHANGE_CLAIM_RE` match (a comment that also asserts the UI
 * changed is contradictory, not a waiver), and a timestamp after the latest
 * pushed commit — "no UI changes" asserts a state that a later push can void,
 * so stale comments never waive. Unverifiable dates fail closed. The caller
 * still verifies each returned login's write access; this stage only narrows
 * which logins are worth an API call.
 */
function waiverCommentAuthors(comments = [], { latestCommitAt } = {}) {
  const cutoff = Date.parse(latestCommitAt ?? "");
  const authors = new Set();
  for (const comment of comments) {
    const association = comment?.author_association;
    if (
      association !== "OWNER" &&
      association !== "COLLABORATOR" &&
      association !== "MEMBER"
    ) {
      continue;
    }
    if (
      typeof comment?.body !== "string" ||
      !UI_OVERRIDE_RE.test(comment.body) ||
      UI_CHANGE_CLAIM_RE.test(comment.body)
    ) {
      continue;
    }
    const login = comment?.user?.login;
    const at = Date.parse(comment?.created_at ?? "");
    if (!login || !Number.isFinite(cutoff) || !Number.isFinite(at) || at <= cutoff) {
      continue;
    }
    authors.add(login);
  }
  return [...authors];
}

/** Inline code spans (`...`), whose contents GitHub renders literally. */
const INLINE_CODE_RE = /`[^`\n]*`/g;

/**
 * Drop the regions GitHub does not render as Markdown: HTML comments, fenced
 * code blocks, and inline code spans. Image syntax there is literal text, not
 * evidence.
 */
function stripNonRenderedRegions(body) {
  // Fenced code MUST be removed first. GFM treats fence contents as literal
  // text, so a `<!--` inside a fence never opens an HTML comment. Stripping
  // comments first let an unclosed comment-like literal in a code sample run
  // through EOF and swallow the real body after it (opencodex regression).
  // Inline code goes before comments for the same reason: a `<!--` inside
  // backticks is literal text, not a comment opener.
  return body
    .replace(FENCED_CODE_RE, "")
    .replace(INLINE_CODE_RE, "")
    .replace(HTML_COMMENT_RE, "");
}

/**
 * True when the description contains a reference-style image (`![alt][id]` or
 * collapsed `![alt][]`) backed by a matching `[id]: url` definition — GitHub
 * renders only those reference images, so a bare token is not evidence.
 */
function hasRenderableReferenceImage(visible) {
  const definitions = new Set();
  for (const match of visible.matchAll(MARKDOWN_REFERENCE_DEF_RE)) {
    definitions.add(match[1].trim().toLowerCase());
  }
  if (definitions.size === 0) return false;
  for (const match of visible.matchAll(MARKDOWN_REFERENCE_IMAGE_RE)) {
    const id = (match[2] || match[1]).trim().toLowerCase();
    if (id && definitions.has(id)) return true;
  }
  return false;
}

/**
 * True when the rendered description embeds a screenshot image: an inline
 * markdown image, a reference-style image with a definition, or an `<img>`
 * tag with a non-empty `src`. A plain link to an image is not visual evidence.
 */
function hasScreenshotEvidence(body) {
  if (typeof body !== "string") return false;
  const visible = stripNonRenderedRegions(body);
  if (MARKDOWN_IMAGE_RE.test(visible)) return true;
  if (HTML_IMAGE_RE.test(visible)) return true;
  return hasRenderableReferenceImage(visible);
}

/** Collaborator permission levels that may apply the waiver label. */
function authorHasPushPermission(permission) {
  return permission === "admin" || permission === "maintain" || permission === "write";
}

/**
 * Resolve who applied `labelName` from the issue event list, or null when the
 * label was retracted or provenance cannot be proven. Only a `labeled` event
 * as the latest label action counts: a later `unlabeled` event means the
 * waiver was retracted even if a stale PR snapshot still lists the label.
 */
function latestWaiverLabelActor(events, labelName) {
  const relevant = (events ?? [])
    .filter(
      (event) =>
        (event.event === "labeled" || event.event === "unlabeled") &&
        event.label?.name === labelName
    )
    .sort((left, right) => {
      const leftTime = Date.parse(left.created_at ?? "") || 0;
      const rightTime = Date.parse(right.created_at ?? "") || 0;
      if (leftTime !== rightTime) return leftTime - rightTime;
      return Number(left.id ?? 0) - Number(right.id ?? 0);
    });
  const latest = relevant.at(-1);
  if (latest?.event !== "labeled") return null;
  return latest.actor?.login ?? null;
}

/**
 * Pure gate decision, separated from API access so it is testable.
 * Returns `{ status: "pass"|"fail", reason, uiChanged, filesTruncated }`.
 */
function evaluateScreenshotGate({
  changedFilePaths = [],
  filesTruncated = false,
  body = "",
  waivedByComment = false,
  waivedByLabel = false,
}) {
  const uiChanged = uiPathsChanged(changedFilePaths);
  if (!uiChanged && !filesTruncated) {
    return { status: "pass", reason: "no_ui_changes", uiChanged, filesTruncated };
  }
  if (hasScreenshotEvidence(body)) {
    return { status: "pass", reason: "screenshot_present", uiChanged, filesTruncated };
  }
  if (waivedByComment) {
    return { status: "pass", reason: "maintainer_comment_waiver", uiChanged, filesTruncated };
  }
  if (waivedByLabel) {
    return { status: "pass", reason: "label_waiver", uiChanged, filesTruncated };
  }
  return {
    status: "fail",
    reason: filesTruncated && !uiChanged ? "file_list_truncated" : "missing_ui_screenshot",
    uiChanged,
    filesTruncated,
  };
}

/** Job-summary markdown for a failed gate run. */
function buildFailureSummary({
  prNumber,
  uiFiles,
  filesTruncated,
  listedCount,
  reportedCount,
}) {
  const lines = [
    "## Screenshot gate failed",
    "",
    filesTruncated && uiFiles.length === 0
      ? `This pull request's changed-file list could not be proven complete ` +
        `(${reportedCount ?? "?"} reported vs ${listedCount} listed), so UI ` +
        `changes cannot be ruled out — and the description has no embedded image.`
      : `This pull request changes rendered UI files, but the description has no embedded image.`,
    "",
  ];
  if (uiFiles.length > 0) {
    lines.push(`### UI files changed (${uiFiles.length})`, "");
    for (const file of uiFiles) lines.push(`- \`${file}\``);
    lines.push("");
  }
  lines.push(
    "### What to do",
    "",
    `Embed a screenshot of the UI change in the PR description of #${prNumber}.`,
    "Only rendered images count:",
    "",
    "- `![description](url)` or `<img src=\"...\">` — drag the image into the",
    "  description editor and GitHub hosts it.",
    "- CLI/agent uploads with push access go to the orphan `pr-assets` branch,",
    "  linked by commit SHA so the link keeps pointing at the same bytes:",
    "",
    "  ```text",
    `  https://raw.githubusercontent.com/lidge-jun/cli-jaw/<sha>/<pr-or-date-slug>/<name>.png`,
    "  ```",
    "",
    "Never commit screenshot files to the PR branch itself.",
    "",
    "### Waivers",
    "",
    `- A maintainer can apply the \`${UI_SCREENSHOT_WAIVER_LABEL}\` label, or`,
    "- a maintainer can comment that the change does not touch the UI",
    "  (e.g. \"no UI changes in this PR\").",
    "",
    "Both only count when the actor has write/maintain/admin access; a waiver",
    "comment must also postdate the latest pushed commit.",
    ""
  );
  return lines.join("\n");
}

/**
 * Fetch the PR's changed-file list with a head-stability double read: the
 * `pulls.get` count is taken immediately before the paginated list and the
 * head is verified immediately after. A head that moves mid-listing means the
 * list cannot be trusted and the gate fails closed via `filesTruncated`.
 */
async function listChangedFiles(github, { owner, repo, pull_number, core }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data: fileSnapshot } = await github.rest.pulls.get({
      owner,
      repo,
      pull_number,
    });
    const headShaForFiles = fileSnapshot.head?.sha ?? "";
    const listedFiles = await github.paginate(github.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number,
      per_page: 100,
    });
    const { data: fileVerify } = await github.rest.pulls.get({
      owner,
      repo,
      pull_number,
    });
    const headMatches = fileVerify.head?.sha === headShaForFiles;
    if (!headMatches && attempt === 0) {
      core.info("PR head moved while listing changed files; retrying once.");
      continue;
    }
    if (!headMatches) {
      core.warning(
        "PR head moved during changed-file snapshot; treating file list as truncated."
      );
    }
    return {
      paths: listedFiles.map((file) => file.filename).filter(Boolean),
      listedCount: listedFiles.length,
      reportedCount: fileSnapshot.changed_files,
      truncated: isChangedFileListTruncated(
        fileSnapshot.changed_files,
        listedFiles.length,
        headMatches
      ),
    };
  }
  return { paths: [], listedCount: 0, reportedCount: null, truncated: true };
}

/**
 * True when a waiver-style maintainer comment exists AND its author has
 * write/maintain/admin access — the same bar the label waiver is held to.
 * Association alone is not trusted (MEMBER includes read-only org members),
 * and the comment must postdate the latest pushed commit. Any lookup failure
 * fails closed — the comment is ignored rather than trusted.
 */
/**
 * When the PR head commit arrived on GitHub — the honest cutoff for comment
 * waivers. GraphQL `pushedDate` is server-side, so an author-controlled
 * committer date cannot resurrect a stale "no UI changes", and
 * `commits(last: 1)` reads the real head even past the REST `listCommits`
 * 250-commit cap.
 */
async function latestHeadPushAt(github, { owner, repo, pull_number }) {
  const data = await github.graphql(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          commits(last: 1) { nodes { commit { pushedDate committedDate } } }
        }
      }
    }`,
    { owner, repo, number: pull_number }
  );
  const head = data?.repository?.pullRequest?.commits?.nodes?.at(-1)?.commit;
  return head?.pushedDate ?? head?.committedDate ?? null;
}

async function waiverCommentAuthorized(github, {
  owner,
  repo,
  comments,
  latestCommitAt,
  core,
}) {
  for (const login of waiverCommentAuthors(comments, { latestCommitAt })) {
    try {
      const { data: permission } =
        await github.rest.repos.getCollaboratorPermissionLevel({
          owner,
          repo,
          username: login,
        });
      if (authorHasPushPermission(permission.permission)) return true;
      core.info(
        `${login} left a waiver-style comment but has '${permission.permission}' access; ignoring it.`
      );
    } catch (error) {
      core.warning(
        `Could not resolve ${login}'s permission for a waiver-style comment; ignoring it. (${error.message})`
      );
    }
  }
  return false;
}

/**
 * True when `ui-screenshot-waived` is present AND the actor who applied it
 * has write/maintain/admin access. Any lookup failure fails closed — the
 * label is ignored rather than trusted.
 */
async function waiverLabelAuthorized(github, { owner, repo, pull_number, pr, core }) {
  const labelPresent = (pr.labels ?? []).some(
    (label) => label.name === UI_SCREENSHOT_WAIVER_LABEL
  );
  if (!labelPresent) return false;

  let actor = null;
  try {
    const events = await github.paginate(github.rest.issues.listEvents, {
      owner,
      repo,
      issue_number: pull_number,
      per_page: 100,
    });
    actor = latestWaiverLabelActor(events, UI_SCREENSHOT_WAIVER_LABEL);
  } catch (error) {
    core.warning(
      `Could not list issue events for ${UI_SCREENSHOT_WAIVER_LABEL} provenance: ${error.message}`
    );
    return false;
  }
  if (!actor) {
    core.info(
      `${UI_SCREENSHOT_WAIVER_LABEL} is present but its application event could not be verified; ignoring the waiver.`
    );
    return false;
  }

  try {
    const { data: permission } =
      await github.rest.repos.getCollaboratorPermissionLevel({
        owner,
        repo,
        username: actor,
      });
    if (authorHasPushPermission(permission.permission)) return true;
    core.info(
      `${actor} applied ${UI_SCREENSHOT_WAIVER_LABEL} but has '${permission.permission}' access; ignoring the waiver.`
    );
    return false;
  } catch (error) {
    core.warning(
      `Could not resolve ${actor}'s permission level; ignoring the ${UI_SCREENSHOT_WAIVER_LABEL} waiver. (${error.message})`
    );
    return false;
  }
}

/** Workflow entry point called from `.github/workflows/pr-screenshot-gate.yml`. */
async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const pull_number = context.payload.pull_request?.number;
  if (!Number.isSafeInteger(pull_number) || pull_number < 1) {
    core.info("No pull_request payload on this event; skipping.");
    return;
  }

  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number });
  if (pr.state !== "open") {
    core.info(`PR #${pull_number} is ${pr.state}; nothing to gate.`);
    return;
  }

  const files = await listChangedFiles(github, { owner, repo, pull_number, core });
  const uiFiles = files.paths.filter(isUiSurfacePath);

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: pull_number,
    per_page: 100,
  });

  const latestCommitAt = await latestHeadPushAt(github, {
    owner,
    repo,
    pull_number,
  });

  const waivedByComment = await waiverCommentAuthorized(github, {
    owner,
    repo,
    comments,
    latestCommitAt,
    core,
  });

  const waivedByLabel = await waiverLabelAuthorized(github, {
    owner,
    repo,
    pull_number,
    pr,
    core,
  });

  const verdict = evaluateScreenshotGate({
    changedFilePaths: files.paths,
    filesTruncated: files.truncated,
    body: pr.body ?? "",
    waivedByComment,
    waivedByLabel,
  });

  if (verdict.status === "fail") {
    await core.summary
      .addRaw(
        buildFailureSummary({
          prNumber: pull_number,
          uiFiles,
          filesTruncated: files.truncated,
          listedCount: files.listedCount,
          reportedCount: files.reportedCount,
        })
      )
      .write();
    core.setFailed(
      verdict.reason === "file_list_truncated"
        ? "Changed-file list is untrusted and the PR description has no screenshot evidence."
        : "UI files changed without screenshot evidence in the PR description."
    );
    return;
  }
  core.info(`screenshot-gate passed for PR #${pull_number}: ${verdict.reason}`);
}

module.exports = {
  UI_SCREENSHOT_WAIVER_LABEL,
  UI_OVERRIDE_RE,
  UI_CHANGE_CLAIM_RE,
  isPureTestFile,
  isUiSurfacePath,
  uiPathsChanged,
  isChangedFileListTruncated,
  waiverCommentAuthors,
  waiverCommentAuthorized,
  latestHeadPushAt,
  waiverLabelAuthorized,
  stripNonRenderedRegions,
  hasScreenshotEvidence,
  authorHasPushPermission,
  latestWaiverLabelActor,
  evaluateScreenshotGate,
  buildFailureSummary,
  run,
};
