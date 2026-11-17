import type { Finding, ReviewerState } from "./reviewers";
import type { ReviewState } from "./notes";
import type { Tour } from "./tour";

/** Everything the panel needs to render. Sent whole on every change. */
export interface ViewModel {
  /** "starting" is the moment between running the command and having the diff. */
  phase: "starting" | "generating" | "ready" | "error";
  error?: string;
  /** The error happened before a review existed, so the only way forward is to start again. */
  startFailed?: boolean;
  progress: string[];
  title: string;
  /** Extension version, shown so a window still running an old build is easy to spot. */
  version: string;
  subtitle: string;
  /** Repository root, for resolving step files. */
  root: string;
  prUrl?: string;
  canSubmit: boolean;
  stats: { files: number; hunks: number; added: number; removed: number };
  tour?: Tour;
  state: ReviewState;
  reviewers: ReviewerState[];
  findings: Finding[];
  /** Hunk ids per step are in the tour; this is the total for the coverage figure. */
  totalHunks: number;
  isolate: boolean;
  diffMode: boolean;
  repairing: string[];
  /** The beginner explanation is being written for a tour that did not have one. */
  writingEli5: boolean;
  /** Review comments are being drafted for the risks of a tour that had none. */
  draftingRisks: boolean;
  /** Files ticked "Viewed" on the GitHub PR, as far as this review knows. */
  viewedOnGitHub: string[];
}
