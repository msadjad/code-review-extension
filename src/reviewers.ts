import { AgentConfig, AgentName, runAgent } from "./agents";
import { DiffFile, renderDiffForPrompt } from "./diff";
import { ChangeContext } from "./generator";

export type Severity = "blocker" | "major" | "minor" | "question";

export interface Finding {
  id: string;
  agent: AgentName;
  file: string;
  line: number;
  endLine: number;
  severity: Severity;
  title: string;
  body: string;
  /** Other agents that independently flagged the same place. */
  agreedBy: AgentName[];
}

export interface ReviewerState {
  agent: AgentName;
  status: "running" | "done" | "failed" | "unavailable";
  verdict?: string;
  error?: string;
  count?: number;
}

const str = { type: "string" };
export const findingsSchema = {
  type: "object",
  properties: {
    verdict: str,
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: str,
          line: { type: "integer" },
          endLine: { type: "integer" },
          severity: { type: "string", enum: ["blocker", "major", "minor", "question"] },
          title: str,
          body: str,
        },
        required: ["file", "line", "endLine", "severity", "title", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "findings"],
  additionalProperties: false,
};

export function reviewPrompt(ctx: ChangeContext): string {
  return [
    "You are an independent code reviewer. Review the change below for real problems: incorrect behaviour, broken business rules, missed edge cases, data loss or corruption, security issues, race conditions, bad migrations, and missing tests for risky logic.",
    "You are in the repository at the changed version. Read the surrounding code (callers, callees, models, tests) before you judge; verify each suspicion against the code and drop it if the code already handles it. You may only read; do not modify anything.",
    `Report only findings you would stand behind in a review. No style nits, no praise, no restating the diff. An empty list is a valid answer.
- "file": path exactly as in the FILE header. "line"/"endLine": the new-file line numbers printed in the diff where the problem is.
- "severity": "blocker" (must not merge), "major" (should be fixed), "minor" (worth fixing), "question" (you could not verify something the author should confirm).
- "title": one short sentence naming the problem.
- "body": what goes wrong, under which input or state, and what the consequence is, in plain language a reviewer new to this codebase can follow. Suggest the fix when it is clear.
- "verdict": two or three sentences with your overall judgement of the change.`,
    `Change: ${ctx.title}`,
    ctx.description.trim() ? `Description from the author:\n${ctx.description.trim()}` : "",
    `Base commit: ${ctx.baseSha}.`,
    "The diff, with line numbers:",
    renderDiffForPrompt(ctx.files),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const SEVERITIES: Severity[] = ["blocker", "major", "minor", "question"];

export function normalizeFindings(raw: unknown, agent: AgentName, files: DiffFile[]): Finding[] {
  const list = (raw as any)?.findings;
  if (!Array.isArray(list)) return [];
  const out: Finding[] = [];
  for (const f of list) {
    if (!f || typeof f !== "object" || typeof f.title !== "string" || !f.title.trim()) continue;
    const path = String(f.file ?? "").replace(/^\.\//, "");
    const file = files.find((x) => x.path === path || x.oldPath === path);
    const line = Math.max(1, Math.floor(Number(f.line)) || 1);
    const endLine = Math.max(line, Math.floor(Number(f.endLine)) || line);
    out.push({
      id: `${agent}-${out.length + 1}`,
      agent,
      file: file?.path ?? path,
      line,
      endLine,
      severity: SEVERITIES.includes(f.severity) ? f.severity : "minor",
      title: f.title.trim(),
      body: String(f.body ?? "").trim(),
      agreedBy: [],
    });
  }
  return out;
}

/** How close two findings must be (in lines) to count as the same place. */
const AGREEMENT_SLACK = 1;

/**
 * Marks findings whose lines a different agent also flagged. This is a match on location,
 * not on meaning: two agents can flag the same lines for different reasons.
 */
export function markAgreement(findings: Finding[]): Finding[] {
  return findings.map((f) => {
    const others = new Set<AgentName>();
    for (const g of findings) {
      if (g.agent === f.agent || g.file !== f.file) continue;
      if (g.line <= f.endLine + AGREEMENT_SLACK && g.endLine >= f.line - AGREEMENT_SLACK) others.add(g.agent);
    }
    return { ...f, agreedBy: [...others] };
  });
}

const RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, question: 3 };

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      b.agreedBy.length - a.agreedBy.length ||
      RANK[a.severity] - RANK[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}

export function findingsForRange(findings: Finding[], file: string, start: number, end: number): Finding[] {
  return findings.filter((f) => f.file === file && f.line <= end + 2 && f.endLine >= start - 2);
}

export async function runReviewer(
  agent: AgentName,
  ctx: ChangeContext,
  opts: { config: AgentConfig; cwd: string; signal?: AbortSignal; onProgress?: (line: string) => void },
): Promise<{ verdict: string; findings: Finding[] }> {
  const res = await runAgent(
    { agent, prompt: reviewPrompt(ctx), cwd: opts.cwd, schema: findingsSchema, signal: opts.signal, onProgress: opts.onProgress },
    opts.config,
  );
  return {
    verdict: String((res.structured as any)?.verdict ?? ""),
    findings: normalizeFindings(res.structured, agent, ctx.files),
  };
}
