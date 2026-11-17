import * as vscode from "vscode";

/**
 * Shows "Ask Review Guide about this" right above a selection while a review is active,
 * so asking about code is one click away from where the code was selected.
 */
export class AskLens implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subs: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private shown = "";

  constructor(private readonly isActive: () => boolean) {
    this.subs.push(
      vscode.window.onDidChangeTextEditorSelection((e) => this.schedule(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
    );
  }

  /** Lenses shift the text by a line, so only re-ask for them when the selection settles on a new place. */
  private schedule(editor: vscode.TextEditor): void {
    const key = this.keyOf(editor);
    if (key === this.shown) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.shown = key;
      this.changed.fire();
    }, 250);
  }

  refresh(): void {
    this.shown = "";
    this.changed.fire();
  }

  private keyOf(editor: vscode.TextEditor): string {
    if (!this.isActive() || editor.selection.isEmpty) return "";
    return `${editor.document.uri.toString()}:${editor.selection.start.line}`;
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.isActive()) return [];
    if (!vscode.workspace.getConfiguration("reviewGuide").get("askLens", true)) return [];
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document || editor.selection.isEmpty) return [];
    const line = editor.selection.start.line;
    return [
      new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
        title: "$(comment-discussion) Ask Review Guide about this",
        tooltip: "Ask a question about the selected code (alt+e)",
        command: "reviewGuide.explainSelection",
      }),
    ];
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.changed.dispose();
    this.subs.forEach((s) => s.dispose());
  }
}
