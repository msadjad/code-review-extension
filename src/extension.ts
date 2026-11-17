import * as vscode from "vscode";
import { Controller } from "./controller";
import { AskLens } from "./askLens";
import { BASE_SCHEME, BaseContentProvider } from "./editorFocus";

export function activate(context: vscode.ExtensionContext): { controller: Controller } {
  const controller = new Controller(context);
  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  context.subscriptions.push(
    controller,
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, new BaseContentProvider()),
    vscode.window.createTreeView("reviewGuide.steps", { treeDataProvider: controller.tree }),
  );
  const filesView = vscode.window.createTreeView("reviewGuide.files", {
    treeDataProvider: controller.filesTree,
    manageCheckboxStateManually: true,
  });
  context.subscriptions.push(filesView, controller.attachFilesView(filesView));

  const askLens = new AskLens(() => controller.active);
  context.subscriptions.push(
    askLens,
    vscode.languages.registerCodeLensProvider([{ scheme: "file" }, { scheme: BASE_SCHEME }], askLens),
  );

  reg("reviewGuide.start", () => controller.start());
  reg("reviewGuide.startLocal", (root: string, base?: string) => controller.startLocal(root, base));
  reg("reviewGuide.regenerate", () => controller.regenerate());
  reg("reviewGuide.runReviewers", () => controller.runReviewers());
  reg("reviewGuide.next", () => controller.next());
  reg("reviewGuide.prev", () => controller.prev());
  reg("reviewGuide.goToStep", (index: number) => controller.goTo(index));
  reg("reviewGuide.overview", () => controller.goTo(-1));
  reg("reviewGuide.finish", () => controller.goTo(Number.MAX_SAFE_INTEGER));
  reg("reviewGuide.backToStep", () => controller.backToStep());
  reg("reviewGuide.markUnderstood", () => controller.mark("understood"));
  reg("reviewGuide.markConcern", () => controller.mark("concern"));
  reg("reviewGuide.addNote", () => controller.addNote());
  reg("reviewGuide.toggleDiff", () => controller.toggleDiff());
  reg("reviewGuide.toggleIsolate", () => controller.toggleIsolate());
  reg("reviewGuide.explainSelection", () => controller.explainSelection());
  reg("reviewGuide.threadAsk", (arg) => controller.threadAsk(arg));
  reg("reviewGuide.threadComment", (arg) => controller.threadComment(arg));
  reg("reviewGuide.showShortcuts", () => controller.showShortcuts());
  reg("reviewGuide.focusPanel", () => controller.focusPanel());
  reg("reviewGuide.submitReview", () => controller.submitReview());
  reg("reviewGuide.stop", () => controller.stop());

  // A review handed over from another window starts as soon as this one is ready, or,
  // if this window was already open, when it gets focus. Failing that, the review that
  // was open before the window was reloaded comes back.
  void controller.resumeAfterReload();
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((w) => {
      if (w.focused) void controller.resumeHandedOver();
    }),
  );

  return { controller };
}

export function deactivate(): void {}
