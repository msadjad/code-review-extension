import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentConfig, AgentName, isAvailable, runAgent } from "./agents";
import { DiffFile, allHunks, diffStats, isLineInDiff, parseDiff } from "./diff";
import { AnswerThread, ChunkTarget, EditorFocus } from "./editorFocus";
import { ChangeContext, draftRiskComments, generateTour, repairDiagram, writeEli5 } from "./generator";
import * as git from "./git";
import { Asked, FindingsFile, Note, ReviewEvent, ReviewState, buildReviewPayload, carryProgress, conversationTurns, emptyState } from "./notes";
import { Panel, PanelMessage } from "./panel";
import { Finding, ReviewerState, markAgreement, runReviewer, sortFindings } from "./reviewers";
import { StepsTree } from "./stepsTree";
import { FileNode, FilesTree, fileProgress } from "./filesTree";
import { Step, Tour, stepNote, upgradeTour } from "./tour";
import { ViewModel } from "./viewModel";
import { fullyReadFiles, planViewedSync } from "./viewed";

interface Session {
  root: string;
  storage: string;
  key: string;
  title: string;
  description: string;
  baseSha: string;
  headSha: string;
  pr?: git.PrInfo;
  files: DiffFile[];
  tour?: Tour;
  state: ReviewState;
  reviewers: ReviewerState[];
  findings: Finding[];
  phase: ViewModel["phase"];
  error?: string;
  progress: string[];
  abort: AbortController;
  repairing: Set<string>;
  repairTried: Set<string>;
  writingEli5: boolean;
  draftingRisks: boolean;
  /** Keeps GitHub's "Viewed" boxes in step with the files fully read here. */
  /** The tour being replaced by a regeneration, so progress can be carried over to the new one. */
  replacing?: Tour;
  viewed: { previouslyDone: Set<string>; onGitHub?: Set<string>; queue: Promise<void>; warned: boolean };
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1));
}

const HANDOVER_FILE = "handover.json";
/** Note of the review in progress, kept beside its cache so a reloaded window can pick it up again. */
const RESUME_FILE = "resume.json";
const READING = "_Reading the code to answer…_";

/** A question about selected code and its follow-ups, shown as a thread under that code. */
interface Conversation {
  asked: Asked;
  code: string;
  step?: Step;
  view?: AnswerThread;
  busy: boolean;
}
/** What a comment-thread button passes: the reply box contents, or just the thread. */
type ThreadArg = vscode.CommentReply | vscode.CommentThread | undefined;

interface ResumeNote {
  root: string;
  headSha: string;
  baseSha: string;
  pr?: git.PrInfo;
}
const HANDOVER_MAX_AGE_MS = 5 * 60_000;

let idCounter = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export class Controller implements vscode.Disposable {
  private session?: Session;
  /** Set between running the start command and having a session to show. */
  private starting?: { title: string; lines: string[]; failed?: string };
  private startToken = 0;
  private readonly focus = new EditorFocus(() => this.codeColumn());
  private readonly panel: Panel;
  readonly tree = new StepsTree();
  readonly filesTree = new FilesTree();
  private filesView?: vscode.TreeView<FileNode>;
  private readonly manifest: any;
  private readonly noteThreads = new WeakMap<vscode.CommentThread, string>();
  private readonly conversations = new WeakMap<vscode.CommentThread, Conversation>();
  private readonly status: vscode.StatusBarItem;

  private readonly version: string;
  private readonly extensionPath: string;
  private staleWarned = false;

  /**
   * An installed update only takes effect after the window reloads. Say so when a newer
   * build is sitting next to the one this window is running.
   */
  private warnIfNewerInstalled(): void {
    if (this.staleWarned) return;
    try {
      const m = /^(.*)-(\d+)\.(\d+)\.(\d+)$/.exec(path.basename(this.extensionPath));
      if (!m) return;
      const mine = [Number(m[2]), Number(m[3]), Number(m[4])];
      let newest = mine;
      for (const name of fs.readdirSync(path.dirname(this.extensionPath))) {
        const o = /^(.*)-(\d+)\.(\d+)\.(\d+)$/.exec(name);
        if (!o || o[1] !== m[1]) continue;
        const v = [Number(o[2]), Number(o[3]), Number(o[4])];
        if (v[0] - newest[0] || v[1] - newest[1] || v[2] - newest[2]) {
          const d = v[0] - newest[0] || v[1] - newest[1] || v[2] - newest[2];
          if (d > 0) newest = v;
        }
      }
      if (newest === mine) return;
      this.staleWarned = true;
      void vscode.window
        .showWarningMessage(
          `Review Guide ${newest.join(".")} is installed, but this window is still running ${mine.join(".")}. Reload the window to use it.`,
          "Reload Window",
        )
        .then((pick) => {
          if (pick) void vscode.commands.executeCommand("workbench.action.reloadWindow");
        });
    } catch {
      // not installed from a versioned folder (development host): nothing to compare
    }
  }

  constructor(context: vscode.ExtensionContext) {
    this.version = String(context.extension.packageJSON.version ?? "");
    this.manifest = context.extension.packageJSON;
    this.extensionPath = context.extensionPath;
    this.panel = new Panel(
      context.extensionUri,
      (m) => void this.onPanelMessage(m),
      () => {
        // Closing the panel while a start is in flight, or showing its error, abandons that start.
        if (this.starting) {
          this.startToken++;
          this.starting = undefined;
          this.refreshStatus();
        }
      },
      () => this.layout(),
    );
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.name = "Review Guide";
    this.refreshStatus();
    this.status.show();
  }

  get active(): boolean {
    return !!this.session;
  }

  // ---------- layout ----------

  private layout(): "tab" | "split" {
    return vscode.workspace.getConfiguration("reviewGuide").get("layout") === "split" ? "split" : "tab";
  }

  /** The editor group code opens in. */
  private codeColumn(): vscode.ViewColumn {
    const guide = this.panel.column;
    const active = vscode.window.activeTextEditor?.viewColumn;
    // As a tab, the guide shares its group with the code, so nothing is ever split.
    if (this.layout() === "tab") return guide ?? active ?? vscode.ViewColumn.One;
    if (active && active !== guide) return active;
    const other = vscode.window.visibleTextEditors.map((e) => e.viewColumn).find((c) => c && c !== guide);
    if (other) return other;
    // Opening code in the guide's own group would hide the guide behind it.
    return guide === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
  }

  // ---------- configuration ----------

  private config(): AgentConfig {
    const c = vscode.workspace.getConfiguration("reviewGuide");
    return {
      claudePath: c.get("claudePath", "claude") || "claude",
      codexPath: c.get("codexPath", "codex") || "codex",
      claudeModel: c.get("claudeModel", ""),
      codexModel: c.get("codexModel", ""),
      timeoutMs: Math.max(1, c.get("timeoutMinutes", 20)) * 60_000,
    };
  }

  private tourAgent(): AgentName {
    return vscode.workspace.getConfiguration("reviewGuide").get<AgentName>("tourAgent", "claude");
  }

  private reviewerAgents(): AgentName[] {
    const list = vscode.workspace.getConfiguration("reviewGuide").get<AgentName[]>("reviewers", ["claude", "codex"]);
    return [...new Set(list.filter((a) => a === "claude" || a === "codex"))];
  }

  // ---------- starting ----------

  async start(): Promise<void> {
    const folder = await this.pickFolder();
    if (!folder) return;

    const input = await vscode.window.showInputBox({
      title: "Review Guide",
      prompt: "PR number or URL. Leave empty to review the current branch against its base.",
      placeHolder: "1234 or https://github.com/org/repo/pull/1234",
      ignoreFocusOut: true,
    });
    if (input === undefined) return;
    await this.begin(folder, input.trim());
  }

  /**
   * Continues a review that another window handed over: when the PR branch lives in a
   * different worktree, that window opens the folder and leaves a note here to start it.
   */
  async resumeHandedOver(): Promise<void> {
    if (this.session || this.starting) return;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const root = await git.repoRoot(folder.uri.fsPath);
        const file = path.join(await git.storageDir(root), HANDOVER_FILE);
        const note = readJson<{ ref: string; at: number }>(file);
        if (!note) continue;
        fs.rmSync(file, { force: true });
        if (typeof note.ref !== "string" || Date.now() - note.at > HANDOVER_MAX_AGE_MS) continue;
        await this.begin(root, note.ref);
        return;
      } catch {
        // not a git folder, or nothing handed over
      }
    }
  }

  /**
   * After a window reload: reopens the review that was in progress, at the step it was on.
   * Only when the checkout is still on the same commit; everything comes from the cache,
   * so nothing is fetched or checked out.
   */
  async resumeAfterReload(): Promise<void> {
    await this.resumeHandedOver();
    if (this.session || this.starting) return;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      let file = "";
      try {
        const root = await git.repoRoot(folder.uri.fsPath);
        file = path.join(await git.storageDir(root), RESUME_FILE);
        const note = readJson<ResumeNote>(file);
        if (!note) continue;
        if (note.root !== root || (await git.headSha(root)) !== note.headSha) throw new Error("the checkout moved");
        const session = await this.buildSession(root, note.baseSha, note.pr);
        if (this.session || this.starting) return; // a review was started by hand meanwhile
        await this.activate(session);
        return;
      } catch {
        if (file) fs.rmSync(file, { force: true });
      }
    }
  }

  private async begin(folder: string, ref: string): Promise<void> {
    this.warnIfNewerInstalled();
    // Show the panel at once, so it is obvious the command took, then fill it in.
    // A review already open here stays until the new one is ready: if this start is
    // cancelled, fails, or is handed to another window, that review carries on untouched.
    const token = ++this.startToken;
    this.starting = { title: ref ? this.describeRef(ref) : "Current branch", lines: [], failed: undefined };
    if (this.session) this.panel.focus();
    else this.panel.open();
    void this.showSideBar();
    const stage = (line: string) => {
      if (token !== this.startToken || !this.starting) return;
      this.starting.lines.push(line);
      this.showStarting();
    };
    stage("Locating the repository");

    try {
      const root = await git.repoRoot(folder);
      const session = await this.prepare(root, ref, stage);
      if (token !== this.startToken) return; // cancelled or restarted meanwhile
      if (!session) {
        this.cancelStart();
        return;
      }
      this.starting = undefined;
      await this.activate(session);
    } catch (e) {
      if (token !== this.startToken || !this.starting) return;
      this.starting.failed = (e as Error).message;
      this.showStarting();
    }
  }

  private describeRef(ref: string): string {
    const m = /\/pull\/(\d+)/.exec(ref) ?? /^#?(\d+)$/.exec(ref);
    return m ? `PR #${m[1]}` : ref;
  }

  /** Renders the panel before a session exists: the steps taken so far, or why starting failed. */
  private showStarting(): void {
    const st = this.starting;
    if (!st) return;
    this.panel.update({
      phase: st.failed ? "error" : "starting",
      error: st.failed,
      startFailed: !!st.failed,
      progress: st.lines,
      title: st.title,
      version: this.version,
      root: "",
      subtitle: "",
      canSubmit: false,
      stats: { files: 0, hunks: 0, added: 0, removed: 0 },
      state: emptyState(),
      reviewers: [],
      findings: [],
      totalHunks: 0,
      isolate: false,
      diffMode: false,
      repairing: [],
      writingEli5: false,
      draftingRisks: false,
      viewedOnGitHub: [],
    });
    this.refreshStatus();
  }

  private cancelStart(): void {
    this.startToken++;
    this.starting = undefined;
    if (this.session) {
      // Back to the review that was open before this start.
      this.update();
      return;
    }
    this.panel.dispose();
    this.refreshStatus();
  }

  private async pickFolder(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      vscode.window.showErrorMessage("Review Guide: open the repository folder first.");
      return undefined;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    const owner = active && vscode.workspace.getWorkspaceFolder(active);
    if (owner) return owner.uri.fsPath;
    if (folders.length === 1) return folders[0].uri.fsPath;
    const pick = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Repository to review" });
    return pick?.uri.fsPath;
  }

  private async prepare(
    root: string,
    prRef: string,
    stage: (line: string) => void,
  ): Promise<Session | undefined> {
    let pr: git.PrInfo | undefined;
    let base: string | undefined;

    if (prRef) {
      stage("Fetching the pull request from GitHub");
      pr = await git.prInfo(root, prRef);
      stage(`Found PR #${pr.number}: ${pr.title}`);
      if ((await git.headSha(root)) !== pr.headRefOid) {
        if (await git.isDirty(root)) {
          throw new Error(
            `the working tree has uncommitted changes, so PR #${pr.number} was not checked out. Commit or stash them and start again.`,
          );
        }
        stage(`Checking out ${pr.headRefName}`);
        // A branch can only be checked out in one worktree at a time.
        let other = await git.worktreeForBranch(root, pr.headRefName);
        if (!other) {
          try {
            await git.prCheckout(root, pr.number);
          } catch (e) {
            other = git.worktreeHoldingBranch((e as Error).message);
            if (!other) throw e;
          }
        }
        if (other) {
          stage(`The PR branch is already checked out in another worktree: ${other}`);
          const openThere = "Open that worktree";
          const hereDetached = "Review here without a branch";
          const choice = await vscode.window.showInformationMessage(
            `PR #${pr.number}'s branch is already checked out in another worktree.`,
            {
              modal: true,
              detail: `${other}\n\n"${openThere}" opens that folder in a new window and starts the review there.\n"${hereDetached}" checks out the PR's commit in this folder as a detached HEAD (git switch - brings you back).`,
            },
            openThere,
            hereDetached,
          );
          if (choice === openThere) {
            // Leave a note in that worktree so its window starts this review by itself.
            writeJson(path.join(await git.storageDir(other), HANDOVER_FILE), { ref: prRef, at: Date.now() });
            await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(other), { forceNewWindow: true });
            return undefined;
          }
          if (choice !== hereDetached) return undefined;
          stage("Checking out the PR commit here without a branch");
          await git.prCheckoutDetached(root, pr.number);
        }
      }
      stage(`Fetching the base branch ${pr.baseRefName}`);
      base = await git.fetchBase(root, pr.baseRefName);
    } else {
      stage("Looking for the base branch");
      try {
        pr = await git.prInfo(root, "");
        base = await git.fetchBase(root, pr.baseRefName);
      } catch {
        pr = undefined; // no PR for this branch, or gh is not set up: review locally
        base = await git.defaultBase(root);
      }
      if (!base) {
        base = await vscode.window.showInputBox({
          prompt: "Base branch to compare against",
          value: "main",
          ignoreFocusOut: true,
        });
        if (!base) return undefined;
      }
    }

    stage("Computing the diff");
    return this.buildSession(root, base, pr);
  }

  /** Test and automation entry: start on the current branch without prompts. */
  async startLocal(root: string, base?: string): Promise<void> {
    const real = await git.repoRoot(root);
    const resolved = base ?? (await git.defaultBase(real));
    if (!resolved) throw new Error("no base branch found");
    await this.activate(await this.buildSession(real, resolved, undefined));
  }

  private async buildSession(root: string, base: string, pr: git.PrInfo | undefined): Promise<Session> {
    const headSha = await git.headSha(root);
    const baseSha = await git.mergeBase(root, base);
    if (baseSha === headSha) {
      throw new Error(`the current branch has no commits on top of ${base}; there is nothing to review.`);
    }
    const files = parseDiff(await git.diffAgainst(root, baseSha));
    if (allHunks(files).length === 0) throw new Error("the diff has no text changes to review.");

    // A PR found for the branch only counts as "the PR under review" when it matches the checkout.
    const samePr = pr && pr.headRefOid === headSha ? pr : undefined;
    const storage = await git.storageDir(root);
    const key = `${headSha.slice(0, 12)}-${baseSha.slice(0, 12)}`;
    const findings = readJson<FindingsFile>(path.join(storage, `${key}.findings.json`));
    return {
      root,
      storage,
      key,
      title: pr?.title ?? (await git.currentBranch(root)),
      description: pr?.body ?? "",
      baseSha,
      headSha,
      pr: samePr,
      files,
      tour: upgradeTour(readJson<Tour>(path.join(storage, `${key}.tour.json`))),
      state: readJson<ReviewState>(path.join(storage, `${key}.state.json`)) ?? emptyState(),
      reviewers: (findings?.reviewers ?? []).map((r) =>
        r.status === "running" ? { ...r, status: "failed", error: "Interrupted" } : r,
      ),
      findings: findings?.findings ?? [],
      phase: "ready",
      progress: [],
      abort: new AbortController(),
      repairing: new Set(),
      repairTried: new Set(),
      writingEli5: false,
      draftingRisks: false,
      viewed: { previouslyDone: new Set(), queue: Promise.resolve(), warned: false },
    };
  }

  private async activate(session: Session): Promise<void> {
    await this.stop(false);
    this.session = session;
    const note: ResumeNote = { root: session.root, headSha: session.headSha, baseSha: session.baseSha, pr: session.pr };
    try {
      writeJson(path.join(session.storage, RESUME_FILE), note);
    } catch {
      // without the note a reload just does not bring the review back
    }
    await vscode.commands.executeCommand("setContext", "reviewGuide.active", true);
    this.panel.open();
    this.update();
    await this.showSideBar();

    const hadFindings = session.reviewers.length > 0;
    if (!session.tour) void this.generate();
    else await this.goTo(session.state.current, true);
    if (!hadFindings) void this.runReviewers();
  }

  private changeContext(s: Session): ChangeContext {
    return { title: s.title, description: s.description, baseSha: s.baseSha, files: s.files };
  }

  // ---------- generation ----------

  async regenerate(): Promise<void> {
    const s = this.session;
    if (!s || s.phase === "generating") return;
    // Progress is kept as it is until the new tour exists, then moved onto it. If the
    // regeneration fails or is interrupted, the cached tour and its progress are untouched.
    s.replacing = s.tour ?? s.replacing;
    s.tour = undefined;
    await this.focus.clear();
    await this.generate();
  }

  private async generate(): Promise<void> {
    const s = this.session;
    if (!s) return;
    s.phase = "generating";
    s.error = undefined;
    s.progress = [];
    this.update();
    try {
      const tour = await generateTour(this.changeContext(s), {
        agent: this.tourAgent(),
        config: this.config(),
        cwd: s.root,
        singlePassMaxChars: vscode.workspace.getConfiguration("reviewGuide").get("singlePassMaxChars", 120000),
        signal: s.abort.signal,
        onProgress: (line) => {
          if (this.session !== s) return;
          s.progress.push(line);
          if (s.progress.length > 200) s.progress.shift();
          this.update();
        },
      });
      if (this.session !== s) return;
      s.tour = tour;
      s.phase = "ready";
      writeJson(path.join(s.storage, `${s.key}.tour.json`), tour);
      if (s.replacing) s.state = carryProgress(s.replacing.steps, s.state, tour.steps);
      s.replacing = undefined;
      s.state.current = -1;
      this.saveState();
      this.update();
    } catch (e) {
      if (this.session !== s) return;
      if (s.replacing) {
        // A failed regeneration leaves the review as it was.
        s.tour = s.replacing;
        s.replacing = undefined;
        s.phase = "ready";
        this.update();
        void vscode.window.showWarningMessage(`Review Guide could not regenerate the tour, so the previous one is kept: ${(e as Error).message}`);
        return;
      }
      s.phase = "error";
      s.error = (e as Error).message;
      this.update();
    }
  }

  async runReviewers(): Promise<void> {
    const s = this.session;
    if (!s) return;
    if (s.reviewers.some((r) => r.status === "running")) return;
    const agents = this.reviewerAgents();
    if (agents.length === 0) return;
    const config = this.config();
    s.reviewers = agents.map((agent) => ({ agent, status: "running" }));
    s.findings = [];
    // Finding ids restart with every run, so old dismissals must not hide new findings.
    s.state.dismissedFindings = [];
    this.saveState();
    this.update();

    const set = (agent: AgentName, patch: Partial<ReviewerState>) => {
      if (this.session !== s) return;
      s.reviewers = s.reviewers.map((r) => (r.agent === agent ? { ...r, ...patch } : r));
      if (!s.reviewers.some((r) => r.status === "running")) {
        writeJson(path.join(s.storage, `${s.key}.findings.json`), {
          reviewers: s.reviewers,
          findings: s.findings,
        } satisfies FindingsFile);
      }
      this.update();
    };

    await Promise.all(
      agents.map(async (agent) => {
        if (!(await isAvailable(agent, config))) {
          set(agent, { status: "unavailable", error: `The ${agent} CLI was not found` });
          return;
        }
        try {
          const res = await runReviewer(agent, this.changeContext(s), {
            config,
            cwd: s.root,
            signal: s.abort.signal,
          });
          if (this.session !== s) return;
          s.findings = [...s.findings.filter((f) => f.agent !== agent), ...res.findings];
          set(agent, { status: "done", verdict: res.verdict, count: res.findings.length });
        } catch (e) {
          set(agent, { status: "failed", error: (e as Error).message });
        }
      }),
    );
  }

  // ---------- navigation ----------

  /** Shows a step's code, with the conversations and review comments saved on that file. */
  private async showStep(s: Session, step: Step, preserveFocus: boolean): Promise<void> {
    const target = this.stepTarget(s, step);
    await this.focus.show(target, preserveFocus);
    if (target.deleted) return;
    const uri = vscode.Uri.file(path.join(s.root, step.file));
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (!doc) return;
    const row = (line: number) => Math.min(Math.max(0, line - 1), doc.lineCount - 1);

    const inTalks = new Set<string>();
    for (const asked of s.state.asked) {
      if (asked.file !== step.file || asked.quote || asked.pending || !asked.answer) continue;
      for (const f of asked.more ?? []) if (f.kind === "comment") inTalks.add(f.answer);
      const view = this.focus.showAnswer(uri, row(asked.endLine), "answer", true);
      const code = doc.getText(new vscode.Range(row(asked.startLine), 0, row(asked.endLine), Number.MAX_SAFE_INTEGER));
      const talk: Conversation = { asked, code, step: s.tour?.steps.find((x) => x.id === asked.stepId), view, busy: false };
      this.conversations.set(view.thread, talk);
      this.renderTalk(talk);
    }
    for (const note of s.state.notes) {
      if (note.file !== step.file) continue;
      // A comment drafted in a conversation is also inside that conversation's thread.
      const view = this.focus.showAnswer(uri, row(note.line), "note", false);
      this.noteThreads.set(view.thread, note.id);
      view.render([{ who: "comment", text: note.body }]);
    }
  }

  /** The trash button on a review comment shown in the code. */
  threadDeleteNote(thread: vscode.CommentThread): void {
    const s = this.session;
    const id = thread && this.noteThreads.get(thread);
    if (!s || !id) return;
    s.state.notes = s.state.notes.filter((n) => n.id !== id);
    thread.dispose();
    this.saveState();
    this.update();
  }

  private stepTarget(s: Session, step: Step): ChunkTarget {
    const file = s.files.find((f) => f.path === step.file);
    const changed = file ? file.hunks.flatMap((h) => h.addedLines) : [];
    const inRange = changed.some((l) => l >= step.startLine && l <= step.endLine);
    const deleted = file?.status === "deleted";
    return {
      root: s.root,
      baseSha: s.baseSha,
      file: step.file,
      basePath: file ? (file.status === "added" ? undefined : file.oldPath) : step.file,
      deleted,
      startLine: step.startLine,
      endLine: step.endLine,
      changedLines: changed,
      pureDeletion: !!file && !deleted && !inRange && step.hunkIds.length > 0,
      label: path.basename(step.file),
      note: { title: step.title, body: stepNote(step) },
    };
  }

  /** Switches the side bar to the review (changed files and tour) without taking the keyboard. */
  private async showSideBar(): Promise<void> {
    try {
      await vscode.commands.executeCommand("workbench.view.extension.reviewGuide");
      // Opening a side bar container focuses it; hand the keyboard back to the guide.
      if (this.session || this.starting) this.panel.focus();
    } catch {
      // the side bar is a convenience; a review works without it
    }
  }

  /** Keeps the current chunk selected in the changed-files view as the review moves. */
  private followInFiles(): void {
    const s = this.session;
    const view = this.filesView;
    if (!s?.tour || !view?.visible) return;
    const index = s.state.current;
    if (index < 0 || index >= s.tour.steps.length) return;
    void view.reveal({ kind: "step", index }, { select: true, focus: false, expand: true }).then(undefined, () => undefined);
  }

  /** The view of changed files: its checkboxes mark chunks read or unread by hand. */
  attachFilesView(view: vscode.TreeView<FileNode>): vscode.Disposable {
    this.filesView = view;
    return view.onDidChangeCheckboxState((e) => {
      const s = this.session;
      if (!s?.tour) return;
      const visited = new Set(s.state.visited);
      for (const [node, state] of e.items) {
        const indexes = node.kind === "file" ? node.indexes : [node.index];
        for (const i of indexes) {
          const id = s.tour.steps[i]?.id;
          if (!id) continue;
          if (state === vscode.TreeItemCheckboxState.Checked) visited.add(id);
          else visited.delete(id);
        }
      }
      s.state.visited = [...visited];
      this.saveState();
      this.syncViewed();
      this.update();
    });
  }

  async goTo(index: number, fromPanel = false): Promise<void> {
    const s = this.session;
    if (!s?.tour) return;
    const count = s.tour.steps.length;
    const i = Math.max(-1, Math.min(count, Math.floor(index)));
    s.state.current = i;
    const step = s.tour.steps[i];
    if (step) {
      if (!s.state.visited.includes(step.id)) s.state.visited.push(step.id);
      this.saveState();
      this.syncViewed();
      this.update();
      if (this.layout() === "tab") {
        // One thing on screen at a time: a step shows its code, with the note above it.
        await this.showStep(s, step, false);
      } else {
        this.panel.open();
        await this.showStep(s, step, fromPanel && !this.focus.isolate);
        // Stepping from the panel keeps the keyboard in the panel, so n and p keep working.
        if (fromPanel) this.panel.focus();
      }
    } else {
      this.saveState();
      this.syncViewed();
      await this.focus.clear();
      this.update();
      this.panel.focus();
    }
  }

  next(fromPanel = false): Promise<void> {
    return this.goTo((this.session?.state.current ?? -1) + 1, fromPanel);
  }

  prev(fromPanel = false): Promise<void> {
    return this.goTo((this.session?.state.current ?? 0) - 1, fromPanel);
  }

  async backToStep(): Promise<void> {
    const s = this.session;
    const step = s?.tour?.steps[s.state.current];
    if (s && step) await this.showStep(s, step, false);
  }

  async toggleDiff(): Promise<void> {
    this.focus.diffMode = !this.focus.diffMode;
    this.update();
    await this.reshow();
  }

  async toggleIsolate(): Promise<void> {
    this.focus.isolate = !this.focus.isolate;
    this.update();
    await this.reshow();
  }

  private async reshow(): Promise<void> {
    const s = this.session;
    const step = s?.tour?.steps[s.state.current];
    if (s && step) await this.showStep(s, step, false);
  }

  private currentStep(): Step | undefined {
    const s = this.session;
    return s?.tour?.steps[s.state.current];
  }

  // ---------- statuses and notes ----------

  async mark(status: "understood" | "concern", fromPanel = false): Promise<void> {
    const s = this.session;
    const step = this.currentStep();
    if (!s || !step) return;
    if (s.state.statuses[step.id] === status) {
      delete s.state.statuses[step.id];
      this.saveState();
      this.update();
      return;
    }
    s.state.statuses[step.id] = status;
    this.saveState();
    this.update();
    if (status === "understood") await this.next(fromPanel);
    else await this.addNote(step);
  }

  async addNote(forStep?: Step): Promise<void> {
    const s = this.session;
    if (!s) return;
    const step = forStep ?? this.currentStep();
    let file = step?.file;
    let line = step?.startLine ?? 1;
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === "file") {
      const rel = path.relative(s.root, editor.document.uri.fsPath);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        file = rel.split(path.sep).join("/");
        line = editor.selection.active.line + 1;
      }
    }
    if (!file) {
      vscode.window.showInformationMessage("Review Guide: put the cursor on a line of code to attach a note.");
      return;
    }
    const body = await vscode.window.showInputBox({
      title: `Note on ${file}:${line}`,
      prompt: "Becomes a review comment when you submit. Escape to skip.",
      ignoreFocusOut: true,
    });
    if (!body?.trim()) return;
    s.state.notes.push({ id: newId("n"), stepId: step?.id ?? "", file, line, body: body.trim() });
    this.saveState();
    this.update();
  }

  private adoptFinding(id: string): void {
    const s = this.session;
    const f = s?.findings.find((x) => x.id === id);
    if (!s || !f) return;
    const step = s.tour?.steps.find((st) => st.file === f.file && f.line <= st.endLine && f.endLine >= st.startLine);
    const note: Note = {
      id: newId("n"),
      stepId: step?.id ?? "",
      file: f.file,
      line: f.endLine,
      body: f.body ? `${f.title}\n\n${f.body}` : f.title,
      fromAgent: f.agent,
    };
    s.state.notes.push(note);
    s.state.dismissedFindings.push(id);
    this.saveState();
    this.update();
  }

  /** One-click approval of a drafted risk comment: it becomes one of the reviewer's notes. */
  private adoptRisk(index: number): void {
    const s = this.session;
    const risk = s?.tour?.riskAreas[index];
    if (!s || !risk?.comment || s.state.notes.some((n) => n.riskIndex === index)) return;
    const step = s.tour?.steps.find((st) => st.file === risk.file && risk.line >= st.startLine && risk.line <= st.endLine);
    s.state.notes.push({
      id: newId("n"),
      stepId: step?.id ?? "",
      file: risk.file,
      line: risk.line,
      body: risk.comment,
      riskIndex: index,
    });
    this.saveState();
    this.update();
  }

  /** Drafts comments for the risks of a tour generated before drafts existed. */
  private async draftRisks(): Promise<void> {
    const s = this.session;
    if (!s?.tour || s.draftingRisks || s.tour.riskAreas.length === 0) return;
    s.draftingRisks = true;
    this.update();
    try {
      s.tour.riskAreas = await draftRiskComments(s.tour, this.changeContext(s), {
        agent: this.tourAgent(),
        config: this.config(),
        cwd: s.root,
        signal: s.abort.signal,
      });
      writeJson(path.join(s.storage, `${s.key}.tour.json`), s.tour);
    } catch (e) {
      if (this.session === s) vscode.window.showWarningMessage(`Review Guide: ${(e as Error).message}`);
    }
    s.draftingRisks = false;
    if (this.session === s) this.update();
  }

  private async openLocation(file: string, line: number, endLine = line): Promise<void> {
    const s = this.session;
    if (!s) return;
    const diffFile = s.files.find((f) => f.path === file);
    await this.focus.show(
      {
        root: s.root,
        baseSha: s.baseSha,
        file,
        basePath: diffFile ? (diffFile.status === "added" ? undefined : diffFile.oldPath) : file,
        deleted: diffFile?.status === "deleted",
        startLine: line,
        endLine,
        changedLines: diffFile ? diffFile.hunks.flatMap((h) => h.addedLines) : [],
        pureDeletion: false,
        label: path.basename(file),
      },
      false,
    );
  }

  // ---------- explain selection ----------

  async explainSelection(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const editor = vscode.window.activeTextEditor;
    const step = this.currentStep();
    let file: string;
    let startLine: number;
    let endLine: number;
    let code: string;

    const where = editor?.document.uri;
    if (editor && !editor.selection.isEmpty) {
      const sel = editor.selection;
      const rel = path.relative(s.root, editor.document.uri.fsPath);
      file = editor.document.uri.scheme === "file" && !rel.startsWith("..") ? rel.split(path.sep).join("/") : editor.document.uri.path.replace(/^\//, "");
      startLine = sel.start.line + 1;
      endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      code = editor.document.getText(sel);
    } else if (step && editor) {
      file = step.file;
      startLine = step.startLine;
      endLine = Math.min(step.endLine, editor.document.lineCount);
      code = editor.document.getText(new vscode.Range(startLine - 1, 0, endLine - 1, Number.MAX_SAFE_INTEGER));
    } else {
      vscode.window.showInformationMessage("Review Guide: select the code you want explained first.");
      return;
    }

    const question = await vscode.window.showInputBox({
      title: `Explain ${file}:${startLine}-${endLine}`,
      prompt: "Optional question about this code. Press Enter for a plain explanation.",
      ignoreFocusOut: true,
    });
    if (question === undefined) return;

    const asked: Asked = {
      id: newId("a"),
      stepId: step?.id ?? "",
      file,
      startLine,
      endLine,
      question: question.trim(),
      answer: "",
      pending: true,
    };
    s.state.asked.push(asked);
    this.update();
    // The conversation appears right under the code it is about; the guide keeps a copy.
    const view = where ? this.focus.showAnswer(where, endLine - 1) : undefined;
    const talk: Conversation = { asked, code, step, view, busy: true };
    if (view) this.conversations.set(view.thread, talk);
    this.renderTalk(talk, READING);

    try {
      const res = await runAgent(
        { agent: this.tourAgent(), prompt: this.talkPrompt(s, talk), cwd: s.root, signal: s.abort.signal },
        this.config(),
      );
      asked.answer = res.text.trim() || "No answer was returned.";
    } catch (e) {
      asked.answer = `Could not get an explanation: ${(e as Error).message}`;
    }
    asked.pending = false;
    talk.busy = false;
    this.renderTalk(talk);
    if (this.session === s) {
      this.saveState();
      this.update();
    }
  }

  private renderTalk(talk: Conversation, pending?: string, question?: string): void {
    const turns = conversationTurns(talk.asked);
    if (question) turns.push({ who: "you", text: question });
    if (pending) turns.push({ who: "guide", text: pending });
    talk.view?.render(turns);
  }

  /** The prompt for a question about selected code, or for a follow-up in that conversation. */
  private talkPrompt(s: Session, talk: Conversation, followUp?: string): string {
    const { asked, step } = talk;
    const sofar = conversationTurns(asked)
      .map((turn) => `${turn.who === "you" ? "Reviewer" : turn.who === "guide" ? "You" : "Review comment you drafted"}: ${turn.text}`)
      .join("\n\n");
    return [
      "A senior engineer is reviewing a change in a codebase they do not know. They selected the code below and want to understand it.",
      followUp
        ? "They asked a follow-up question in the conversation below. Answer the follow-up directly, building on what was already said without repeating it. You are in the repository; read the surrounding code, callers and callees before answering, and say so plainly if something cannot be determined."
        : "Explain what this code does in terms of business logic and its role in the system: what it is for, what calls it, what data it reads or changes, and anything surprising. Do not explain syntax or restate the code line by line. You are in the repository; read the surrounding code, callers and callees before answering, and say so plainly if something cannot be determined.",
      "Answer briefly: one short paragraph, or a few bullets. Markdown allowed, no headings.",
      !followUp && asked.question ? `Their question: ${asked.question}` : "",
      s.tour ? `The change under review, for context:\n${s.tour.summary}` : `The change under review: ${s.title}`,
      step ? `They are currently on this review step: "${step.title}". ${step.explanation}` : "",
      `Selected code, ${asked.file} lines ${asked.startLine}-${asked.endLine}:\n\`\`\`\n${talk.code}\n\`\`\``,
      followUp ? `The conversation so far:\n\n${sofar}` : "",
      followUp ? `Their follow-up question: ${followUp}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private talkFor(arg: ThreadArg): { talk: Conversation; text: string } | undefined {
    const thread = arg && "thread" in arg ? arg.thread : arg;
    const talk = thread && this.conversations.get(thread);
    if (!talk) return undefined;
    if (talk.busy) {
      vscode.window.showInformationMessage("Review Guide is still answering in this conversation.");
      return undefined;
    }
    return { talk, text: (arg && "text" in arg ? arg.text : "").trim() };
  }

  /** A follow-up question typed into the reply box of a conversation under the code. */
  async threadAsk(arg: ThreadArg): Promise<void> {
    const s = this.session;
    const found = this.talkFor(arg);
    if (!s || !found) return;
    const { talk, text } = found;
    if (!text) {
      vscode.window.showInformationMessage("Review Guide: type your follow-up question first.");
      return;
    }
    talk.busy = true;
    this.renderTalk(talk, READING, text);
    let answer: string;
    try {
      const res = await runAgent(
        { agent: this.tourAgent(), prompt: this.talkPrompt(s, talk, text), cwd: s.root, signal: s.abort.signal },
        this.config(),
      );
      answer = res.text.trim() || "No answer was returned.";
    } catch (e) {
      answer = `Could not get an answer: ${(e as Error).message}`;
    }
    (talk.asked.more ??= []).push({ kind: "answer", question: text, answer });
    talk.busy = false;
    this.renderTalk(talk);
    if (this.session === s) {
      this.saveState();
      this.update();
    }
  }

  /**
   * Turns a conversation into a review comment on that code. Whatever is typed in the reply
   * box says what the comment should ask for; empty means "what we concluded".
   */
  async threadComment(arg: ThreadArg): Promise<void> {
    const s = this.session;
    const found = this.talkFor(arg);
    if (!s || !found) return;
    const { talk, text } = found;
    const { asked } = talk;
    talk.busy = true;
    const ask = text ? `Add a review comment: ${text}` : "Add a review comment";
    this.renderTalk(talk, "_Drafting the review comment…_", ask);

    const sofar = conversationTurns(asked)
      .map((turn) => `${turn.who === "you" ? "Reviewer" : turn.who === "guide" ? "You" : "Earlier review comment"}: ${turn.text}`)
      .join("\n\n");
    const prompt = [
      "A senior engineer is reviewing a pull request and discussed the code below with you. Write the review comment they will post on this code, based on that conversation.",
      "Write it in the first person as the reviewer speaking to the author of the change: say what the problem or open question is and under which condition it matters, then ask for the concrete change. Include a short suggested snippet in a fenced code block when the conversation settled on one. Two to five sentences besides any snippet, specific to this code, polite and direct. No praise, no hedging, no mention of AI, of this guide or of the conversation.",
      "Only claim what the conversation or the code supports; you are in the repository and may read the code to check. Output only the comment text.",
      text ? `What the reviewer wants the comment to say: ${text}` : "",
      `Change under review: ${s.tour?.title || s.title}`,
      `The code, ${asked.file} lines ${asked.startLine}-${asked.endLine}:\n\`\`\`\n${talk.code}\n\`\`\``,
      `The conversation:\n\n${sofar}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const res = await runAgent(
        { agent: this.tourAgent(), prompt, cwd: s.root, signal: s.abort.signal },
        this.config(),
      );
      const body = res.text.trim();
      if (!body) throw new Error("nothing was returned");
      // Anchor on a changed line of the selection when there is one, so GitHub shows it inline.
      let line = asked.endLine;
      for (let l = asked.endLine; l >= asked.startLine; l--) {
        if (isLineInDiff(s.files, asked.file, l)) {
          line = l;
          break;
        }
      }
      s.state.notes.push({ id: newId("n"), stepId: asked.stepId, file: asked.file, line, body });
      (asked.more ??= []).push({ kind: "comment", question: text, answer: body });
      talk.busy = false;
      this.renderTalk(talk);
    } catch (e) {
      talk.busy = false;
      this.renderTalk(talk, `Could not draft the comment: ${(e as Error).message}`, ask);
    }
    if (this.session === s) {
      this.saveState();
      this.update();
    }
  }

  /** Answers a question about a passage the reviewer selected in the guide text. */
  private async askAboutGuide(arg: { id?: string; quote?: string; question?: string }): Promise<void> {
    const s = this.session;
    const quote = String(arg?.quote ?? "").trim().slice(0, 4000);
    if (!s || !quote) return;
    const tour = s.tour;
    const step = this.currentStep();
    const where = step ? step.id : s.state.current < 0 ? "overview" : "finish";
    const asked: Asked = {
      id: String(arg.id || newId("a")),
      stepId: where,
      file: "",
      startLine: 0,
      endLine: 0,
      question: String(arg.question ?? "").trim(),
      answer: "",
      pending: true,
      quote,
    };
    s.state.asked.push(asked);
    this.update();

    const reading = step
      ? [
          `They are reading the guide's explanation of this step: "${step.title}" (${step.file} lines ${step.startLine}-${step.endLine}).`,
          `Explanation:\n${step.explanation}`,
          step.why ? `Why it changed:\n${step.why}` : "",
          step.watchFor.length ? `Things to check:\n${step.watchFor.map((w) => `- ${w}`).join("\n")}` : "",
        ]
      : [
          "They are reading the guide's overview of the change.",
          tour?.riskAreas.length ? `Risk areas listed:\n${tour.riskAreas.map((r) => `- ${r.text}`).join("\n")}` : "",
        ];
    const prompt = [
      "A senior engineer is reviewing a change in a codebase they do not know, using a written guide to the change. They selected a passage of the guide and have a question about it.",
      "Answer the question about that passage. You are in the repository at the changed version: read the code the passage talks about before answering, and correct the guide if the code shows it is wrong or imprecise. Explain business meaning and behaviour, not syntax. If something cannot be determined from the repository, say so.",
      "Answer briefly: one short paragraph, or a few bullets. Markdown allowed, no headings.",
      `The change under review: ${tour?.title || s.title}${tour ? `\n${tour.summary}` : ""}`,
      ...reading,
      `Selected passage:\n"""\n${quote}\n"""`,
      asked.question
        ? `Their question: ${asked.question}`
        : "They asked no specific question: explain this passage in more depth and more plainly, including what it implies in practice.",
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const res = await runAgent({ agent: this.tourAgent(), prompt, cwd: s.root, signal: s.abort.signal }, this.config());
      asked.answer = res.text.trim() || "No answer was returned.";
    } catch (e) {
      asked.answer = `Could not get an answer: ${(e as Error).message}`;
    }
    asked.pending = false;
    if (this.session === s) {
      this.saveState();
      this.update();
    }
  }

  // ---------- submit ----------

  async submitReview(): Promise<void> {
    const s = this.session;
    if (!s) return;
    if (!s.pr) {
      vscode.window.showInformationMessage(
        "Review Guide: this review is not tied to a GitHub PR, so there is nowhere to post it. Start the review with a PR number to submit.",
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      [
        { label: "Comment", description: "Post notes without a verdict", event: "COMMENT" as ReviewEvent },
        { label: "Approve", description: "Approve the PR", event: "APPROVE" as ReviewEvent },
        { label: "Request changes", description: "Block the PR until addressed", event: "REQUEST_CHANGES" as ReviewEvent },
      ],
      { title: `Submit review to PR #${s.pr.number}`, ignoreFocusOut: true },
    );
    if (!pick) return;
    const intro = await vscode.window.showInputBox({
      title: "Overall comment",
      prompt: "Optional summary shown at the top of your review.",
      ignoreFocusOut: true,
    });
    if (intro === undefined) return;

    const payload = buildReviewPayload(s.state.notes, s.files, pick.event, s.headSha, intro);
    if (pick.event !== "APPROVE" && !payload.body && payload.comments.length === 0) {
      vscode.window.showWarningMessage("Review Guide: there are no notes and no overall comment to post.");
      return;
    }
    const inBody = s.state.notes.length - payload.comments.length;
    const detail = [
      `${payload.comments.length} inline comment${payload.comments.length === 1 ? "" : "s"}`,
      inBody > 0 ? `${inBody} note${inBody === 1 ? "" : "s"} in the review body (their lines are outside the diff)` : "",
      "This is visible to everyone on the PR.",
    ]
      .filter(Boolean)
      .join("\n");
    const ok = await vscode.window.showWarningMessage(
      `Post "${pick.label}" review to PR #${s.pr.number}?`,
      { modal: true, detail },
      "Post review",
    );
    if (ok !== "Post review") return;

    try {
      const slug = await git.repoSlug(s.root);
      const url = await git.postReview(s.root, slug, s.pr.number, payload);
      const open = await vscode.window.showInformationMessage(`Review posted to PR #${s.pr.number}.`, "Open on GitHub");
      if (open) void vscode.env.openExternal(vscode.Uri.parse(url || s.pr.url));
    } catch (e) {
      vscode.window.showErrorMessage(`Review Guide: posting failed. ${(e as Error).message}`);
    }
  }

  // ---------- panel ----------

  focusPanel(): void {
    this.warnIfNewerInstalled();
    if (this.session || this.starting) this.panel.focus();
  }

  private async onPanelMessage(m: PanelMessage): Promise<void> {
    const s = this.session;
    if (!s || this.starting) {
      if (m.type !== "command") return;
      if (m.command === "cancel") this.cancelStart();
      else if (m.command === "restart") {
        this.cancelStart();
        await this.start();
      }
      return;
    }
    if (m.type === "diagramError") {
      await this.repair(m.id, m.error);
      return;
    }
    if (m.type !== "command") return;
    const arg = m.arg as any;
    switch (m.command) {
      case "shortcuts":
        return this.showShortcuts();
      case "next":
        return this.next(true);
      case "prev":
        return this.prev(true);
      case "goTo":
        return this.goTo(Number(arg), true);
      case "overview":
        return this.goTo(-1, true);
      case "finish":
        return this.goTo(s.tour?.steps.length ?? 0, true);
      case "understood":
        return this.mark("understood", true);
      case "concern":
        return this.mark("concern", true);
      case "note":
        return this.addNote();
      case "diff":
        return this.toggleDiff();
      case "isolate":
        return this.toggleIsolate();
      case "code":
        return this.backToStep();
      case "explain":
        return this.explainSelection();
      case "submit":
        return this.submitReview();
      case "regenerate":
        return this.regenerate();
      case "runReviewers":
        return this.runReviewers();
      case "cancel":
        return this.stop();
      case "adoptFinding":
        return this.adoptFinding(String(arg));
      case "dismissFinding":
        s.state.dismissedFindings.push(String(arg));
        this.saveState();
        return this.update();
      case "openLocation":
        return this.openLocation(String(arg.file), Number(arg.line), Number(arg.endLine ?? arg.line));
      case "deleteNote":
        s.state.notes = s.state.notes.filter((n) => n.id !== arg);
        this.saveState();
        return this.update();
      case "deleteAsked":
        s.state.asked = s.state.asked.filter((a) => a.id !== arg);
        this.saveState();
        return this.update();
      case "adoptRisk":
        return this.adoptRisk(Number(arg));
      case "draftRisks":
        return this.draftRisks();
      case "eli5":
        return this.addEli5(arg === "rewrite");
      case "askGuide":
        return this.askAboutGuide(arg);
      case "openPr":
        if (s.pr) void vscode.env.openExternal(vscode.Uri.parse(s.pr.url));
        return;
    }
  }

  /** Adds the beginner explanation to a tour generated before that section existed. */
  private async addEli5(rewrite = false): Promise<void> {
    const s = this.session;
    if (!s?.tour || s.writingEli5 || (s.tour.eli5 && !rewrite)) return;
    s.writingEli5 = true;
    this.update();
    try {
      s.tour.eli5 = await writeEli5(s.tour, {
        agent: this.tourAgent(),
        config: this.config(),
        cwd: s.root,
        signal: s.abort.signal,
      });
      writeJson(path.join(s.storage, `${s.key}.tour.json`), s.tour);
    } catch (e) {
      if (this.session === s) vscode.window.showWarningMessage(`Review Guide: ${(e as Error).message}`);
    }
    s.writingEli5 = false;
    if (this.session === s) this.update();
  }

  private async repair(id: string, error: string): Promise<void> {
    const s = this.session;
    const diagram = s?.tour?.diagrams.find((d) => d.id === id);
    if (!s || !diagram || s.repairTried.has(id)) return;
    s.repairTried.add(id);
    s.repairing.add(id);
    this.update();
    try {
      diagram.mermaid = await repairDiagram(diagram, error, {
        agent: this.tourAgent(),
        config: this.config(),
        cwd: s.root,
        signal: s.abort.signal,
      });
      writeJson(path.join(s.storage, `${s.key}.tour.json`), s.tour);
    } catch {
      // keep the original; the panel shows its source
    }
    s.repairing.delete(id);
    if (this.session === s) this.update();
  }

  // ---------- shortcuts ----------

  /** A list of every shortcut; picking an editor shortcut runs it. */
  async showShortcuts(): Promise<void> {
    type Item = vscode.QuickPickItem & { command?: string };
    const mac = process.platform === "darwin";
    const pretty = (key: string) =>
      key === "shift+/"
        ? "?"
        : key
            .split("+")
            .map((k) => (mac ? ({ alt: "⌥", ctrl: "⌃", shift: "⇧", cmd: "⌘" } as Record<string, string>)[k] ?? k.toUpperCase() : k.length > 1 ? k[0].toUpperCase() + k.slice(1) : k.toUpperCase()))
            .join(mac ? "" : "+");
    const titles = new Map<string, string>(
      (this.manifest?.contributes?.commands ?? []).map((x: any) => [x.command, x.title]),
    );
    const items: Item[] = [{ label: "In the code editor, while a review is active", kind: vscode.QuickPickItemKind.Separator }];
    for (const b of this.manifest?.contributes?.keybindings ?? []) {
      const vimOnly = String(b.when ?? "").includes("vim.mode");
      items.push({
        label: vimOnly ? (b.key === "shift+/" ? "?" : String(b.key).replace(" ", "")) : pretty(b.key),
        description: `${titles.get(b.command) ?? b.command}${vimOnly ? "  (Vim)" : ""}`,
        command: b.command,
      });
    }
    items.push({ label: "In the guide tab", kind: vscode.QuickPickItemKind.Separator });
    const guide: [string, string][] = [
      ["n  /  l", "Next step"],
      ["p  /  h", "Previous step"],
      ["u", "Mark understood and go to the next step"],
      ["x", "Mark as concern and write a note"],
      ["c", "Add a note"],
      ["e", "Explain the selection or the current chunk"],
      ["a", "Ask about the guide text you selected"],
      ["d", "Toggle diff view"],
      ["i", "Toggle isolate chunk"],
      ["b", "Jump to the code of this step"],
      ["o", "Overview"],
      ["f", "Finish screen"],
      ["j  /  k", "Scroll down / up"],
      [mac ? "⌃D  /  ⌃U" : "Ctrl+D  /  Ctrl+U", "Scroll half a page down / up"],
      ["gg  /  G", "Top / bottom"],
      ["?", "This list"],
      ["Esc", "Close a popup"],
    ];
    for (const [label, description] of guide) items.push({ label, description });
    const pick = await vscode.window.showQuickPick(items, {
      title: "Review Guide shortcuts",
      placeHolder: "Type to filter. Enter runs an editor shortcut.",
      matchOnDescription: true,
    });
    if (pick?.command && pick.command !== "reviewGuide.showShortcuts") await vscode.commands.executeCommand(pick.command);
  }

  // ---------- GitHub "Viewed" ----------

  /**
   * Ticks "Viewed" on GitHub for every file whose chunks are all read, and unticks a file
   * that stops being fully read. Runs one at a time, in the background.
   */
  private syncViewed(): void {
    const s = this.session;
    const pr = s?.pr;
    if (!s || !pr?.id || !s.tour) return;
    if (!vscode.workspace.getConfiguration("reviewGuide").get("syncViewedToGitHub", true)) return;
    const v = s.viewed;
    v.queue = v.queue.then(async () => {
      if (this.session !== s || !s.tour) return;
      try {
        v.onGitHub ??= await git.viewedFiles(s.root, pr.id);
        const done = fullyReadFiles(s.tour.steps, s.state.visited);
        const plan = planViewedSync(done, v.previouslyDone, v.onGitHub);
        for (const file of plan.mark) {
          await git.setFileViewed(s.root, pr.id, file, true);
          v.onGitHub.add(file);
        }
        for (const file of plan.unmark) {
          await git.setFileViewed(s.root, pr.id, file, false);
          v.onGitHub.delete(file);
        }
        v.previouslyDone = done;
        if (this.session === s) this.update();
      } catch (e) {
        if (v.warned) return;
        v.warned = true;
        void vscode.window.showWarningMessage(
          `Review Guide could not update "Viewed" on GitHub: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    });
  }

  // ---------- state ----------

  private saveState(): void {
    const s = this.session;
    if (!s) return;
    try {
      writeJson(path.join(s.storage, `${s.key}.state.json`), {
        ...s.state,
        asked: s.state.asked.filter((a) => !a.pending),
      });
    } catch {
      // losing progress persistence must not break the review
    }
  }

  model(): ViewModel | undefined {
    const s = this.session;
    if (!s) return undefined;
    const dismissed = new Set(s.state.dismissedFindings);
    return {
      phase: s.phase,
      error: s.error,
      progress: s.progress.slice(-40),
      title: s.tour?.title || s.title,
      version: this.version,
      root: s.root,
      subtitle: s.pr ? `PR #${s.pr.number} by ${s.pr.author} · ${s.pr.headRefName} → ${s.pr.baseRefName}` : `Local branch ${s.title}`,
      prUrl: s.pr?.url,
      canSubmit: !!s.pr,
      stats: diffStats(s.files),
      tour: s.tour,
      state: s.state,
      reviewers: s.reviewers,
      findings: sortFindings(markAgreement(s.findings)).filter((f) => !dismissed.has(f.id)),
      totalHunks: allHunks(s.files).length,
      isolate: this.focus.isolate,
      diffMode: this.focus.diffMode,
      repairing: [...s.repairing],
      writingEli5: s.writingEli5,
      draftingRisks: s.draftingRisks,
      viewedOnGitHub: [...(s.viewed.onGitHub ?? [])],
    };
  }

  private update(): void {
    const model = this.model();
    this.tree.update(model);
    this.filesTree.update(model);
    if (this.filesView) {
      const p = fileProgress(model);
      const show = !!model?.tour;
      this.filesView.description = show
        ? `${p.left} of ${p.total} left${p.partial ? ` · ${p.partial} partly read` : ""}`
        : undefined;
      this.followInFiles();
      this.filesView.badge = show && p.left > 0 ? { value: p.left, tooltip: `${p.left} changed files left to read` } : undefined;
    }
    // While another review is being started, the panel shows that start's progress.
    if (model && !this.starting) this.panel.update(model);
    this.refreshStatus();
  }

  private refreshStatus(): void {
    const s = this.session;
    if (!s && this.starting && !this.starting.failed) {
      this.status.text = "$(sync~spin) Review: opening";
      this.status.tooltip = "Review Guide is preparing the change";
      this.status.command = "reviewGuide.focusPanel";
      return;
    }
    if (!s) {
      this.status.text = "$(checklist) Review Guide";
      this.status.tooltip = "Start a guided code review";
      this.status.command = "reviewGuide.start";
      return;
    }
    this.status.command = "reviewGuide.focusPanel";
    if (s.phase === "generating") {
      this.status.text = "$(sync~spin) Review: preparing tour";
    } else if (s.tour) {
      const total = s.tour.steps.length;
      const done = s.tour.steps.filter((st) => s.state.statuses[st.id] === "understood").length;
      this.status.text = `$(checklist) Review ${done}/${total} understood`;
    } else {
      this.status.text = "$(checklist) Review Guide";
    }
    this.status.tooltip = "Open the Review Guide panel";
  }

  async stop(closePanel = true): Promise<void> {
    const s = this.session;
    if (!s) return;
    s.abort.abort();
    this.saveState();
    this.session = undefined;
    // An ended review stays ended; a reload (which never gets here) brings it back.
    fs.rmSync(path.join(s.storage, RESUME_FILE), { force: true });
    await this.focus.clear();
    await vscode.commands.executeCommand("setContext", "reviewGuide.active", false);
    this.update();
    if (closePanel) this.panel.dispose();
    this.refreshStatus();
  }

  dispose(): void {
    this.session?.abort.abort();
    this.focus.dispose();
    this.panel.dispose();
    this.status.dispose();
  }
}
