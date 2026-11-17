import { AgentConfig, AgentName, runAgent } from "./agents";
import { DiffFile, diffStats, renderDiffForPrompt } from "./diff";
import {
  Diagram,
  Risk,
  normalizeRisks,
  Step,
  Tour,
  addUnexplainedSteps,
  buildTour,
  normalizeOutline,
  normalizeSteps,
  outlineSchema,
  sectionStepsSchema,
  stripFence,
  tourSchema,
  uncoveredHunks,
} from "./tour";

export interface ChangeContext {
  /** PR title or branch name. */
  title: string;
  /** PR description, empty for local branches. */
  description: string;
  baseSha: string;
  files: DiffFile[];
}

export interface GenerateOptions {
  agent: AgentName;
  config: AgentConfig;
  cwd: string;
  singlePassMaxChars: number;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
}

const READER = `You are preparing a guided code review for a senior engineer who must review this change but does NOT know this codebase or its business domain. They read code fluently. They need to understand what the change means for the product and the system, so that they can judge whether it is right.`;

const EXPLAIN_RULES = `How to write explanations:
- The reader can read code. They are looking at the chunk while they read your text, so anything they could work out from the chunk alone is wasted on them. Your job is to supply what the chunk does NOT show.
- The test for every sentence: could someone write it having seen only this chunk? If yes, delete it. "Checks that the ids are present, the dates are valid and the limit is at most 100" fails the test; it is the code read aloud. "This runs when a customer opens the action drawer on a market cluster; the 90-day cap exists because the query behind it scans the raw events table" passes, because none of it is in the chunk.
- What does pass the test, and what you must go and find in the repository before writing:
  - Where it sits: which user action, screen, job or API call reaches this code, through which callers, and what the result is used for afterwards.
  - What the domain words mean: the business concepts behind the names (what a "cluster", a "market action" or a "store credit" actually is in this product), in a clause, the first time they appear.
  - Why it is this way: the reason behind constants, limits, orderings and special cases, taken from callers, the schema, the query it protects, tests, commit history or the change description. If you cannot find the reason, say that it is not explained anywhere, which is itself worth knowing.
  - What is defined elsewhere: rules this chunk relies on or duplicates (validation in the API schema, constraints in the database, assumptions in the UI), and whether they agree with it.
  - What changed in behaviour: what happened before this change and what happens now, for a real case.
  - What follows from it: consequences a reader would not see from here (what breaks or is skipped downstream, who is affected, what a wrong value would cost).
- Investigate before writing. You are in the repository at the reviewed commit. For each step, open at least the callers of the changed code and the code it calls, plus the models, migrations and tests involved, until you know what the piece is for. Do not guess; if something stays unclear, say so plainly.
- Plain, direct sentences. Markdown is allowed (short paragraphs, bullet lists, \`code\`). No headings.
- "note": shown inline in the editor directly above the chunk, so the reader sees it and the code together. It must contain only things that pass the test above. Write exactly these labelled lines, one or two sentences each, each on its own line with a blank line between them:
  **Where it fits:** the user action or caller that reaches this code and what its result feeds.
  **Not in the code:** the most useful fact about this chunk that the chunk does not show (a reason, a domain meaning, a rule defined elsewhere, a behaviour change).
  **Check:** the one thing most worth verifying here. Omit this line when there is nothing specific.
- "explanation": shown beside the code; the fuller version of the same, again without narrating the code. A few short paragraphs or bullets.
- "why": the reason this change was made, as far as the change, its description, and the code show.
- "watchFor": concrete things a reviewer should verify in this chunk (edge cases, wrong assumptions, missing checks, data risks). Leave it empty when there is nothing specific; do not pad.`;

const STEP_RULES = `How to cut steps:
- A step is one small chunk of one file that expresses a single idea, at most about 40 lines. Split larger hunks into several steps; merge adjacent trivial hunks into one.
- "file" is the path exactly as given in the FILE header. "startLine" and "endLine" are the line numbers printed in the diff (new-file numbers; old-file numbers only for deleted files). The range should cover the changed lines plus the few surrounding lines needed to read them.
- "hunkIds" lists every hunk id (h1, h2, …) the step covers. Every hunk must be covered by at least one step. Do not skip tests, config, migrations or generated files; a one-sentence step is fine for trivial ones.
- Order steps for understanding, not by file name: first the data model and types, then the core logic, then the code that calls it (API, UI, jobs), then tests and config. Someone reading in order should never meet a concept before the step that introduces it.
- "section" groups consecutive steps under a short title that names a part of the story (for example "Storing the refund reason").
- "diagramIds" lists ids of diagrams that help with this step.`;

const DIAGRAM_RULES = `Diagrams (Mermaid source in "mermaid", no code fences):
- Always include one "flow" or "sequence" diagram showing how the changed parts work together at runtime: who calls what, in which order, and where data ends up. Mark what this change adds or alters.
- If the change reads or writes a database (SQL, ORM queries, migrations, schema files), find the real schema in the repository and include an "er" diagram (Mermaid erDiagram) of the tables involved: their relevant columns with types, keys and relationships. In the caption, say which tables and columns the changed queries read and write and how the tables are organised.
- Add a "state" diagram when the change is about a lifecycle or status transitions.
- Keep each diagram under about 15 nodes. Use simple alphanumeric node ids and put labels in double quotes, for example A["Charge card (Stripe)"]. Avoid parentheses, quotes and special characters outside quoted labels.
- "caption" explains in two or three sentences how to read the diagram.`;

const RISK_COMMENT_RULE = `a review comment the reviewer could post on that line as their own, if they agree. Write it in the first person as a human reviewer speaking to the author: say what could go wrong and under which condition, then ask for the concrete fix or for confirmation that it is handled. One to three sentences, specific to this code, polite and direct. No praise, no hedging, no mention of AI or of this guide.`;

const ELI5_RULE = `"eli5": a simpler version of the summary, for a capable adult professional who is new to this product and its vocabulary. The name is only a label: do NOT write for a child and do not talk down. No stories, no schoolroom, classmates, toys, sweets or similar childlike comparisons, no "imagine that", no cheerful or cute tone. Write three to six plain, respectful sentences in everyday words: what was not possible before, what is possible now, who notices the difference, and anything important that is still missing. No identifiers, file names, table names or technical jargon; when a domain word is unavoidable, say what it means in the same sentence. A short concrete example with real-looking numbers from this product is welcome when it makes a rule clearer (for example what a customer would actually see); skip analogies to unrelated things. It must stay accurate: simplify, never invent.`;

const OVERVIEW_RULES = `Overview fields:
- "title": a short name for the change.
- "summary": what this change does and why, in business terms, in a few short paragraphs. Start with the one-sentence version.
- ${ELI5_RULE}
- "riskAreas": the places where a mistake would hurt most. For each one: "risk" is one sentence on what could go wrong and why it matters. "file" and "line" anchor it to the changed line it is best raised on (the path from the FILE header and a line number printed in the diff). "comment" is ${RISK_COMMENT_RULE} When a risk is only something to keep in mind and there is nothing concrete to ask of the author, leave "comment" and "file" empty and set "line" to 0.
- "checkQuestions": 3 to 5 questions that test whether the reviewer understood the important behaviour of this change (not trivia), each with a short answer.`;

function header(ctx: ChangeContext): string {
  const s = diffStats(ctx.files);
  return [
    `Change: ${ctx.title}`,
    ctx.description.trim() ? `Description from the author:\n${ctx.description.trim()}` : "No description was provided.",
    `Base commit: ${ctx.baseSha}. The working directory is checked out at the changed version.`,
    `Size: ${s.files} files, ${s.hunks} hunks, +${s.added} -${s.removed} lines.`,
  ].join("\n\n");
}

export function tourPrompt(ctx: ChangeContext): string {
  return [
    READER,
    "Produce the complete guided tour as structured output.",
    OVERVIEW_RULES,
    DIAGRAM_RULES,
    STEP_RULES,
    EXPLAIN_RULES,
    header(ctx),
    "The diff, with line numbers:",
    renderDiffForPrompt(ctx.files),
  ].join("\n\n");
}

function outlinePrompt(ctx: ChangeContext): string {
  const listing = ctx.files
    .map((f) => {
      const added = f.hunks.reduce((n, h) => n + h.addedLines.length, 0);
      const removed = f.hunks.reduce((n, h) => n + h.removedCount, 0);
      return `- ${f.path} (${f.status}, +${added} -${removed}, ${f.hunks.length} hunks)`;
    })
    .join("\n");
  return [
    READER,
    "This change is large, so the tour is built in two passes. This is pass one: produce the overview, the diagrams, and an outline that splits the changed files into sections. Read the changed files and their surroundings in the repository (use `git show` and `git log` against the base commit when you need the old version).",
    OVERVIEW_RULES,
    DIAGRAM_RULES,
    `Outline:
- "sections" splits ALL changed files into 3 to 12 groups that each tell one part of the story. Every changed file belongs to exactly one section; use the paths exactly as listed.
- Order the sections for understanding: data model first, then core logic, then callers, then tests and config.
- "purpose" says in one or two sentences what that part of the change achieves.`,
    header(ctx),
    "Changed files:",
    listing,
  ].join("\n\n");
}

function sectionPrompt(
  ctx: ChangeContext,
  overview: { summary: string; diagrams: Diagram[] },
  section: { title: string; purpose: string },
  files: DiffFile[],
): string {
  const diagrams = overview.diagrams.map((d) => `- ${d.id}: ${d.title}`).join("\n") || "(none)";
  return [
    READER,
    `This is pass two of a large tour. Write the steps for ONE section only: "${section.title}". ${section.purpose}`,
    `Overview of the whole change, for context:\n${overview.summary}`,
    `Diagrams you may reference in "diagramIds":\n${diagrams}`,
    STEP_RULES,
    `Use "${section.title}" as the section of every step unless a finer split clearly helps.`,
    EXPLAIN_RULES,
    header(ctx),
    "The diff of this section, with line numbers:",
    renderDiffForPrompt(files),
  ].join("\n\n");
}

function retryPrompt(ctx: ChangeContext, summary: string, files: DiffFile[], missing: string[]): string {
  return [
    READER,
    `A guided tour of this change was written but it left some hunks unexplained: ${missing.join(", ")}. Write steps that cover exactly those hunks.`,
    `Overview of the whole change, for context:\n${summary}`,
    STEP_RULES,
    EXPLAIN_RULES,
    header(ctx),
    "The files containing the unexplained hunks, with line numbers:",
    renderDiffForPrompt(files),
  ].join("\n\n");
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

function renumber(steps: Step[]): Step[] {
  return steps.map((s, i) => ({ ...s, id: s.unexplained ? s.id : `s${i + 1}` }));
}

export async function generateTour(ctx: ChangeContext, opts: GenerateOptions): Promise<Tour> {
  const run = (prompt: string, schema: object, label?: string) =>
    runAgent(
      {
        agent: opts.agent,
        prompt,
        cwd: opts.cwd,
        schema,
        signal: opts.signal,
        onProgress: (l) => opts.onProgress?.(label ? `[${label}] ${l}` : l),
      },
      opts.config,
    );

  const full = tourPrompt(ctx);
  let tour: Tour;

  if (full.length <= opts.singlePassMaxChars) {
    opts.onProgress?.("Reading the change and the code around it");
    const res = await run(full, tourSchema);
    tour = buildTour(res.structured, ctx.files, ctx.title);
  } else {
    opts.onProgress?.("Large change: writing the overview and outline first");
    const res = await run(outlinePrompt(ctx), outlineSchema, "outline");
    const outline = normalizeOutline(res.structured, ctx.files, ctx.title);
    const diagramIds = new Set(outline.diagrams.map((d) => d.id));
    opts.onProgress?.(`Outline has ${outline.sections.length} sections; explaining each`);
    const perSection = await pool(outline.sections, 3, async (section, i) => {
      const files = ctx.files.filter((f) => section.files.includes(f.path));
      try {
        const r = await run(sectionPrompt(ctx, outline, section, files), sectionStepsSchema, section.title);
        return normalizeSteps((r.structured as any)?.steps, files, `p${i}_`);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        opts.onProgress?.(`[${section.title}] failed: ${(e as Error).message}`);
        return [];
      }
    });
    tour = {
      title: outline.title,
      summary: outline.summary,
      eli5: outline.eli5,
      riskAreas: outline.riskAreas,
      diagrams: outline.diagrams,
      steps: perSection.flat().map((s) => ({ ...s, diagramIds: s.diagramIds.filter((id) => diagramIds.has(id)) })),
      checkQuestions: outline.checkQuestions,
    };
  }

  // Coverage: one retry for hunks no step explains, then make the gap explicit.
  const missing = uncoveredHunks(tour.steps, ctx.files);
  if (missing.length > 0 && !opts.signal?.aborted) {
    opts.onProgress?.(`${missing.length} change(s) were left unexplained; asking again`);
    const files = ctx.files.filter((f) => f.hunks.some((h) => missing.includes(h)));
    try {
      const r = await run(
        retryPrompt(ctx, tour.summary, files, missing.map((h) => h.id)),
        sectionStepsSchema,
        "follow-up",
      );
      const ids = new Set(tour.diagrams.map((d) => d.id));
      const extra = normalizeSteps((r.structured as any)?.steps, files, "r")
        .filter((s) => s.hunkIds.some((id) => missing.some((h) => h.id === id)))
        .map((s) => ({ ...s, diagramIds: s.diagramIds.filter((id) => ids.has(id)) }));
      tour.steps.push(...extra);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      opts.onProgress?.(`Follow-up failed: ${(e as Error).message}`);
    }
  }
  tour.steps = addUnexplainedSteps(renumber(tour.steps), ctx.files);
  return tour;
}

const eli5Schema = {
  type: "object",
  properties: { eli5: { type: "string" } },
  required: ["eli5"],
  additionalProperties: false,
};

/** Writes the beginner explanation for a tour made before that section existed. */
export async function writeEli5(
  tour: Pick<Tour, "title" | "summary">,
  opts: Pick<GenerateOptions, "agent" | "config" | "cwd" | "signal">,
): Promise<string> {
  const prompt = [
    "Below is the overview of a code change, written for an engineer. Write one more field for it.",
    ELI5_RULE,
    "You are in the repository at the changed version; read code if the overview alone is not enough to explain it truthfully.",
    `Change: ${tour.title}`,
    `Overview:\n${tour.summary}`,
  ].join("\n\n");
  const res = await runAgent({ agent: opts.agent, prompt, cwd: opts.cwd, schema: eli5Schema, signal: opts.signal }, opts.config);
  const text = String((res.structured as any)?.eli5 ?? "").trim();
  if (!text) throw new Error("No explanation returned");
  return text;
}

const riskDraftSchema = {
  type: "object",
  properties: {
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: { index: { type: "integer" }, file: { type: "string" }, line: { type: "integer" }, comment: { type: "string" } },
        required: ["index", "file", "line", "comment"],
        additionalProperties: false,
      },
    },
  },
  required: ["comments"],
  additionalProperties: false,
};

/** Drafts review comments for the risks of a tour made before drafts existed. */
export async function draftRiskComments(
  tour: Pick<Tour, "title" | "summary" | "riskAreas">,
  ctx: ChangeContext,
  opts: Pick<GenerateOptions, "agent" | "config" | "cwd" | "signal">,
): Promise<Risk[]> {
  const prompt = [
    "Below are the risks a guide listed for a code change, and the change itself. For each risk, draft a review comment.",
    `For every risk return its "index", the "file" and "line" it is best raised on (the path from the FILE header and a line number printed in the diff), and "comment": ${RISK_COMMENT_RULE} When there is nothing concrete to ask of the author, return an empty "comment" and "file" and line 0.`,
    "You are in the repository at the changed version; read the code before drafting, and do not ask for something the code already does.",
    `Change: ${tour.title}\n${tour.summary}`,
    `Risks:\n${tour.riskAreas.map((r, i) => `${i}. ${r.text}`).join("\n")}`,
    "The diff, with line numbers:",
    renderDiffForPrompt(ctx.files),
  ].join("\n\n");
  const res = await runAgent({ agent: opts.agent, prompt, cwd: opts.cwd, schema: riskDraftSchema, signal: opts.signal }, opts.config);
  const drafts = Array.isArray((res.structured as any)?.comments) ? (res.structured as any).comments : [];
  return tour.riskAreas.map((risk, i) => {
    const d = drafts.find((x: any) => Number(x?.index) === i);
    const [merged] = normalizeRisks([{ text: risk.text, file: d?.file, line: d?.line, comment: d?.comment }], ctx.files);
    return merged ?? risk;
  });
}

const repairSchema = {
  type: "object",
  properties: { mermaid: { type: "string" } },
  required: ["mermaid"],
  additionalProperties: false,
};

export async function repairDiagram(
  diagram: Diagram,
  error: string,
  opts: Pick<GenerateOptions, "agent" | "config" | "cwd" | "signal">,
): Promise<string> {
  const prompt = [
    "This Mermaid diagram fails to parse. Return a corrected version that keeps the same meaning.",
    "Use simple alphanumeric node ids and put every label in double quotes. No code fences.",
    `Parser error:\n${error}`,
    `Diagram source:\n${diagram.mermaid}`,
  ].join("\n\n");
  const res = await runAgent({ agent: opts.agent, prompt, cwd: opts.cwd, schema: repairSchema, signal: opts.signal }, opts.config);
  const fixed = stripFence(String((res.structured as any)?.mermaid ?? ""));
  if (!fixed) throw new Error("No repaired diagram returned");
  return fixed;
}
