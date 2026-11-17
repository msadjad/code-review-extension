import { describe, expect, it } from "vitest";
import { allHunks, hunkRange, isLineInDiff, parseDiff, renderDiffForPrompt } from "../src/diff";
import { addUnexplainedSteps, buildTour, normalizeOutline, normalizeRisks, stripFence, uncoveredHunks } from "../src/tour";
import { buildReviewPayload, conversationTurns } from "../src/notes";
import { findingsForRange, markAgreement, normalizeFindings, sortFindings } from "../src/reviewers";
import { parseLooseJson } from "../src/agents";
import { md } from "../webview/markdown";
import { fullyReadFiles, planViewedSync } from "../src/viewed";

const DIFF = `diff --git a/src/refund.ts b/src/refund.ts
index 1111111..2222222 100644
--- a/src/refund.ts
+++ b/src/refund.ts
@@ -10,7 +10,9 @@ export function refund(order: Order) {
   const amount = order.total;
   if (order.refunded) {
-    return;
+    throw new AlreadyRefunded(order.id);
   }
+  audit.log("refund", order.id);
+
   gateway.refund(order.paymentId, amount);
   order.refunded = true;
 }
@@ -40,6 +42,5 @@ export function cancel(order: Order) {
   order.status = "cancelled";
   notify(order);
-  legacyHook(order);
   return order;
 }

diff --git a/src/audit.ts b/src/audit.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/audit.ts
@@ -0,0 +1,3 @@
+export const audit = {
+  log(kind: string, id: string) {},
+};
diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const legacy = true;
--- not a header, just a removed line
diff --git a/src/a.ts b/src/b.ts
similarity index 90%
rename from src/a.ts
rename to src/b.ts
index 5555555..6666666 100644
--- a/src/a.ts
+++ b/src/b.ts
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
diff --git a/logo.png b/logo.png
index 7777777..8888888 100644
Binary files a/logo.png and b/logo.png differ
`;

const files = parseDiff(DIFF);

describe("parseDiff", () => {
  it("reads files, statuses and renames", () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/refund.ts", "modified"],
      ["src/audit.ts", "added"],
      ["src/old.ts", "deleted"],
      ["src/b.ts", "renamed"],
      ["logo.png", "modified"],
    ]);
    expect(files[3].oldPath).toBe("src/a.ts");
    expect(files[4].binary).toBe(true);
    expect(files[4].hunks).toHaveLength(0);
  });

  it("numbers hunks globally and tracks new-file line numbers", () => {
    expect(allHunks(files).map((h) => h.id)).toEqual(["h1", "h2", "h3", "h4", "h5"]);
    const [h1, h2] = files[0].hunks;
    expect(h1.addedLines).toEqual([12, 14, 15]);
    expect(h1.removedCount).toBe(1);
    expect(h2.addedLines).toEqual([]);
    expect(h2.removedCount).toBe(1);
  });

  it("keeps removed lines that look like file headers inside the hunk", () => {
    const h = files[2].hunks[0];
    expect(h.removedCount).toBe(2);
    expect(files[2].path).toBe("src/old.ts");
  });

  it("computes the range to show for each kind of hunk", () => {
    expect(hunkRange(files[0].hunks[0])).toEqual({ start: 12, end: 15 });
    // pure deletion: the line now sitting where the removed line was
    expect(hunkRange(files[0].hunks[1])).toEqual({ start: 44, end: 44 });
    expect(hunkRange(files[2].hunks[0], true)).toEqual({ start: 1, end: 2 });
  });

  it("knows which lines GitHub accepts comments on", () => {
    expect(isLineInDiff(files, "src/refund.ts", 12)).toBe(true);
    expect(isLineInDiff(files, "src/refund.ts", 18)).toBe(true);
    expect(isLineInDiff(files, "src/refund.ts", 19)).toBe(false);
    expect(isLineInDiff(files, "src/refund.ts", 30)).toBe(false);
    expect(isLineInDiff(files, "src/old.ts", 1)).toBe(false);
  });

  it("renders line numbers for the agent", () => {
    const text = renderDiffForPrompt(files);
    expect(text).toContain("=== FILE src/refund.ts (modified) ===");
    expect(text).toContain("--- hunk h1: new lines 12-15 (+3 -1) ---");
    expect(text).toContain('+    12      throw new AlreadyRefunded(order.id);');
    expect(text).toContain("--- hunk h4: old lines 1-2");
    expect(text).toContain("src/b.ts (renamed from src/a.ts)");
  });
});

describe("tour", () => {
  const raw = {
    title: "Refund audit",
    summary: "Adds auditing.",
    riskAreas: ["Double refunds"],
    diagrams: [{ id: "d1", title: "Flow", kind: "flow", mermaid: "```mermaid\nflowchart TD\nA-->B\n```", caption: "c" }],
    steps: [
      { section: "Core", title: "Reject double refunds", file: "./src/refund.ts", startLine: 10, endLine: 16, hunkIds: [], explanation: "e", why: "w", watchFor: ["x"], diagramIds: ["d1", "nope"] },
      { section: "Core", title: "Audit log", file: "src/audit.ts", startLine: 0, endLine: 0, hunkIds: ["h3"], explanation: "e", why: "", watchFor: [], diagramIds: [] },
      { section: "Core", title: "Bogus hunk", file: "", startLine: 1, endLine: 1, hunkIds: ["h99"], explanation: "", why: "", watchFor: [], diagramIds: [] },
    ],
    checkQuestions: [{ question: "q", answer: "a" }],
  };
  const tour = buildTour(raw, files, "fallback");

  it("normalizes steps and infers covered hunks from line overlap", () => {
    expect(tour.steps).toHaveLength(2);
    expect(tour.steps[0].file).toBe("src/refund.ts");
    expect(tour.steps[0].hunkIds).toEqual(["h1"]);
    expect(tour.steps[0].diagramIds).toEqual(["d1"]);
    expect(tour.steps[1]).toMatchObject({ startLine: 1, endLine: 3, hunkIds: ["h3"] });
    expect(tour.diagrams[0].mermaid).toBe("flowchart TD\nA-->B");
  });

  it("never lets a change go unexplained silently", () => {
    expect(uncoveredHunks(tour.steps, files).map((h) => h.id)).toEqual(["h2", "h4", "h5"]);
    const steps = addUnexplainedSteps(tour.steps, files);
    expect(uncoveredHunks(steps, files)).toEqual([]);
    const added = steps.filter((s) => s.unexplained);
    expect(added.map((s) => [s.file, s.startLine])).toEqual([
      ["src/refund.ts", 44],
      ["src/old.ts", 1],
      ["src/b.ts", 2],
    ]);
  });

  it("assigns every file to exactly one outline section", () => {
    const outline = normalizeOutline(
      { title: "t", summary: "s", sections: [{ title: "A", purpose: "", files: ["src/refund.ts", "ghost.ts"] }, { title: "B", purpose: "", files: ["src/refund.ts"] }] },
      files,
      "f",
    );
    expect(outline.sections.map((s) => s.title)).toEqual(["A", "Other changes"]);
    expect(outline.sections.flatMap((s) => s.files).sort()).toEqual(files.map((f) => f.path).sort());
  });

  it("reads risks in the old string form and the new form with a drafted comment", () => {
    const risks = normalizeRisks(
      [
        "Double refunds",
        { risk: "Audit runs before the refund", file: "./src/refund.ts", line: 14, comment: "Could we log after the gateway call succeeds?" },
        { risk: "Nothing concrete", file: "", line: 0, comment: "" },
        { risk: "Draft without a place", file: "", line: 0, comment: "Please fix" },
        { risk: "  ", file: "x", line: 1, comment: "dropped" },
      ],
      files,
    );
    expect(risks).toEqual([
      { text: "Double refunds", file: "", line: 0, comment: "" },
      { text: "Audit runs before the refund", file: "src/refund.ts", line: 14, comment: "Could we log after the gateway call succeeds?" },
      { text: "Nothing concrete", file: "", line: 0, comment: "" },
      { text: "Draft without a place", file: "", line: 0, comment: "" },
    ]);
    expect(tour.riskAreas).toEqual([{ text: "Double refunds", file: "", line: 0, comment: "" }]);
  });

  it("strips fences only when present", () => {
    expect(stripFence("erDiagram\nA ||--o{ B : has")).toBe("erDiagram\nA ||--o{ B : has");
  });
});

describe("review payload", () => {
  it("puts in-diff notes inline and the rest in the body", () => {
    const payload = buildReviewPayload(
      [
        { id: "1", stepId: "s1", file: "src/refund.ts", line: 12, body: " Should this be idempotent? " },
        { id: "2", stepId: "s1", file: "src/refund.ts", line: 30, body: "Unrelated but odd" },
        { id: "3", stepId: "", file: "src/refund.ts", line: 12, body: "   " },
      ],
      files,
      "REQUEST_CHANGES",
      "abc123",
      "Overall fine.",
    );
    expect(payload.comments).toEqual([{ path: "src/refund.ts", line: 12, side: "RIGHT", body: "Should this be idempotent?" }]);
    expect(payload.body).toBe("Overall fine.\n\n- `src/refund.ts:30`: Unrelated but odd");
    expect(payload.event).toBe("REQUEST_CHANGES");
    expect(payload.commit_id).toBe("abc123");
  });
});

describe("reviewers", () => {
  const claude = normalizeFindings(
    { findings: [
      { file: "src/refund.ts", line: 12, endLine: 12, severity: "major", title: "Throws inside a batch", body: "b" },
      { file: "src/audit.ts", line: 2, endLine: 2, severity: "minor", title: "No-op log", body: "b" },
      { file: "x", line: 1, endLine: 1, severity: "minor", title: "  ", body: "dropped" },
    ] },
    "claude",
    files,
  );
  const codex = normalizeFindings(
    { findings: [{ file: "./src/refund.ts", line: 13, endLine: 15, severity: "weird", title: "Audit before refund", body: "b" }] },
    "codex",
    files,
  );
  const all = sortFindings(markAgreement([...claude, ...codex]));

  it("normalizes agent output", () => {
    expect(claude).toHaveLength(2);
    expect(codex[0]).toMatchObject({ file: "src/refund.ts", severity: "minor", id: "codex-1" });
  });

  it("marks places two agents flagged independently and sorts them first", () => {
    expect(all.map((f) => [f.id, f.agreedBy])).toEqual([
      ["claude-1", ["codex"]],
      ["codex-1", ["claude"]],
      ["claude-2", []],
    ]);
  });

  it("attaches findings to the step that shows those lines", () => {
    expect(findingsForRange(all, "src/refund.ts", 10, 16).map((f) => f.id)).toEqual(["claude-1", "codex-1"]);
    expect(findingsForRange(all, "src/refund.ts", 40, 46)).toEqual([]);
  });
});

describe("helpers", () => {
  it("parses JSON wrapped in prose or fences", () => {
    expect(parseLooseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseLooseJson('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseLooseJson('result {"a":3} done')).toEqual({ a: 3 });
    expect(parseLooseJson("nope")).toBeUndefined();
  });

  it("renders markdown safely", () => {
    expect(md("Uses `a<b>` and **bold**")).toBe("<p>Uses <code>a&lt;b&gt;</code> and <strong>bold</strong></p>");
    expect(md("- one\n- two\n\nafter")).toBe("<ul><li>one</li><li>two</li></ul><p>after</p>");
    expect(md("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(md("**Amount (e.g. `10.5`):** bad")).toBe("<p><strong>Amount (e.g. <code>10.5</code>):</strong> bad</p>");
    expect(md("```\nx < y\n```")).toBe("<pre>x &lt; y</pre>");
  });
});

describe("GitHub viewed sync", () => {
  const steps = [
    { id: "s1", file: "a.ts" },
    { id: "s2", file: "a.ts" },
    { id: "s3", file: "b.ts" },
  ];

  it("counts a file as read only when every chunk is read", () => {
    expect([...fullyReadFiles(steps, ["s1", "s3"])]).toEqual(["b.ts"]);
    expect([...fullyReadFiles(steps, ["s1", "s2", "s3"])].sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("marks newly read files and skips ones already viewed", () => {
    const plan = planViewedSync(new Set(["a.ts", "b.ts"]), new Set(), new Set(["b.ts"]));
    expect(plan).toEqual({ mark: ["a.ts"], unmark: [] });
  });

  it("unmarks only files that stopped being read here", () => {
    const plan = planViewedSync(new Set(), new Set(["a.ts"]), new Set(["a.ts", "c.ts"]));
    expect(plan).toEqual({ mark: [], unmark: ["a.ts"] });
  });
});

describe("conversation turns", () => {
  it("lists the question, follow-ups and drafted comments in order", () => {
    const turns = conversationTurns({
      id: "a1", stepId: "s1", file: "a.ts", startLine: 1, endLine: 2, question: "", answer: "It does X.", pending: false,
      more: [
        { kind: "answer", question: "Why?", answer: "Because Y." },
        { kind: "comment", question: "", answer: "Please tighten this." },
      ],
    });
    expect(turns.map((t) => t.who)).toEqual(["you", "guide", "you", "guide", "you", "comment"]);
    expect(turns[0].text).toBe("Explain this code");
    expect(turns[5].text).toBe("Please tighten this.");
  });
});
