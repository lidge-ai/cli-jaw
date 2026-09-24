"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  UI_SCREENSHOT_WAIVER_LABEL,
  isPureTestFile,
  isUiSurfacePath,
  uiPathsChanged,
  isChangedFileListTruncated,
  hasUiOverride,
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

describe("hasUiOverride", () => {
  const comment = (body, author_association = "MEMBER") => ({ body, author_association });

  it("accepts a maintainer negation comment", () => {
    assert.equal(
      hasUiOverride({ comments: [comment("No UI changes in this PR.", "MEMBER")] }),
      true
    );
    assert.equal(
      hasUiOverride({ comments: [comment("doesn't touch the gui", "COLLABORATOR")] }),
      true
    );
  });

  it("rejects non-maintainer comments", () => {
    assert.equal(
      hasUiOverride({ comments: [comment("no ui changes", "CONTRIBUTOR")] }),
      false
    );
    assert.equal(
      hasUiOverride({ comments: [comment("no ui changes", "NONE")] }),
      false
    );
  });

  it("rejects negations across a sentence boundary", () => {
    assert.equal(
      hasUiOverride({
        comments: [comment("This does not change the API. Please add a ui screenshot.")],
      }),
      false
    );
  });

  it("rejects non-negated ui mentions", () => {
    assert.equal(
      hasUiOverride({ comments: [comment("this touches ui but only the config")] }),
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

  it("ignores images inside code fences and HTML comments", () => {
    assert.equal(
      hasScreenshotEvidence("```\n![shot](https://x/i.png)\n```"),
      false
    );
    assert.equal(
      hasScreenshotEvidence("<!-- ![shot](https://x/i.png) -->"),
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

  it("passes on a maintainer override comment or authorized label", () => {
    assert.equal(
      evaluateScreenshotGate({
        ...uiChange,
        comments: [{ body: "no UI changes", author_association: "OWNER" }],
      }).status,
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
