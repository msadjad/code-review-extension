import * as vscode from "vscode";
import * as path from "node:path";
import type { ViewModel } from "./viewModel";

export type FileNode = { kind: "file"; path: string; indexes: number[] } | { kind: "step"; index: number };

export interface FileProgress {
  total: number;
  done: number;
  partial: number;
  left: number;
}

/** Groups tour steps by file, in the order the tour first reaches each file. */
export function fileGroups(model: ViewModel | undefined): { path: string; indexes: number[] }[] {
  const groups = new Map<string, number[]>();
  model?.tour?.steps.forEach((s, i) => {
    const list = groups.get(s.file);
    if (list) list.push(i);
    else groups.set(s.file, [i]);
  });
  return [...groups].map(([p, indexes]) => ({ path: p, indexes }));
}

export function fileProgress(model: ViewModel | undefined): FileProgress {
  const out = { total: 0, done: 0, partial: 0, left: 0 };
  if (!model?.tour) return out;
  const read = new Set(model.state.visited);
  for (const g of fileGroups(model)) {
    const n = g.indexes.filter((i) => read.has(model.tour!.steps[i].id)).length;
    out.total++;
    if (n === g.indexes.length) out.done++;
    else if (n > 0) out.partial++;
  }
  out.left = out.total - out.done;
  return out;
}

/**
 * Every changed file with a checkbox: checked once all of its chunks have been read,
 * with the read count shown while it is only partly read. Chunks are listed underneath.
 */
export class FilesTree implements vscode.TreeDataProvider<FileNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private model?: ViewModel;

  update(model: ViewModel | undefined): void {
    this.model = model;
    this.changed.fire();
  }

  getParent(node: FileNode): FileNode | undefined {
    if (node.kind !== "step") return undefined;
    const group = fileGroups(this.model).find((g) => g.indexes.includes(node.index));
    return group ? { kind: "file", ...group } : undefined;
  }

  getChildren(node?: FileNode): FileNode[] {
    if (!this.model?.tour) return [];
    if (!node) return fileGroups(this.model).map((g) => ({ kind: "file", ...g }));
    if (node.kind === "file") return node.indexes.map((index) => ({ kind: "step", index }));
    return [];
  }

  getTreeItem(node: FileNode): vscode.TreeItem {
    const m = this.model!;
    const steps = m.tour!.steps;
    const read = new Set(m.state.visited);
    const { Checked, Unchecked } = vscode.TreeItemCheckboxState;

    if (node.kind === "file") {
      const n = node.indexes.filter((i) => read.has(steps[i].id)).length;
      const total = node.indexes.length;
      const current = node.indexes.includes(m.state.current);
      const item = new vscode.TreeItem(
        path.basename(node.path),
        current ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `file:${node.path}`;
      item.resourceUri = vscode.Uri.file(path.join(m.root, node.path));
      const dir = path.dirname(node.path);
      const onGitHub = n === total && m.viewedOnGitHub?.includes(node.path);
      const state = onGitHub ? "read, viewed on GitHub" : n === total ? "read" : n > 0 ? `${n}/${total} read` : `${total} to read`;
      item.description = `${state}${dir === "." ? "" : `  ·  ${dir}`}`;
      item.tooltip = `${node.path}\n${n} of ${total} chunk${total === 1 ? "" : "s"} read`;
      item.checkboxState = {
        state: n === total ? Checked : Unchecked,
        tooltip: onGitHub ? "All chunks read. Ticked as Viewed on GitHub" : n === total ? "All chunks read" : n > 0 ? `Partly read: ${n} of ${total}` : "Not read yet",
        accessibilityInformation: { label: `${node.path}: ${n} of ${total} chunks read` },
      };
      const next = node.indexes.find((i) => !read.has(steps[i].id)) ?? node.indexes[0];
      item.command = { command: "reviewGuide.goToStep", title: "Open next unread chunk", arguments: [next] };
      return item;
    }

    const step = steps[node.index];
    const isRead = read.has(step.id);
    const status = m.state.statuses[step.id];
    const item = new vscode.TreeItem(`${node.index + 1}. ${step.title}`);
    item.id = `step:${step.id}`;
    item.description = `${step.startLine}-${step.endLine}${status ? `  ·  ${status}` : ""}`;
    item.iconPath =
      m.state.current === node.index
        ? new vscode.ThemeIcon("arrow-right")
        : status === "concern"
          ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("editorWarning.foreground"))
          : undefined;
    item.checkboxState = { state: isRead ? Checked : Unchecked, tooltip: isRead ? "Read" : "Not read yet" };
    item.command = { command: "reviewGuide.goToStep", title: "Open chunk", arguments: [node.index] };
    return item;
  }
}
