import { DiffFile, isLineInDiff } from "./diff";
import type { AgentName } from "./agents";
import type { Finding, ReviewerState } from "./reviewers";

export interface Note {
  id: string;
  stepId: string;
  file: string;
  line: number;
  body: string;
  /** Set when the note was adopted from an agent finding. */
  fromAgent?: AgentName;
  /** Set when the note is a drafted risk comment the reviewer approved. */
  riskIndex?: number;
}

export interface Asked {
  id: string;
  stepId: string;
  file: string;
  startLine: number;
  endLine: number;
  question: string;
  answer: string;
  pending: boolean;
  /** Text selected in the guide itself, for questions about an explanation rather than about code. */
  quote?: string;
  /** The rest of the conversation: follow-up questions, and review comments drafted from it. */
  more?: FollowUp[];
}

export interface FollowUp {
  /** "comment": the answer is a review comment that was added to the notes. */
  kind: "answer" | "comment";
  question: string;
  answer: string;
}

export interface Turn {
  who: "you" | "guide" | "comment";
  text: string;
}

/** A question and everything that followed it, in reading order. */
export function conversationTurns(a: Asked): Turn[] {
  const turns: Turn[] = [{ who: "you", text: a.question || "Explain this code" }];
  if (a.answer) turns.push({ who: "guide", text: a.answer });
  for (const f of a.more ?? []) {
    if (f.kind === "comment") {
      turns.push({ who: "you", text: f.question ? `Add a review comment: ${f.question}` : "Add a review comment" });
      turns.push({ who: "comment", text: f.answer });
    } else {
      turns.push({ who: "you", text: f.question }, { who: "guide", text: f.answer });
    }
  }
  return turns;
}

export type StepStatus = "understood" | "concern";

export interface ReviewState {
  /** -1 is the overview, steps.length is the finish screen. */
  current: number;
  statuses: Record<string, StepStatus>;
  visited: string[];
  notes: Note[];
  asked: Asked[];
  dismissedFindings: string[];
}

export interface FindingsFile {
  reviewers: ReviewerState[];
  findings: Finding[];
}

export function emptyState(): ReviewState {
  return { current: -1, statuses: {}, visited: [], notes: [], asked: [], dismissedFindings: [] };
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface ReviewPayload {
  commit_id: string;
  event: ReviewEvent;
  body: string;
  comments: { path: string; line: number; side: "RIGHT"; body: string }[];
}

/**
 * Notes on lines inside the diff become inline comments. GitHub rejects comments on
 * other lines, so those are listed in the review body instead.
 */
export function buildReviewPayload(
  notes: Note[],
  files: DiffFile[],
  event: ReviewEvent,
  headSha: string,
  intro = "",
): ReviewPayload {
  const comments: ReviewPayload["comments"] = [];
  const loose: string[] = [];
  for (const n of notes) {
    if (!n.body.trim()) continue;
    if (isLineInDiff(files, n.file, n.line)) {
      comments.push({ path: n.file, line: n.line, side: "RIGHT", body: n.body.trim() });
    } else {
      loose.push(`- \`${n.file}:${n.line}\`: ${n.body.trim()}`);
    }
  }
  const parts = [intro.trim(), loose.join("\n")].filter(Boolean);
  return { commit_id: headSha, event, body: parts.join("\n\n"), comments };
}

interface StepShape {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  hunkIds: string[];
}

/**
 * Moves review progress onto a regenerated tour of the same diff. Steps get new ids and
 * boundaries, but hunks stay the same, so a new step counts as read (or understood) when
 * every hunk in it was already read (or understood). Notes and questions follow their lines.
 */
export function carryProgress(oldSteps: StepShape[], state: ReviewState, newSteps: StepShape[]): ReviewState {
  const read = new Set(state.visited);
  const hunksOf = (keep: (s: StepShape) => boolean) => new Set(oldSteps.filter(keep).flatMap((s) => s.hunkIds));
  const readHunks = hunksOf((s) => read.has(s.id));
  const understood = hunksOf((s) => state.statuses[s.id] === "understood");
  const concern = hunksOf((s) => state.statuses[s.id] === "concern");
  const all = (s: StepShape, set: Set<string>) => s.hunkIds.length > 0 && s.hunkIds.every((h) => set.has(h));

  const statuses: Record<string, StepStatus> = {};
  for (const s of newSteps) {
    if (s.hunkIds.some((h) => concern.has(h))) statuses[s.id] = "concern";
    else if (all(s, understood)) statuses[s.id] = "understood";
  }
  const stepAt = (file: string, line: number, fallback: string): string =>
    (
      newSteps.find((s) => s.file === file && line >= s.startLine && line <= s.endLine) ??
      newSteps.find((s) => s.file === file)
    )?.id ?? fallback;
  const fixed = new Set(["", "overview", "finish"]);
  return {
    current: -1,
    statuses,
    visited: newSteps.filter((s) => all(s, readHunks)).map((s) => s.id),
    notes: state.notes.map((n) => ({ ...n, stepId: stepAt(n.file, n.line, "") })),
    asked: state.asked.map((a) => (fixed.has(a.stepId) ? a : { ...a, stepId: stepAt(a.file, a.endLine, "finish") })),
    dismissedFindings: state.dismissedFindings,
  };
}
