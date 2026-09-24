"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  UI_SCREENSHOT_WAIVER_LABEL,
  isPureTestFile,
  isUiSurfacePath,
  uiPathsChanged,
  isChangedFileListTruncated,
  waiverCommentAuthors,
  waiverCommentAuthorized,
  latestHeadPushAt,
  stripNonRenderedRegions,
  hasScreenshotEvidence,
  authorHasPushPermission,
  latestWaiverLabelActor,
  evaluateScreenshotGate,
  buildFailureSummary,
} = require("./pr-screenshot.cjs");

describe("isPureTestFile", () => {
  it("rejects test segments and test-file names", () => {
    for (const p of [
      "public/js/foo.test.ts",
      "public/js/foo.spec.ts",
      "public/tests/render.ts",
      "public/js/__tests__/x.ts",
      "electron/src/preload/__mocks__/ipc.ts",
      "public/fixtures/state.json",
    ]) {
      assert.equal(isPureTestFile(p), true, p);
    }
  });

  it("keeps ordinary source files", () => {
    for (const p of [
      "public/js/ui.ts",
      "public/theme-test.html",
      "electron/src/preload/index.ts",
      "src/server.ts",
    ]) {
      assert.equal(isPureTestFile(p), false, p);
    }
  });
});

describe("isUiSurfacePath", () => {
  it("arms on public/ frontend files", () => {
    for (const p of [
      "public/index.html",
      "public/js/ui.ts",
      "public/manager/index.html",
      "public/locales/ko.json",
      "public/sw.js",
      "public/theme-test.html",
    ]) {
      assert.equal(isUiSurfacePath(p), true, p);
    }
  });

  it("arms on electron renderer-surface files only", () => {
    for (const p of [
      "electron/src/preload/index.ts",
      "electron/src/preload/metrics.ts",
      "electron/src/renderer/app.tsx",
      "electron/window.html",
    ]) {
      assert.equal(isUiSurfacePath(p), true, p);
    }
  });

  it("does not arm on main-process or build files", () => {
    for (const p of [
      "electron/src/main/index.ts",
      "electron/src/main/lib/tray-manager.ts",
      "electron/build/icon.png",
      "electron/electron.vite.config.ts",
      "electron/package.json",
      "src/routes/code-native.ts",
      "tests/unit/foo.test.ts",
      "docs/guide.md",
    ]) {
      assert.equal(isUiSurfacePath(p), false, p);
    }
  });

  it("test files inside the UI surface do not arm the gate", () => {
    assert.equal(isUiSurfacePath("public/js/ui.test.ts"), false);
    assert.equal(uiPathsChanged(["src/x.ts", "public/js/ui.test.ts"]), false);
    assert.equal(uiPathsChanged(["src/x.ts", "public/js/ui.ts"]), true);
  });
});

describe("isChangedFileListTruncated", () => {
  it("fails closed on head mismatch or missing counts", () => {
    assert.equal(isChangedFileListTruncated(3, 3, false), true);
    assert.equal(isChangedFileListTruncated(null, 3), true);
    assert.equal(isChangedFileListTruncated(3.5, 3), true);
    assert.equal(isChangedFileListTruncated(-1, 3), true);
  });

  it("fails closed when the list returned fewer files than reported", () => {
    assert.equal(isChangedFileListTruncated(3001, 3000), true);
    assert.equal(isChangedFileListTruncated(4, 3), true);
  });

  it("passes when the listed count covers the reported count", () => {
    assert.equal(isChangedFileListTruncated(3, 3), false);
    assert.equal(isChangedFileListTruncated(0, 0), false);
  });
});

describe("waiverCommentAuthors", () => {
  const comment = (
    body,
    { author_association = "MEMBER", login = "maintainer", created_at = "2026-01-02T00:00:00Z" } = {}
  ) => ({ body, author_association, created_at, user: { login } });
  const cutoff = { latestCommitAt: "2026-01-01T00:00:00Z" };

  it("collects maintainers whose comment asserts no UI change", () => {
    for (const body of [
      "No UI changes in this PR.",
      "not a ui change",
      "doesn't touch the gui",
      "no changes to the ui",
      "doesn't really change the ui",
      "this doesn't change the ui",
      "the ui is unchanged",
      "gui untouched",
      "without ui changes",
      "No rendered UI changes",
      "UI 변경 없음",
      "UI 변경이 없음",
      "UI 변경 없습니다",
    ]) {
      assert.deepEqual(waiverCommentAuthors([comment(body)], cutoff), ["maintainer"], body);
    }
  });

  it("rejects comments that report or demand a screenshot instead of asserting no UI change", () => {
    for (const body of [
      "without a UI screenshot",
      "Do not ship the ui without a screenshot.",
      "I do not see a ui screenshot, please add one",
      "no screenshot for ui changes",
      "no ui",
    ]) {
      assert.deepEqual(waiverCommentAuthors([comment(body)], cutoff), [], body);
    }
  });

  it("rejects comments that assert the UI changed somewhere", () => {
    for (const body of [
      "do not forget: this changes the ui",
      "I have no idea if this changes the ui",
      "doesn't change the API, only the ui",
      "no, this changes the ui",
      "no ui changes, but it still touches the gui",
      "UI 변경 없이 스크린샷을 빼면 안 됩니다",
      "UI 변경 없는 PR이 아닙니다",
      "UI 변경 있음",
    ]) {
      assert.deepEqual(waiverCommentAuthors([comment(body)], cutoff), [], body);
    }
  });

  it("rejects non-maintainer comments", () => {
    for (const association of ["CONTRIBUTOR", "NONE"]) {
      assert.deepEqual(
        waiverCommentAuthors([comment("no ui changes", { author_association: association })], cutoff),
        []
      );
    }
  });

  it("rejects negations across a sentence boundary", () => {
    assert.deepEqual(
      waiverCommentAuthors(
        [comment("This does not change the API. Please add a ui screenshot.")],
        cutoff
      ),
      []
    );
  });

  it("rejects non-negated ui mentions", () => {
    assert.deepEqual(
      waiverCommentAuthors([comment("this touches ui but only the config")], cutoff),
      []
    );
  });

  it("rejects comments that predate the latest pushed commit or carry unusable dates", () => {
    assert.deepEqual(
      waiverCommentAuthors(
        [comment("no UI changes", { created_at: "2026-01-01T00:00:00Z" })],
        cutoff
      ),
      []
    );
    assert.deepEqual(
      waiverCommentAuthors([comment("no UI changes")], { latestCommitAt: "not-a-date" }),
      []
    );
  });

  it("rejects comments without a usable login", () => {
    const anonymous = comment("no UI changes");
    delete anonymous.user;
    assert.deepEqual(waiverCommentAuthors([anonymous], cutoff), []);
  });
});

describe("latestHeadPushAt", () => {
  it("returns the head commit's server-side pushedDate", async () => {
    const github = {
      graphql: async () => ({
        repository: {
          pullRequest: {
            commits: {
              nodes: [{ commit: { pushedDate: "2026-01-03T00:00:00Z", committedDate: "2026-01-01T00:00:00Z" } }],
            },
          },
        },
      }),
    };
    assert.equal(
      await latestHeadPushAt(github, { owner: "o", repo: "r", pull_number: 1 }),
      "2026-01-03T00:00:00Z"
    );
  });

  it("falls back to committedDate and then null", async () => {
    const noPush = {
      graphql: async () => ({
        repository: { pullRequest: { commits: { nodes: [{ commit: { committedDate: "2026-01-01T00:00:00Z" } }] } } },
      }),
    };
    assert.equal(
      await latestHeadPushAt(noPush, { owner: "o", repo: "r", pull_number: 1 }),
      "2026-01-01T00:00:00Z"
    );
    const empty = { graphql: async () => ({ repository: { pullRequest: { commits: { nodes: [] } } } }) };
    assert.equal(
      await latestHeadPushAt(empty, { owner: "o", repo: "r", pull_number: 1 }),
      null
    );
  });
});

describe("waiverCommentAuthorized", () => {
  const cutoff = { latestCommitAt: "2026-01-01T00:00:00Z" };
  const comment = (login) => ({
    body: "no UI changes",
    author_association: "MEMBER",
    created_at: "2026-01-02T00:00:00Z",
    user: { login },
  });
  const quiet = { info: () => {}, warning: () => {} };
  const githubWith = (permissions) => ({
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async ({ username }) => ({
          data: { permission: permissions[username] },
        }),
      },
    },
  });

  it("waives when the comment author has write access", async () => {
    assert.equal(
      await waiverCommentAuthorized(githubWith({ alice: "write" }), {
        owner: "o",
        repo: "r",
        comments: [comment("alice")],
        ...cutoff,
        core: quiet,
      }),
      true
    );
  });

  it("ignores read-only members and permission lookup failures", async () => {
    assert.equal(
      await waiverCommentAuthorized(githubWith({ bob: "read" }), {
        owner: "o",
        repo: "r",
        comments: [comment("bob")],
        ...cutoff,
        core: quiet,
      }),
      false
    );
    const failing = {
      rest: {
        repos: {
          getCollaboratorPermissionLevel: async () => {
            throw new Error("404");
          },
        },
      },
    };
    assert.equal(
      await waiverCommentAuthorized(failing, {
        owner: "o",
        repo: "r",
        comments: [comment("bob")],
        ...cutoff,
        core: quiet,
      }),
      false
    );
  });
});

describe("hasScreenshotEvidence", () => {
  it("accepts inline markdown and html images", () => {
    assert.equal(hasScreenshotEvidence("look\n\n![shot](https://x/i.png)"), true);
    assert.equal(hasScreenshotEvidence('<img src="https://x/i.png" width="400">'), true);
  });

  it("accepts a reference-style image backed by a definition", () => {
    assert.equal(
      hasScreenshotEvidence("![shot][cap]\n\n[cap]: https://x/i.png"),
      true
    );
    assert.equal(hasScreenshotEvidence("![shot][]\n\n[shot]: https://x/i.png"), true);
  });

  it("rejects a reference-style image without a definition", () => {
    assert.equal(hasScreenshotEvidence("![shot][cap]"), false);
  });

  it("ignores images inside code fences, inline code, and HTML comments", () => {
    assert.equal(
      hasScreenshotEvidence("```\n![shot](https://x/i.png)\n```"),
      false
    );
    assert.equal(
      hasScreenshotEvidence("<!-- ![shot](https://x/i.png) -->"),
      false
    );
    assert.equal(
      hasScreenshotEvidence("`![shot](https://x/i.png)`"),
      false
    );
    assert.equal(
      hasScreenshotEvidence("run `![shot](https://x/i.png)` in the body"),
      false
    );
  });

  it("keeps real evidence after a fenced sample containing a comment marker", () => {
    const body =
      "```\n<!-- not a comment inside a fence\n```\n\n![shot](https://x/i.png)";
    assert.equal(hasScreenshotEvidence(body), true);
  });

  it("rejects plain links and non-strings", () => {
    assert.equal(hasScreenshotEvidence("[shot](https://x/i.png)"), false);
    assert.equal(hasScreenshotEvidence(undefined), false);
    assert.equal(hasScreenshotEvidence(null), false);
  });
});

describe("stripNonRenderedRegions", () => {
  it("strips fences before comments", () => {
    const body = "a\n```\n<!--\n```\nb";
    assert.equal(stripNonRenderedRegions(body), "a\nb");
  });

  it("strips inline code before comments so a comment marker inside code is literal", () => {
    assert.equal(stripNonRenderedRegions("`<!--` ![shot](https://x/i.png)"), " ![shot](https://x/i.png)");
  });
});

describe("authorHasPushPermission", () => {
  it("accepts write-level access and rejects weaker levels", () => {
    for (const p of ["admin", "maintain", "write"]) {
      assert.equal(authorHasPushPermission(p), true, p);
    }
    for (const p of ["read", "triage", "none", undefined]) {
      assert.equal(authorHasPushPermission(p), false, p);
    }
  });
});

describe("latestWaiverLabelActor", () => {
  const ev = (event, name, actor, created_at, id) => ({
    event,
    label: { name },
    actor: { login: actor },
    created_at,
    id,
  });

  it("returns the actor of the latest labeled event", () => {
    const actor = latestWaiverLabelActor(
      [
        ev("unlabeled", UI_SCREENSHOT_WAIVER_LABEL, "a", "2026-01-01T00:00:00Z", 1),
        ev("labeled", UI_SCREENSHOT_WAIVER_LABEL, "b", "2026-01-02T00:00:00Z", 2),
      ],
      UI_SCREENSHOT_WAIVER_LABEL
    );
    assert.equal(actor, "b");
  });

  it("returns null when the latest action unlabeled the waiver", () => {
    const actor = latestWaiverLabelActor(
      [
        ev("labeled", UI_SCREENSHOT_WAIVER_LABEL, "a", "2026-01-01T00:00:00Z", 1),
        ev("unlabeled", UI_SCREENSHOT_WAIVER_LABEL, "a", "2026-01-02T00:00:00Z", 2),
      ],
      UI_SCREENSHOT_WAIVER_LABEL
    );
    assert.equal(actor, null);
  });

  it("ignores events for other labels", () => {
    const actor = latestWaiverLabelActor(
      [
        ev("labeled", "other-label", "a", "2026-01-03T00:00:00Z", 3),
        ev("labeled", UI_SCREENSHOT_WAIVER_LABEL, "b", "2026-01-01T00:00:00Z", 1),
      ],
      UI_SCREENSHOT_WAIVER_LABEL
    );
    assert.equal(actor, "b");
  });
});

describe("evaluateScreenshotGate", () => {
  const uiChange = { changedFilePaths: ["public/js/ui.ts"] };

  it("passes backend-only changes", () => {
    const verdict = evaluateScreenshotGate({ changedFilePaths: ["src/server.ts"] });
    assert.equal(verdict.status, "pass");
    assert.equal(verdict.reason, "no_ui_changes");
  });

  it("fails a UI change without screenshot evidence", () => {
    const verdict = evaluateScreenshotGate({ ...uiChange, body: "tweaked the panel" });
    assert.equal(verdict.status, "fail");
    assert.equal(verdict.reason, "missing_ui_screenshot");
  });

  it("passes a UI change with embedded evidence", () => {
    const verdict = evaluateScreenshotGate({
      ...uiChange,
      body: "new panel\n\n![panel](https://x/p.png)",
    });
    assert.equal(verdict.status, "pass");
    assert.equal(verdict.reason, "screenshot_present");
  });

  it("fails closed when the file list is truncated", () => {
    const verdict = evaluateScreenshotGate({
      changedFilePaths: ["src/server.ts"],
      filesTruncated: true,
    });
    assert.equal(verdict.status, "fail");
    assert.equal(verdict.reason, "file_list_truncated");
  });

  it("passes on an authorized maintainer comment or label waiver", () => {
    assert.equal(
      evaluateScreenshotGate({ ...uiChange, waivedByComment: true }).status,
      "pass"
    );
    assert.equal(
      evaluateScreenshotGate({ ...uiChange, waivedByLabel: true }).status,
      "pass"
    );
  });
});

describe("buildFailureSummary", () => {
  it("lists UI files and the pr-assets upload path", () => {
    const summary = buildFailureSummary({
      prNumber: 42,
      uiFiles: ["public/js/ui.ts"],
      filesTruncated: false,
      listedCount: 1,
      reportedCount: 1,
    });
    assert.match(summary, /Screenshot gate failed/);
    assert.match(summary, /public\/js\/ui\.ts/);
    assert.match(summary, /pr-assets/);
    assert.match(summary, /ui-screenshot-waived/);
  });

  it("explains the truncation failure mode", () => {
    const summary = buildFailureSummary({
      prNumber: 42,
      uiFiles: [],
      filesTruncated: true,
      listedCount: 3000,
      reportedCount: 3100,
    });
    assert.match(summary, /could not be proven complete/);
  });
});
