import * as vscode from "vscode";
import type { ViewModel } from "./viewModel";

export type PanelMessage =
  | { type: "ready" }
  | { type: "command"; command: string; arg?: unknown }
  | { type: "diagramError"; id: string; error: string };

export class Panel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private ready = false;
  private last?: ViewModel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (m: PanelMessage) => void,
    private readonly onClosed: () => void,
    /** "tab": the guide is a tab among the code tabs. "split": it sits in its own group beside the code. */
    private readonly layout: () => "tab" | "split" = () => "tab",
  ) {}

  get visible(): boolean {
    return !!this.panel;
  }

  get column(): vscode.ViewColumn | undefined {
    return this.panel?.viewColumn;
  }

  get focused(): boolean {
    return !!this.panel?.active;
  }

  /**
   * Makes sure the guide exists. In the split layout it is also brought to the front of its
   * own group; as a tab it is left alone, because revealing it would cover the code.
   */
  open(): void {
    if (this.panel) {
      if (this.layout() === "split") this.panel.reveal(undefined, true);
      return;
    }
    const split = this.layout() === "split";
    const beside = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Two;
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    this.panel = vscode.window.createWebviewPanel(
      "reviewGuide",
      "Review Guide",
      split
        ? { viewColumn: beside, preserveFocus: true }
        : { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] },
    );
    this.ready = false;
    this.panel.webview.html = this.html(this.panel.webview, dist);
    this.panel.webview.onDidReceiveMessage((m: PanelMessage) => {
      if (m.type === "ready") {
        this.ready = true;
        if (this.last) void this.panel?.webview.postMessage({ type: "state", model: this.last });
        return;
      }
      this.onMessage(m);
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
      this.onClosed();
    });
  }

  focus(): void {
    this.open();
    this.panel?.reveal(undefined, false);
  }

  update(model: ViewModel): void {
    this.last = model;
    if (this.panel) this.panel.title = model.title ? `Review: ${model.title}`.slice(0, 40) : "Review Guide";
    if (this.panel && this.ready) void this.panel.webview.postMessage({ type: "state", model });
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.css"));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
<title>Review Guide</title>
</head>
<body>
<main id="app" tabindex="-1"></main>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
