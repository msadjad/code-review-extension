import * as vscode from "vscode";
import type { ViewModel } from "./viewModel";
import { findingsForRange } from "./reviewers";

type Node =
  | { kind: "overview" }
  | { kind: "finish" }
  | { kind: "section"; title: string; indexes: number[] }
  | { kind: "step"; index: number };

export class StepsTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private model?: ViewModel;

  update(model: ViewModel | undefined): void {
    this.model = model;
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    const tour = this.model?.tour;
    if (!tour) return [];
    if (node?.kind === "section") return node.indexes.map((index) => ({ kind: "step", index }));
    if (node) return [];
    const sections: Extract<Node, { kind: "section" }>[] = [];
    tour.steps.forEach((s, i) => {
      const last = sections[sections.length - 1];
      if (last && last.title === s.section) last.indexes.push(i);
      else sections.push({ kind: "section", title: s.section, indexes: [i] });
    });
    return [{ kind: "overview" }, ...sections, { kind: "finish" }];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const m = this.model!;
    const tour = m.tour!;
    if (node.kind === "overview" || node.kind === "finish") {
      const isOverview = node.kind === "overview";
      const item = new vscode.TreeItem(isOverview ? "Overview and diagrams" : "Finish and submit");
      const current = isOverview ? m.state.current === -1 : m.state.current >= tour.steps.length;
      item.iconPath = new vscode.ThemeIcon(current ? "arrow-right" : isOverview ? "book" : "checklist");
      item.command = { command: isOverview ? "reviewGuide.overview" : "reviewGuide.finish", title: "Open" };
      return item;
    }
    if (node.kind === "section") {
      const done = node.indexes.filter((i) => m.state.statuses[tour.steps[i].id] === "understood").length;
      const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${done}/${node.indexes.length}`;
      return item;
    }
    const step = tour.steps[node.index];
    const status = m.state.statuses[step.id];
    const current = m.state.current === node.index;
    const flagged = findingsForRange(m.findings, step.file, step.startLine, step.endLine).length;
    const item = new vscode.TreeItem(`${node.index + 1}. ${step.title}`);
    const file = step.file.split("/").pop();
    item.description = `${file}:${step.startLine}${flagged ? `  ·  ${flagged} finding${flagged > 1 ? "s" : ""}` : ""}`;
    item.tooltip = `${step.file}:${step.startLine}-${step.endLine}`;
    item.iconPath = current
      ? new vscode.ThemeIcon("arrow-right")
      : status === "understood"
        ? new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"))
        : status === "concern"
          ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("editorWarning.foreground"))
          : new vscode.ThemeIcon(m.state.visited.includes(step.id) ? "circle-filled" : "circle-outline");
    item.accessibilityInformation = {
      label: `Step ${node.index + 1}: ${step.title}. ${status ?? (current ? "current" : "not reviewed")}`,
    };
    item.command = { command: "reviewGuide.goToStep", title: "Open step", arguments: [node.index] };
    return item;
  }
}
