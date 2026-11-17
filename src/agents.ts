import { spawn, execFile } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export type AgentName = "claude" | "codex";

export interface AgentConfig {
  claudePath: string;
  codexPath: string;
  claudeModel: string;
  codexModel: string;
  timeoutMs: number;
}

export interface AgentRequest {
  agent: AgentName;
  prompt: string;
  cwd: string;
  /** JSON schema for the final answer. Without it the answer is free text. */
  schema?: object;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
}

export interface AgentResult {
  structured?: unknown;
  text: string;
}

const resolved = new Map<string, string>();

/**
 * VS Code started from the Dock does not always inherit the shell PATH, so fall back
 * to asking a login shell where the binary lives.
 */
export async function resolveBinary(name: string): Promise<string> {
  if (name.includes("/")) return name;
  const hit = resolved.get(name);
  if (hit) return hit;
  // Fast path: the binary is on this process's PATH. Asking a login shell takes seconds.
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      resolved.set(name, candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  const found = await new Promise<string>((res) => {
    const shell = process.env.SHELL || "/bin/zsh";
    execFile(shell, ["-ilc", `command -v ${name}`], { timeout: 10000 }, (err, stdout) => {
      const line = stdout
        ?.split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("/"))
        .pop();
      res(!err && line ? line : name);
    });
  });
  resolved.set(name, found);
  return found;
}

export async function isAvailable(agent: AgentName, config: AgentConfig): Promise<boolean> {
  const bin = await resolveBinary(agent === "claude" ? config.claudePath : config.codexPath);
  return new Promise((res) => {
    execFile(bin, ["--version"], { timeout: 15000 }, (err) => res(!err));
  });
}

export function runAgent(req: AgentRequest, config: AgentConfig): Promise<AgentResult> {
  return req.agent === "claude" ? runClaude(req, config) : runCodex(req, config);
}

interface Spawned {
  stdoutLines: (onLine: (line: string) => void) => void;
  done: Promise<{ code: number | null; stderr: string }>;
}

function start(bin: string, args: string[], req: AgentRequest, timeoutMs: number): Spawned {
  const child = spawn(bin, args, { cwd: req.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let killedBy = "";
  const kill = (why: string) => {
    killedBy = why;
    child.kill("SIGTERM");
  };
  const timer = setTimeout(() => kill("timeout"), timeoutMs);
  const onAbort = () => kill("cancelled");
  req.signal?.addEventListener("abort", onAbort);
  if (req.signal?.aborted) onAbort();

  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.stdin.on("error", () => undefined);
  child.stdin.end(req.prompt);

  let lineHandler: (line: string) => void = () => undefined;
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) lineHandler(line);
    }
  });

  const done = new Promise<{ code: number | null; stderr: string }>((res, rej) => {
    child.on("error", (e) => {
      clearTimeout(timer);
      rej(new Error(`Could not start ${bin}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      if (buf.trim()) lineHandler(buf);
      if (killedBy) rej(new Error(killedBy === "timeout" ? `${bin} timed out` : "Cancelled"));
      else res({ code, stderr });
    });
  });
  return { stdoutLines: (h) => (lineHandler = h), done };
}

function short(s: string, n = 110): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function describeClaudeTool(name: string, input: any): string | undefined {
  switch (name) {
    case "Read":
      return `Reading ${input?.file_path ?? ""}`;
    case "Grep":
      return `Searching for ${short(String(input?.pattern ?? ""), 60)}`;
    case "Glob":
      return `Listing ${input?.pattern ?? ""}`;
    case "Bash":
      return `Running ${short(String(input?.command ?? ""), 80)}`;
    case "StructuredOutput":
      return "Writing the result";
    default:
      return name;
  }
}

async function runClaude(req: AgentRequest, config: AgentConfig): Promise<AgentResult> {
  const bin = await resolveBinary(config.claudePath);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    // Read-only investigation: anything not listed here is denied in print mode.
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(git blame:*)",
    "--disallowedTools",
    "Edit",
    "Write",
    "NotebookEdit",
  ];
  if (config.claudeModel) args.push("--model", config.claudeModel);
  if (req.schema) args.push("--json-schema", JSON.stringify(req.schema));

  const proc = start(bin, args, req, config.timeoutMs);
  let structured: unknown;
  let text = "";
  let failure = "";
  proc.stdoutLines((line) => {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "assistant") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "tool_use") {
          if (block.name === "StructuredOutput") structured = block.input;
          const d = describeClaudeTool(block.name, block.input);
          if (d) req.onProgress?.(d);
        } else if (block.type === "text" && block.text?.trim()) {
          text = block.text;
          req.onProgress?.(short(block.text));
        }
      }
    } else if (ev.type === "result") {
      if (ev.structured_output !== undefined) structured = ev.structured_output;
      if (typeof ev.result === "string" && ev.result) text = ev.result;
      if (ev.is_error) failure = typeof ev.result === "string" ? ev.result : ev.subtype ?? "error";
    }
  });
  const { code, stderr } = await proc.done;
  if (failure) throw new Error(`Claude failed: ${short(failure, 400)}`);
  if (code !== 0 && structured === undefined && !text) {
    throw new Error(`Claude exited with code ${code}: ${short(stderr, 400)}`);
  }
  if (req.schema && structured === undefined) structured = parseLooseJson(text);
  if (req.schema && structured === undefined) throw new Error("Claude returned no structured result");
  return { structured, text };
}

async function runCodex(req: AgentRequest, config: AgentConfig): Promise<AgentResult> {
  const bin = await resolveBinary(config.codexPath);
  const dir = mkdtempSync(join(tmpdir(), "review-guide-"));
  const outFile = join(dir, "last.txt");
  try {
    const args = ["exec", "--sandbox", "read-only", "--ephemeral", "--json", "--color", "never", "-o", outFile];
    if (config.codexModel) args.push("--model", config.codexModel);
    if (req.schema) {
      const schemaFile = join(dir, "schema.json");
      writeFileSync(schemaFile, JSON.stringify(req.schema));
      args.push("--output-schema", schemaFile);
    }
    args.push("-");

    const proc = start(bin, args, req, config.timeoutMs);
    let lastMessage = "";
    let failure = "";
    proc.stdoutLines((line) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      const item = ev.item;
      if (ev.type === "error" || ev.type === "turn.failed") {
        failure = ev.message ?? ev.error?.message ?? "error";
      } else if (item && ev.type === "item.started" && item.type === "command_execution") {
        req.onProgress?.(`Running ${short(String(item.command ?? ""), 80)}`);
      } else if (item && ev.type === "item.completed") {
        if (item.type === "agent_message" && typeof item.text === "string") {
          lastMessage = item.text;
        } else if (item.type === "reasoning" && typeof item.text === "string") {
          req.onProgress?.(short(item.text));
        }
      }
    });
    const { code, stderr } = await proc.done;
    let text = lastMessage;
    try {
      text = readFileSync(outFile, "utf8") || lastMessage;
    } catch {
      // fall back to the streamed message
    }
    if (!text && (failure || code !== 0)) {
      throw new Error(`Codex failed: ${short(failure || stderr, 400)}`);
    }
    let structured: unknown;
    if (req.schema) {
      structured = parseLooseJson(text);
      if (structured === undefined) throw new Error("Codex returned no structured result");
    }
    return { structured, text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Accepts raw JSON, fenced JSON, or JSON surrounded by prose. */
export function parseLooseJson(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  const candidates = [t];
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(t);
  if (fence) candidates.push(fence[1]);
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(t.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next shape
    }
  }
  return undefined;
}
