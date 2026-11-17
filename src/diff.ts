export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffLine {
  kind: "context" | "add" | "del";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface Hunk {
  id: string;
  /** Path used to address the file in the tour: new path, or old path for deleted files. */
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /** New-file line numbers that were added or modified. */
  addedLines: number[];
  removedCount: number;
}

export interface DiffFile {
  path: string;
  oldPath: string;
  status: FileStatus;
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p);
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

function stripPrefix(p: string): string {
  p = unquote(p.trim());
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

/** Parses `git diff` unified output into files and hunks. Hunk ids are h1, h2, … in order. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: Hunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let counter = 0;

  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(raw);
      file = {
        path: m ? m[2] : "",
        oldPath: m ? m[1] : "",
        status: "modified",
        binary: false,
        hunks: [],
      };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;

    if (!hunk || !isHunkBody(raw, hunk, oldLine, newLine)) {
      if (raw.startsWith("new file mode")) file.status = "added";
      else if (raw.startsWith("deleted file mode")) file.status = "deleted";
      else if (raw.startsWith("rename from ")) {
        file.status = "renamed";
        file.oldPath = unquote(raw.slice("rename from ".length));
      } else if (raw.startsWith("rename to ")) {
        file.path = unquote(raw.slice("rename to ".length));
      } else if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
        file.binary = true;
      } else if (raw.startsWith("--- ")) {
        const p = stripPrefix(raw.slice(4));
        if (p !== "/dev/null") file.oldPath = p;
      } else if (raw.startsWith("+++ ")) {
        const p = stripPrefix(raw.slice(4));
        if (p !== "/dev/null") file.path = p;
      }
    }

    const h = HUNK_HEADER.exec(raw);
    if (h) {
      counter++;
      hunk = {
        id: `h${counter}`,
        file: file.status === "deleted" ? file.oldPath : file.path,
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
        lines: [],
        addedLines: [],
        removedCount: 0,
      };
      file.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!hunk) continue;
    if (!isHunkBody(raw, hunk, oldLine, newLine)) {
      if (!raw.startsWith("\\")) hunk = undefined;
      continue;
    }

    const marker = raw[0];
    const body = raw.slice(1);
    if (marker === "+") {
      hunk.lines.push({ kind: "add", text: body, newLine });
      hunk.addedLines.push(newLine);
      newLine++;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "del", text: body, oldLine });
      hunk.removedCount++;
      oldLine++;
    } else {
      hunk.lines.push({ kind: "context", text: body, oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }
  for (const f of files) {
    if (f.status === "deleted") f.path = f.oldPath;
  }
  return files;
}

function isHunkBody(raw: string, hunk: Hunk, oldLine: number, newLine: number): boolean {
  const oldDone = oldLine >= hunk.oldStart + hunk.oldLines;
  const newDone = newLine >= hunk.newStart + hunk.newLines;
  if (oldDone && newDone) return false;
  const c = raw[0];
  return c === "+" || c === "-" || c === " " || (raw === "" && !oldDone && !newDone);
}

/**
 * The line range a hunk occupies in the file the reviewer looks at:
 * the new file, or the old file when the whole file was deleted.
 */
export function hunkRange(hunk: Hunk, deletedFile = false): { start: number; end: number } {
  if (deletedFile) {
    return { start: hunk.oldStart, end: Math.max(hunk.oldStart, hunk.oldStart + hunk.oldLines - 1) };
  }
  if (hunk.addedLines.length > 0) {
    return { start: hunk.addedLines[0], end: hunk.addedLines[hunk.addedLines.length - 1] };
  }
  // Pure deletion: point at the line that now sits where the removed lines were.
  let anchor = hunk.newStart;
  for (const l of hunk.lines) {
    if (l.kind === "del") break;
    if (l.newLine !== undefined) anchor = l.newLine + 1;
  }
  anchor = Math.max(1, Math.min(anchor, Math.max(1, hunk.newStart + hunk.newLines - 1)));
  return { start: anchor, end: anchor };
}

/** True when a new-file line is part of the diff, so GitHub accepts a review comment on it. */
export function isLineInDiff(files: DiffFile[], path: string, line: number): boolean {
  const f = files.find((x) => x.path === path && x.status !== "deleted");
  if (!f) return false;
  return f.hunks.some((h) => h.newLines > 0 && line >= h.newStart && line < h.newStart + h.newLines);
}

export function allHunks(files: DiffFile[]): Hunk[] {
  return files.flatMap((f) => f.hunks);
}

/** Renders a file's hunks with explicit line numbers so an agent can cite exact ranges. */
export function renderFileForPrompt(file: DiffFile): string {
  const out: string[] = [];
  const label =
    file.status === "renamed" ? `${file.path} (renamed from ${file.oldPath})` : `${file.path} (${file.status})`;
  out.push(`=== FILE ${label} ===`);
  if (file.binary) out.push("(binary file, no text diff)");
  const deleted = file.status === "deleted";
  for (const h of file.hunks) {
    const r = hunkRange(h, deleted);
    out.push(
      `--- hunk ${h.id}: ${deleted ? "old" : "new"} lines ${r.start}-${r.end}` +
        ` (+${h.addedLines.length} -${h.removedCount}) ---`,
    );
    for (const l of h.lines) {
      const n = deleted ? l.oldLine : l.newLine;
      const num = n === undefined ? "" : String(n);
      const sign = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ";
      out.push(`${sign}${num.padStart(6)}  ${l.text}`);
    }
  }
  return out.join("\n");
}

export function renderDiffForPrompt(files: DiffFile[]): string {
  return files.map(renderFileForPrompt).join("\n\n");
}

export function diffStats(files: DiffFile[]): { files: number; hunks: number; added: number; removed: number } {
  let added = 0;
  let removed = 0;
  let hunks = 0;
  for (const f of files) {
    for (const h of f.hunks) {
      hunks++;
      added += h.addedLines.length;
      removed += h.removedCount;
    }
  }
  return { files: files.length, hunks, added, removed };
}
