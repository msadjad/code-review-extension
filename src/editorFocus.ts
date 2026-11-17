import * as vscode from "vscode";
import type { Turn } from "./notes";
import * as path from "node:path";
import { showFile } from "./git";

export const BASE_SCHEME = "review-base";

/** Serves file contents at the base commit, for the left side of the diff view. */
export class BaseContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      const { root, ref, file } = JSON.parse(uri.query);
      if (!file) return "";
      return await showFile(root, ref, file);
    } catch {
      return "";
    }
  }
}

export function baseUri(root: string, ref: string, file: string | undefined): vscode.Uri {
  const name = file ?? "empty";
  return vscode.Uri.from({
    scheme: BASE_SCHEME,
    path: "/" + name,
    query: JSON.stringify({ root, ref, file: file ?? "" }),
  });
}

export interface ChunkTarget {
  root: string;
  baseSha: string;
  file: string;
  /** Path at the base commit, undefined for added files. */
  basePath?: string;
  deleted: boolean;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** 1-based new-file lines that the change added or modified. */
  changedLines: number[];
  /** The chunk only removes lines, so it is only visible in a diff. */
  pureDeletion: boolean;
  label: string;
  /** Short explanation shown inline, directly above the chunk. */
  note?: { title: string; body: string };
}

interface Applied {
  uri: string;
  start: number;
  end: number;
  changed: number[];
}

export interface AnswerThread {
  thread: vscode.CommentThread;
  render(turns: Turn[]): void;
}

export class EditorFocus implements vscode.Disposable {
  isolate = false;
  diffMode = false;

  private readonly dim = vscode.window.createTextEditorDecorationType({ opacity: "0.38" });
  private readonly changed = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly edge = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: "0 0 0 2px",
    borderStyle: "solid",
    borderColor: new vscode.ThemeColor("focusBorder"),
  });

  private readonly notes = this.createNotes();
  private noteThread?: vscode.CommentThread;
  private answerThreads: vscode.CommentThread[] = [];
  private applied?: Applied;
  private isolatedUri?: string;
  private staleIsolated = new Set<string>();
  private readonly sub: vscode.Disposable;

  /** @param pickColumn chooses the editor group code opens in, given where the guide is. */
  constructor(private readonly pickColumn: () => vscode.ViewColumn = () => vscode.ViewColumn.One) {
    this.sub = vscode.window.onDidChangeVisibleTextEditors(() => this.decorate());
  }

  /** Opens the chunk in a real editor and narrows attention to it. Returns the editor column used. */
  async show(target: ChunkTarget, preserveFocus: boolean): Promise<void> {
    const fileUri = vscode.Uri.file(path.join(target.root, target.file));
    const left = baseUri(target.root, target.baseSha, target.basePath);
    const useDiff = !target.deleted && (this.diffMode || target.pureDeletion);
    const docUri = target.deleted ? left : fileUri;

    await this.releaseIsolate(docUri.toString());

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(docUri);
    } catch (e) {
      vscode.window.showWarningMessage(`Review Guide: cannot open ${target.file}: ${(e as Error).message}`);
      return;
    }
    const last = Math.max(0, doc.lineCount - 1);
    const start = Math.min(Math.max(0, target.startLine - 1), last);
    const end = Math.min(Math.max(start, target.endLine - 1), last);
    const firstChanged = target.changedLines.find((l) => l - 1 >= start && l - 1 <= end);
    const cursor = new vscode.Position(firstChanged ? firstChanged - 1 : start, 0);
    const selection = new vscode.Range(cursor, cursor);
    const column = this.codeColumn();

    this.applied = {
      uri: docUri.toString(),
      start,
      end,
      changed: target.deleted ? [] : target.changedLines.map((l) => l - 1).filter((l) => l >= start && l <= end),
    };

    if (useDiff) {
      await vscode.commands.executeCommand("vscode.diff", left, fileUri, `${target.label} (base ↔ change)`, {
        viewColumn: column,
        preserveFocus,
        selection,
        preview: true,
      });
    } else {
      await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus, selection, preview: true });
    }

    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === docUri.toString());
    if (editor) {
      const range = new vscode.Range(start, 0, end, 0);
      const tall = end - start > 30;
      editor.revealRange(range, tall ? vscode.TextEditorRevealType.AtTop : vscode.TextEditorRevealType.InCenter);
    }
    this.decorate();
    if (this.isolate && !useDiff && editor) await this.applyIsolate(docUri, start, end, cursor, preserveFocus);
    this.showNote(docUri, start, target.note, this.isolate && !useDiff);
  }

  /**
   * Puts the note in the editor as a read-only comment. A thread renders below the line it
   * is anchored to, so anchoring on the line before the chunk places it right above the code.
   * With isolate that line is folded away, so the note goes under the chunk's first line.
   */
  /**
   * Shows a question about selected code right under that code, and returns a function
   * that fills in the answer when it arrives.
   */
  /**
   * Opens a conversation thread under a line. The reply box at its bottom takes follow-up
   * questions; `render` replaces what the thread shows.
   */
  showAnswer(uri: vscode.Uri, line: number, kind: "answer" | "note" = "answer", collapsed = false): AnswerThread {
    const thread = this.notes.createCommentThread(uri, new vscode.Range(line, 0, line, 0), []);
    thread.label = kind === "note" ? "Your review comment, posted when you submit the review" : "Question about this code";
    thread.contextValue = kind;
    thread.canReply = kind === "answer";
    thread.collapsibleState = collapsed
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
    this.answerThreads.push(thread);
    const names = { you: "You", guide: "Review Guide", comment: "Review comment, added to your review" };
    return {
      thread,
      render: (turns) => {
        if (!this.answerThreads.includes(thread)) return;
        thread.comments = turns.map((turn) => ({
          body: new vscode.MarkdownString(turn.text),
          mode: vscode.CommentMode.Preview,
          author: { name: names[turn.who] },
        }));
      },
    };
  }

  private createNotes(): vscode.CommentController {
    const c = vscode.comments.createCommentController("reviewGuide.notes", "Review Guide");
    c.options = { prompt: "Ask a follow-up…", placeHolder: "Follow-up question, or what the review comment should say" };
    return c;
  }

  private clearAnswers(): void {
    this.answerThreads.forEach((t) => t.dispose());
    this.answerThreads = [];
  }

  private showNote(uri: vscode.Uri, start: number, note: ChunkTarget["note"], folded: boolean): void {
    this.noteThread?.dispose();
    this.noteThread = undefined;
    this.clearAnswers();
    if (!note?.body.trim()) return;
    const line = folded || start === 0 ? start : start - 1;
    const body = new vscode.MarkdownString(note.body.trim());
    const thread = this.notes.createCommentThread(uri, new vscode.Range(line, 0, line, 0), [
      { body, mode: vscode.CommentMode.Preview, author: { name: "Review Guide" } },
    ]);
    thread.label = note.title;
    thread.canReply = false;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.noteThread = thread;
  }

  private codeColumn(): vscode.ViewColumn {
    return this.pickColumn();
  }

  private decorate(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const a = this.applied;
      if (!a || editor.document.uri.toString() !== a.uri) {
        editor.setDecorations(this.dim, []);
        editor.setDecorations(this.changed, []);
        editor.setDecorations(this.edge, []);
        continue;
      }
      const last = editor.document.lineCount - 1;
      const outside: vscode.Range[] = [];
      if (a.start > 0) outside.push(new vscode.Range(0, 0, a.start - 1, Number.MAX_SAFE_INTEGER));
      if (a.end < last) outside.push(new vscode.Range(a.end + 1, 0, last, Number.MAX_SAFE_INTEGER));
      editor.setDecorations(this.dim, outside);
      editor.setDecorations(this.edge, [new vscode.Range(a.start, 0, a.end, 0)]);
      editor.setDecorations(
        this.changed,
        this.diffMode ? [] : a.changed.map((l) => new vscode.Range(l, 0, l, 0)),
      );
    }
  }

  /** Folds everything outside the chunk so only that piece of code is on screen. */
  private async applyIsolate(
    uri: vscode.Uri,
    start: number,
    end: number,
    cursor: vscode.Position,
    preserveFocus: boolean,
  ): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    // Folding commands act on the focused editor.
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: this.codeColumnOf(uri), preserveFocus: false });
    const last = doc.lineCount - 1;
    const fold = async (from: number, to: number) => {
      if (to - from < 1) return;
      editor.selection = new vscode.Selection(from, 0, to, doc.lineAt(to).text.length);
      await vscode.commands.executeCommand("editor.createFoldingRangeFromSelection");
    };
    await fold(0, start - 1);
    await fold(end + 1, last);
    editor.selection = new vscode.Selection(cursor, cursor);
    editor.revealRange(new vscode.Range(start, 0, end, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.isolatedUri = uri.toString();
    void preserveFocus;
  }

  private codeColumnOf(uri: vscode.Uri): vscode.ViewColumn | undefined {
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())?.viewColumn;
  }

  /** Removes the folds created by isolate. Files that are not visible are cleaned when next shown. */
  private async releaseIsolate(nextUri?: string): Promise<void> {
    const targets = new Set<string>();
    if (this.isolatedUri) targets.add(this.isolatedUri);
    if (nextUri && this.staleIsolated.has(nextUri)) targets.add(nextUri);
    this.isolatedUri = undefined;
    for (const uri of targets) {
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
      if (!editor) {
        if (uri !== nextUri) this.staleIsolated.add(uri);
        continue;
      }
      const focused = await vscode.window.showTextDocument(editor.document, {
        viewColumn: editor.viewColumn,
        preserveFocus: false,
      });
      const keep = focused.selection;
      const last = focused.document.lineCount - 1;
      focused.selection = new vscode.Selection(0, 0, last, focused.document.lineAt(last).text.length);
      await vscode.commands.executeCommand("editor.removeManualFoldingRanges");
      focused.selection = new vscode.Selection(keep.active, keep.active);
      this.staleIsolated.delete(uri);
    }
  }

  async clear(): Promise<void> {
    await this.releaseIsolate();
    this.clearAnswers();
    this.noteThread?.dispose();
    this.noteThread = undefined;
    this.applied = undefined;
    this.decorate();
  }

  dispose(): void {
    this.sub.dispose();
    this.clearAnswers();
    this.noteThread?.dispose();
    this.notes.dispose();
    this.dim.dispose();
    this.changed.dispose();
    this.edge.dispose();
  }
}
