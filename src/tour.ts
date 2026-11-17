import { DiffFile, Hunk, allHunks, hunkRange } from "./diff";

export type DiagramKind = "flow" | "sequence" | "er" | "state";

export interface Diagram {
  id: string;
  title: string;
  kind: DiagramKind;
  mermaid: string;
  caption: string;
}

export interface Step {
  id: string;
  section: string;
  title: string;
  file: string;
  startLine: number;
  endLine: number;
  hunkIds: string[];
  /** One short paragraph shown inline in the editor above the chunk. */
  note: string;
  explanation: string;
  why: string;
  watchFor: string[];
  diagramIds: string[];
  /** Set for steps the extension added because the agent left a change unexplained. */
  unexplained?: boolean;
}

/** A place where a mistake would hurt, optionally with a review comment drafted for it. */
export interface Risk {
  text: string;
  /** Where the drafted comment belongs. Empty when there is no draft. */
  file: string;
  line: number;
  /** A review comment the reviewer can adopt as their own with one click. Empty when there is nothing concrete to ask. */
  comment: string;
}

export interface CheckQuestion {
  question: string;
  answer: string;
}

export interface Tour {
  title: string;
  summary: string;
  /** The same change explained with no jargon at all, for someone new to the domain. */
  eli5: string;
  riskAreas: Risk[];
  diagrams: Diagram[];
  steps: Step[];
  checkQuestions: CheckQuestion[];
}

export interface OutlineSection {
  title: string;
  purpose: string;
  files: string[];
}

export interface Outline {
  title: string;
  summary: string;
  /** The same change explained with no jargon at all, for someone new to the domain. */
  eli5: string;
  riskAreas: Risk[];
  diagrams: Diagram[];
  sections: OutlineSection[];
  checkQuestions: CheckQuestion[];
}

const str = { type: "string" };
const strArray = { type: "array", items: str };

function obj(properties: Record<string, unknown>) {
  // Every property required and no extras: the strict form both Claude and Codex accept.
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

const diagramSchema = obj({
  id: str,
  title: str,
  kind: { type: "string", enum: ["flow", "sequence", "er", "state"] },
  mermaid: str,
  caption: str,
});

const stepSchema = obj({
  section: str,
  title: str,
  file: str,
  startLine: { type: "integer" },
  endLine: { type: "integer" },
  hunkIds: strArray,
  note: str,
  explanation: str,
  why: str,
  watchFor: strArray,
  diagramIds: strArray,
});

const riskSchema = obj({ risk: str, file: str, line: { type: "integer" }, comment: str });

const questionSchema = obj({ question: str, answer: str });

export const tourSchema = obj({
  title: str,
  summary: str,
  eli5: str,
  riskAreas: { type: "array", items: riskSchema },
  diagrams: { type: "array", items: diagramSchema },
  steps: { type: "array", items: stepSchema },
  checkQuestions: { type: "array", items: questionSchema },
});

export const outlineSchema = obj({
  title: str,
  summary: str,
  eli5: str,
  riskAreas: { type: "array", items: riskSchema },
  diagrams: { type: "array", items: diagramSchema },
  sections: { type: "array", items: obj({ title: str, purpose: str, files: strArray }) },
  checkQuestions: { type: "array", items: questionSchema },
});

export const sectionStepsSchema = obj({ steps: { type: "array", items: stepSchema } });

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
}

export function normalizeDiagrams(raw: unknown): Diagram[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Diagram[] = [];
  raw.forEach((d, i) => {
    if (!d || typeof d !== "object") return;
    const r = d as Record<string, unknown>;
    const mermaid = stripFence(asString(r.mermaid));
    if (!mermaid) return;
    let id = asString(r.id) || `d${i + 1}`;
    while (seen.has(id)) id += "_";
    seen.add(id);
    const kind = asString(r.kind) as DiagramKind;
    out.push({
      id,
      title: asString(r.title, "Diagram"),
      kind: ["flow", "sequence", "er", "state"].includes(kind) ? kind : "flow",
      mermaid,
      caption: asString(r.caption),
    });
  });
  return out;
}

export function stripFence(src: string): string {
  const t = src.trim();
  const m = /^```(?:mermaid)?\s*\n([\s\S]*?)\n?```$/.exec(t);
  return (m ? m[1] : t).trim();
}

/**
 * Cleans agent-produced steps: resolves each step to a changed file, repairs line
 * ranges, and records which hunks the step covers (by declared id or by line overlap).
 */
export function normalizeSteps(raw: unknown, files: DiffFile[], idPrefix = "s"): Step[] {
  if (!Array.isArray(raw)) return [];
  const hunksById = new Map(allHunks(files).map((h) => [h.id, h]));
  const steps: Step[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const declared = asStrings(r.hunkIds).filter((id) => hunksById.has(id));
    let path = asString(r.file).replace(/^\.\//, "");
    let file = files.find((f) => f.path === path || f.oldPath === path);
    if (!file && declared.length > 0) {
      const h = hunksById.get(declared[0])!;
      file = files.find((f) => f.hunks.includes(h));
    }
    if (file) path = file.path;
    if (!path) continue;

    const deleted = file?.status === "deleted";
    let start = Math.floor(Number(r.startLine));
    let end = Math.floor(Number(r.endLine));
    const own = declared.map((id) => hunksById.get(id)!).filter((h) => !file || file.hunks.includes(h));
    if (!Number.isFinite(start) || start < 1 || !Number.isFinite(end) || end < start) {
      if (own.length > 0) {
        const ranges = own.map((h) => hunkRange(h, deleted));
        start = Math.min(...ranges.map((x) => x.start));
        end = Math.max(...ranges.map((x) => x.end));
      } else {
        start = Number.isFinite(start) && start >= 1 ? start : 1;
        end = start;
      }
    }

    const covered = new Set(own.map((h) => h.id));
    for (const h of file?.hunks ?? []) {
      const hr = hunkRange(h, deleted);
      if (hr.start <= end && hr.end >= start) covered.add(h.id);
    }

    steps.push({
      id: `${idPrefix}${steps.length + 1}`,
      section: asString(r.section, "Changes"),
      title: asString(r.title, path),
      file: path,
      startLine: start,
      endLine: end,
      hunkIds: [...covered],
      note: asString(r.note),
      explanation: asString(r.explanation),
      why: asString(r.why),
      watchFor: asStrings(r.watchFor),
      diagramIds: asStrings(r.diagramIds),
    });
  }
  return steps;
}

/** The inline note for a step; tours made before notes existed fall back to the explanation's first paragraph. */
export function stepNote(step: Pick<Step, "note" | "explanation">): string {
  const note = (step.note ?? "").trim();
  if (note) return note;
  return (step.explanation ?? "").trim().split(/\n\s*\n/)[0] ?? "";
}

export function uncoveredHunks(steps: Step[], files: DiffFile[]): Hunk[] {
  const covered = new Set(steps.flatMap((s) => s.hunkIds));
  return allHunks(files).filter((h) => !covered.has(h.id));
}

export const UNEXPLAINED_SECTION = "Not yet explained";

/** Adds a plain step for every hunk no step covers, so the tour never silently skips code. */
export function addUnexplainedSteps(steps: Step[], files: DiffFile[]): Step[] {
  const missing = uncoveredHunks(steps, files);
  if (missing.length === 0) return steps;
  const out = [...steps];
  for (const f of files) {
    for (const h of f.hunks) {
      if (!missing.includes(h)) continue;
      const r = hunkRange(h, f.status === "deleted");
      out.push({
        id: `u${h.id}`,
        section: UNEXPLAINED_SECTION,
        title: `${f.path}:${r.start}`,
        file: f.path,
        startLine: r.start,
        endLine: r.end,
        hunkIds: [h.id],
        note: "",
        explanation:
          "The agent did not explain this change. Read it directly, or select it and use Explain Selection.",
        why: "",
        watchFor: [],
        diagramIds: [],
        unexplained: true,
      });
    }
  }
  return out;
}

export function buildTour(raw: unknown, files: DiffFile[], fallbackTitle: string): Tour {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const diagrams = normalizeDiagrams(r.diagrams);
  const ids = new Set(diagrams.map((d) => d.id));
  const steps = normalizeSteps(r.steps, files).map((s) => ({
    ...s,
    diagramIds: s.diagramIds.filter((id) => ids.has(id)),
  }));
  return {
    title: asString(r.title, fallbackTitle) || fallbackTitle,
    summary: asString(r.summary),
    eli5: asString(r.eli5),
    riskAreas: normalizeRisks(r.riskAreas, files),
    diagrams,
    steps,
    checkQuestions: normalizeQuestions(r.checkQuestions),
  };
}

/** Accepts both the current object form and the plain strings of older tours. */
export function normalizeRisks(raw: unknown, files: DiffFile[] = []): Risk[] {
  if (!Array.isArray(raw)) return [];
  const out: Risk[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ text: item.trim(), file: "", line: 0, comment: "" });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const text = asString(r.text) || asString(r.risk);
    if (!text.trim()) continue;
    const comment = asString(r.comment).trim();
    const path = asString(r.file).replace(/^\.\//, "");
    const file = files.find((f) => f.path === path || f.oldPath === path)?.path ?? path;
    const line = Math.floor(Number(r.line));
    const anchored = !!comment && !!file && Number.isFinite(line) && line >= 1;
    out.push({ text: text.trim(), file: anchored ? file : "", line: anchored ? line : 0, comment: anchored ? comment : "" });
  }
  return out;
}

/** Brings a tour read from the cache up to the current shape. */
export function upgradeTour(tour: Tour | undefined): Tour | undefined {
  if (!tour) return undefined;
  return { ...tour, eli5: tour.eli5 ?? "", riskAreas: normalizeRisks(tour.riskAreas) };
}

export function normalizeQuestions(raw: unknown): CheckQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q) => q && typeof q === "object")
    .map((q) => ({ question: asString((q as any).question), answer: asString((q as any).answer) }))
    .filter((q) => q.question);
}

export function normalizeOutline(raw: unknown, files: DiffFile[], fallbackTitle: string): Outline {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const known = new Set(files.map((f) => f.path));
  const assigned = new Set<string>();
  const sections: OutlineSection[] = [];
  if (Array.isArray(r.sections)) {
    for (const s of r.sections) {
      if (!s || typeof s !== "object") continue;
      const paths = asStrings((s as any).files).filter((p) => known.has(p) && !assigned.has(p));
      paths.forEach((p) => assigned.add(p));
      if (paths.length === 0) continue;
      sections.push({ title: asString((s as any).title, "Changes"), purpose: asString((s as any).purpose), files: paths });
    }
  }
  const rest = files.map((f) => f.path).filter((p) => !assigned.has(p));
  if (rest.length > 0) sections.push({ title: "Other changes", purpose: "", files: rest });
  return {
    title: asString(r.title, fallbackTitle) || fallbackTitle,
    summary: asString(r.summary),
    eli5: asString(r.eli5),
    riskAreas: normalizeRisks(r.riskAreas, files),
    diagrams: normalizeDiagrams(r.diagrams),
    sections,
    checkQuestions: normalizeQuestions(r.checkQuestions),
  };
}
