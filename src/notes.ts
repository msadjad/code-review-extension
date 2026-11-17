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
