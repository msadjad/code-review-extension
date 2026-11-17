import mermaid from "mermaid";
import type { ViewModel } from "../src/viewModel";
import type { Finding } from "../src/reviewers";
import type { Diagram, Step } from "../src/tour";
import { esc, md } from "./markdown";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const vscode = acquireVsCodeApi();
const app = document.getElementById("app") as HTMLElement;

let model: ViewModel | undefined;
let lastViewKey = "";
/** The reviewer whose findings are shown in place of the current view, when a chip was pressed. */
let agentView: string | undefined;
const openDetails = new Set<string>();
const closedDetails = new Set<string>();
const wideDiagrams = new Set<string>();

type Drawn = { svg: string } | { error: string };
const drawn = new Map<string, Drawn>();
const drawing = new Set<string>();
let renderSeq = 0;

const dark = () => document.body.classList.contains("vscode-dark") || document.body.classList.contains("vscode-high-contrast");

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: dark() ? "dark" : "default",
  fontFamily: "var(--vscode-font-family)",
});

/** Commands that move to another part of the review, and so leave the reviewer's findings list. */
const LEAVES_AGENT_VIEW = new Set(["next", "prev", "goTo", "overview", "finish", "understood"]);

function send(command: string, arg?: unknown): void {
  if (LEAVES_AGENT_VIEW.has(command)) agentView = undefined;
  vscode.postMessage({ type: "command", command, arg });
}

// ---------- small render helpers ----------

function btn(label: string, cmd: string, opts: { arg?: unknown; key?: string; cls?: string; title?: string; pressed?: boolean } = {}): string {
  const arg = opts.arg === undefined ? "" : ` data-arg="${esc(JSON.stringify(opts.arg))}"`;
  const key = opts.key ? ` <kbd>${esc(opts.key)}</kbd>` : "";
  const pressed = opts.pressed === undefined ? "" : ` aria-pressed="${opts.pressed}"`;
  const title = opts.title ? ` title="${esc(opts.title)}"` : "";
  return `<button type="button" class="${opts.cls ?? ""}" data-cmd="${cmd}"${arg}${pressed}${title}>${esc(label)}${key}</button>`;
}

function details(key: string, summary: string, body: string, openByDefault: boolean): string {
  const open = openDetails.has(key) || (openByDefault && !closedDetails.has(key));
  return `<details data-key="${esc(key)}"${open ? " open" : ""}><summary>${summary}</summary>${body}</details>`;
}

function loc(file: string, line: number, endLine?: number): string {
  const range = endLine && endLine !== line ? `${line}-${endLine}` : `${line}`;
  return `<button type="button" class="loc" data-cmd="openLocation" data-arg="${esc(
    JSON.stringify({ file, line, endLine: endLine ?? line }),
  )}" title="Show in editor">${esc(file)}:${range}</button>`;
}

function diagramBlock(d: Diagram, m: ViewModel): string {
  const state = drawn.get(d.mermaid);
  let body: string;
  if (state && "svg" in state) {
    body = `<div class="diagram-svg">${state.svg}</div>`;
  } else if (state && "error" in state) {
    body = m.repairing.includes(d.id)
      ? `<p class="muted">This diagram did not parse; asking the agent to correct it…</p>`
      : `<p class="muted">This diagram could not be drawn. Its source:</p><pre>${esc(d.mermaid)}</pre>`;
  } else {
    body = `<p class="muted">Drawing…</p>`;
  }
  const wide = wideDiagrams.has(d.id);
  return `<figure class="diagram${wide ? " wide" : ""}" data-diagram="${esc(d.id)}">
    <figcaption><span class="tag">${esc(kindLabel(d.kind))}</span> <strong>${esc(d.title)}</strong>
      ${btn(wide ? "Fit width" : "Full size", "ui:wide", { arg: d.id, cls: "link" })}</figcaption>
    ${body}
    ${d.caption ? `<div class="caption">${md(d.caption)}</div>` : ""}
  </figure>`;
}

function kindLabel(kind: Diagram["kind"]): string {
  return { flow: "Flow", sequence: "Sequence", er: "Database", state: "States" }[kind] ?? "Diagram";
}

const agentLabel = (a: string) => (a === "claude" ? "Claude" : a === "codex" ? "Codex" : a);

function findingCard(f: Finding, showLocation: boolean): string {
  const agree = f.agreedBy.length
    ? `<span class="tag agree" title="Another agent independently flagged these same lines">${f.agreedBy.map(agentLabel).join(", ")} flagged these lines too</span>`
    : "";
  return `<article class="finding sev-${f.severity}">
    <header><span class="tag sev">${esc(f.severity)}</span><span class="tag">${esc(agentLabel(f.agent))}</span>${agree}
      <strong>${esc(f.title)}</strong></header>
    ${showLocation ? `<p>${loc(f.file, f.line, f.endLine)}</p>` : ""}
    <div class="body">${md(f.body)}</div>
    <div class="row">${showLocation ? "" : btn("Show in code", "openLocation", { arg: { file: f.file, line: f.line, endLine: f.endLine }, cls: "link" })}
      ${btn("Add to my notes", "adoptFinding", { arg: f.id, cls: "link" })}
      ${btn("Dismiss", "dismissFinding", { arg: f.id, cls: "link" })}</div>
  </article>`;
}

function reviewerChips(m: ViewModel): string {
  if (m.reviewers.length === 0) return "";
  return m.reviewers
    .map((r) => {
      const text =
        r.status === "running"
          ? "reviewing…"
          : r.status === "done"
            ? `${r.count ?? 0} finding${r.count === 1 ? "" : "s"}`
            : r.status === "unavailable"
              ? "not installed"
              : "failed";
      return `<button type="button" class="chip ${r.status}" data-cmd="ui:agent" data-arg="${esc(JSON.stringify(r.agent))}" aria-pressed="${agentView === r.agent}" title="Show what ${esc(agentLabel(r.agent))} found">${esc(agentLabel(r.agent))}: ${text}</button>`;
    })
    .join("");
}

/** Everything one reviewer agent reported: its verdict and its findings, each with where it is. */
function agentFindingsView(m: ViewModel, agent: string): string {
  const r = m.reviewers.find((x) => x.agent === agent);
  const findings = m.findings.filter((f) => f.agent === agent);
  const total = r?.count ?? findings.length;
  const hidden = total - findings.length;
  let status = "";
  if (!r) status = `<p class="muted">This reviewer has not run.</p>`;
  else if (r.status === "running") status = `<p class="muted"><span class="spinner" aria-hidden="true"></span> Still reviewing. Findings appear here when it finishes.</p>`;
  else if (r.status === "unavailable") status = `<p class="warn">${esc(r.error ?? "The CLI for this agent was not found.")}</p>`;
  else if (r.status === "failed") status = `<pre class="error">${esc(r.error ?? "The review did not finish.")}</pre>`;
  else if (r.verdict) status = `<h3>Verdict</h3><div class="prose">${md(r.verdict)}</div>`;
  const list = findings.length
    ? `<h3>Findings (${findings.length})</h3>${findings.map((f) => findingCard(f, true)).join("")}`
    : r?.status === "done"
      ? `<p class="muted">${total ? "No open findings left." : "This reviewer reported no findings."}</p>`
      : "";
  return `<section>
    <div class="row">${btn("Back", "ui:agent", { arg: agent, key: "Esc" })}${r && r.status !== "running" ? btn("Run reviewers again", "runReviewers", { cls: "link" }) : ""}</div>
    <h2>${esc(agentLabel(agent))}'s review</h2>
    ${status}${list}
    ${hidden > 0 ? `<p class="muted small">${hidden} finding${hidden > 1 ? "s" : ""} already added to your notes or dismissed.</p>` : ""}
  </section>`;
}

function stepFindings(m: ViewModel, s: Step): Finding[] {
  return m.findings.filter((f) => f.file === s.file && f.line <= s.endLine + 2 && f.endLine >= s.startLine - 2);
}

// ---------- views ----------

function header(m: ViewModel): string {
  const tour = m.tour;
  let progress = "";
  let nav = "";
  if (tour && m.phase === "ready") {
    const total = tour.steps.length;
    const understood = tour.steps.filter((s) => m.state.statuses[s.id] === "understood").length;
    const concerns = tour.steps.filter((s) => m.state.statuses[s.id] === "concern").length;
    const cur = m.state.current;
    const where = cur < 0 ? "Overview" : cur >= total ? "Finish" : `Step ${cur + 1} of ${total}`;
    const read = new Set(m.state.visited);
    const byFile = new Map<string, boolean>();
    for (const s of tour.steps) byFile.set(s.file, (byFile.get(s.file) ?? true) && read.has(s.id));
    const filesLeft = [...byFile.values()].filter((done) => !done).length;
    progress = `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${understood}" aria-label="Steps understood">
        <div style="width:${total ? (understood / total) * 100 : 0}%"></div></div>
      <p class="muted small">${where} · ${filesLeft} of ${byFile.size} files left · ${understood}/${total} understood${concerns ? ` · ${concerns} concern${concerns > 1 ? "s" : ""}` : ""}</p>`;
    nav = `<nav class="row" aria-label="Tour navigation">
      ${btn("Overview", "overview", { key: "o", pressed: cur < 0 })}
      ${btn("Previous", "prev", { key: "p" })}
      ${btn("Next", "next", { key: "n", cls: "primary" })}
      ${btn("Finish", "finish", { key: "f", pressed: cur >= total })}
    </nav>`;
  }
  return `<header class="top">
    <div class="titleline"><h1>${esc(m.title)}</h1>${m.prUrl ? btn("Open PR", "openPr", { cls: "link" }) : ""}</div>
    ${m.stats.files ? `<p class="muted small">${esc(m.subtitle)} · ${m.stats.files} files, +${m.stats.added} −${m.stats.removed}</p>` : ""}
    <div class="chips">${reviewerChips(m)}</div>
    ${progress}${nav}
  </header>`;
}

function generatingView(m: ViewModel): string {
  const lines = m.progress.map((l) => `<li>${esc(l)}</li>`).join("");
  return `<section>
    <h2><span class="spinner" aria-hidden="true"></span> Preparing your guided tour</h2>
    <p>The agent is reading the change and the code around it to work out what each piece means for the business. This usually takes a few minutes.</p>
    <ol class="log" aria-live="polite">${lines}</ol>
    <div class="row">${btn("Cancel", "cancel")}</div>
  </section>`;
}

function startingView(m: ViewModel): string {
  const lines = m.progress.map((l) => `<li>${esc(l)}</li>`).join("");
  return `<section>
    <h2><span class="spinner" aria-hidden="true"></span> Opening the review</h2>
    <p>Getting the change ready. The guided tour starts as soon as the diff is known.</p>
    <ol class="log" aria-live="polite">${lines}</ol>
    <div class="row">${btn("Cancel", "cancel")}</div>
  </section>`;
}

function errorView(m: ViewModel): string {
  if (m.startFailed) {
    const lines = m.progress.map((l) => `<li>${esc(l)}</li>`).join("");
    return `<section>
    <h2>The review could not be opened</h2>
    <pre class="error">${esc(m.error ?? "Unknown error")}</pre>
    <ol class="log">${lines}</ol>
    <div class="row">${btn("Start again", "restart", { cls: "primary" })}${btn("Close", "cancel")}</div>
  </section>`;
  }
  return `<section>
    <h2>The tour could not be prepared</h2>
    <pre class="error">${esc(m.error ?? "Unknown error")}</pre>
    <div class="row">${btn("Try again", "regenerate", { cls: "primary" })}${btn("End review", "cancel")}</div>
  </section>`;
}

function stepList(m: ViewModel): string {
  const tour = m.tour!;
  const out: string[] = [];
  let section = "";
  tour.steps.forEach((s, i) => {
    if (s.section !== section) {
      if (section) out.push("</ol>");
      section = s.section;
      out.push(`<h3>${esc(section)}</h3><ol class="steps" start="${i + 1}">`);
    }
    const status = m.state.statuses[s.id] ?? (m.state.visited.includes(s.id) ? "visited" : "new");
    const n = stepFindings(m, s).length;
    out.push(`<li class="st-${status}"><button type="button" class="link" data-cmd="goTo" data-arg="${i}">${esc(s.title)}</button>
      <span class="muted small">${esc(s.file.split("/").pop() ?? "")}:${s.startLine}${status === "understood" ? " · understood" : status === "concern" ? " · concern" : ""}${n ? ` · ${n} finding${n > 1 ? "s" : ""}` : ""}</span></li>`);
  });
  if (section) out.push("</ol>");
  return out.join("");
}

function verdicts(m: ViewModel): string {
  const done = m.reviewers.filter((r) => r.status === "done" || r.status === "failed" || r.status === "unavailable");
  if (m.reviewers.length === 0) return "";
  const items = m.reviewers
    .map((r) => {
      const text =
        r.status === "running"
          ? "Still reviewing."
          : r.status === "done"
            ? r.verdict || "No overall verdict given."
            : r.error || "Did not finish.";
      return `<div class="verdict"><strong>${esc(agentLabel(r.agent))}</strong><div>${md(text)}</div></div>`;
    })
    .join("");
  const agreed = m.findings.filter((f) => f.agreedBy.length > 0).length;
  const note =
    done.length === m.reviewers.length && m.reviewers.filter((r) => r.status === "done").length > 1
      ? `<p class="muted small">${agreed ? `${agreed} finding${agreed > 1 ? "s are" : " is"} on lines that more than one agent flagged independently.` : "The agents did not flag any of the same places."}</p>`
      : "";
  return `<h2>Independent agent reviews</h2><p class="muted small">Each agent reviewed the change separately. Their findings appear on the steps they concern.</p>${items}${note}
    <div class="row">${btn("Run reviewers again", "runReviewers", { cls: "link" })}</div>`;
}

/** Each risk with the review comment drafted for it, which one click turns into the reviewer's own note. */
function riskList(m: ViewModel): string {
  const risks = m.tour!.riskAreas;
  const anyDraft = risks.some((r) => r.comment);
  const items = risks
    .map((r, i) => {
      const note = m.state.notes.find((n) => n.riskIndex === i);
      let draft = "";
      if (r.comment) {
        const action = note
          ? `<span class="good">Added to your review</span>${btn("Undo", "deleteNote", { arg: note.id, cls: "link" })}`
          : btn("Agree, add this comment", "adoptRisk", { arg: i, cls: "primary" });
        draft = `<div class="draft${note ? " added" : ""}">
          <p class="muted small">Drafted comment on ${loc(r.file, r.line)}</p>
          <div class="body">${md(r.comment)}</div>
          <div class="row">${action}</div>
        </div>`;
      }
      return `<li><div>${md(r.text, true)}</div>${draft}</li>`;
    })
    .join("");
  const offer = anyDraft
    ? `<p class="muted small">Comments you agree to are posted with your review when you submit it from the Finish screen.</p>`
    : m.draftingRisks
      ? `<p class="muted"><span class="spinner" aria-hidden="true"></span> Drafting review comments…</p>`
      : `<div class="row">${btn("Draft review comments for these", "draftRisks")}</div>`;
  return `<ul class="risks">${items}</ul>${offer}`;
}

function overviewView(m: ViewModel): string {
  const tour = m.tour!;
  const started = m.state.visited.length > 0;
  const risks = tour.riskAreas.length ? `<h2>Where a mistake would hurt</h2>${riskList(m)}` : "";
  const diagrams = tour.diagrams.length
    ? `<h2>How it fits together</h2>${tour.diagrams.map((d) => diagramBlock(d, m)).join("")}`
    : "";
  return `<section>
    <h2>What this change does</h2>
    <div class="prose">${md(tour.summary)}</div>
    <h2>Explain like I'm 5</h2>
    ${
      m.writingEli5
        ? `<p class="muted"><span class="spinner" aria-hidden="true"></span> Writing the simple version…</p>`
        : tour.eli5
          ? `<div class="prose eli5">${md(tour.eli5)}</div><div class="row">${btn("Rewrite this", "eli5", { arg: "rewrite", cls: "link" })}</div>`
          : `<p class="muted">This tour was made before this section existed.</p><div class="row">${btn("Write the simple version", "eli5")}</div>`
    }
    <div class="row">${btn(started ? "Continue the tour" : "Start the tour", "next", { cls: "primary", key: "n" })}</div>
    ${askedSection(m, "overview", "Your questions on the overview")}
    ${risks}${diagrams}${verdicts(m)}
    <h2>The tour</h2>${stepList(m)}
  </section>`;
}

function stepView(m: ViewModel, s: Step, index: number): string {
  const tour = m.tour!;
  const status = m.state.statuses[s.id];
  const findings = stepFindings(m, s);
  const notes = m.state.notes.filter((n) => n.stepId === s.id);
  const diagrams = tour.diagrams.filter((d) => s.diagramIds.includes(d.id));

  const watch = s.watchFor.length
    ? `<h3>Check while reading</h3><ul class="watch">${s.watchFor.map((w) => `<li>${md(w, true)}</li>`).join("")}</ul>`
    : "";
  const findingsHtml = findings.length
    ? `<h3>Agent findings on this chunk</h3>${findings.map((f) => findingCard(f, false)).join("")}`
    : "";
  const diagramsHtml = diagrams
    .map((d, i) => details(`${s.id}:${d.id}`, `Diagram: ${esc(d.title)}`, diagramBlock(d, m), i === 0 && diagrams.length === 1))
    .join("");
  const notesHtml = notes.length
    ? `<h3>Your notes</h3>${notes.map(noteItem).join("")}`
    : "";
  const askedHtml = askedSection(m, s.id, "Your questions on this step");

  return `<section class="step${s.unexplained ? " unexplained" : ""}">
    <p class="muted small">${esc(s.section)} · step ${index + 1} of ${tour.steps.length}${status ? ` · <span class="tag st-${status}">${status}</span>` : ""}</p>
    <h2>${esc(s.title)}</h2>
    <p>${btn(`${s.file}:${s.startLine}-${s.endLine}`, "code", { cls: "loc", key: "b", title: "Jump to this chunk in the editor" })}</p>
    <div class="prose">${md(s.explanation)}</div>
    ${s.why ? `<h3>Why it changed</h3><div class="prose">${md(s.why)}</div>` : ""}
    ${watch}${findingsHtml}${diagramsHtml}${notesHtml}${askedHtml}
    <div class="row actions">
      ${btn("Understood, next", "understood", { key: "u", cls: "primary", pressed: status === "understood" })}
      ${btn("Concern", "concern", { key: "x", pressed: status === "concern" })}
      ${btn("Add note", "note", { key: "c" })}
      ${btn("Explain selection", "explain", { key: "e" })}
      ${btn("Diff", "diff", { key: "d", pressed: m.diffMode })}
      ${btn("Isolate", "isolate", { key: "i", pressed: m.isolate })}
    </div>
  </section>`;
}

function noteItem(n: ViewModel["state"]["notes"][number]): string {
  return `<article class="note"><p>${loc(n.file, n.line)}${n.fromAgent ? ` <span class="tag">from ${esc(agentLabel(n.fromAgent))}</span>` : ""}</p>
    <div class="body">${md(n.body)}</div>
    <div class="row">${btn("Delete note", "deleteNote", { arg: n.id, cls: "link" })}</div></article>`;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function askedSection(m: ViewModel, where: string, title: string): string {
  const asked = m.state.asked.filter((a) => a.stepId === where);
  return asked.length ? `<h3>${esc(title)}</h3>${asked.map(askedItem).join("")}` : "";
}

function askedItem(a: ViewModel["state"]["asked"][number]): string {
  const about = a.quote
    ? `<blockquote>${esc(clip(a.quote, 280))}</blockquote>${a.question ? `<p><em>${esc(a.question)}</em></p>` : ""}`
    : `<p>${loc(a.file, a.startLine, a.endLine)}${a.question ? ` <em>${esc(a.question)}</em>` : ""}</p>`;
  return `<article class="asked">${about}
    ${a.pending ? `<p class="muted"><span class="spinner" aria-hidden="true"></span> Reading the code…</p>` : `<div class="body">${md(a.answer)}</div>${(a.more ?? [])
      .map(
        (f) =>
          `<p><em>${esc(f.kind === "comment" ? `Add a review comment${f.question ? `: ${f.question}` : ""}` : f.question)}</em></p>
          <div class="body">${f.kind === "comment" ? `<p class="muted">Review comment, added to your notes:</p>` : ""}${md(f.answer)}</div>`,
      )
      .join("")}
    <div class="row">${btn("Remove", "deleteAsked", { arg: a.id, cls: "link" })}</div>`}</article>`;
}

function finishView(m: ViewModel): string {
  const tour = m.tour!;
  const total = tour.steps.length;
  const understood = tour.steps.filter((s) => m.state.statuses[s.id] === "understood");
  const concerns = tour.steps.filter((s) => m.state.statuses[s.id] === "concern");
  const open = tour.steps.map((s, i) => ({ s, i })).filter(({ s }) => !m.state.statuses[s.id]);
  const seen = new Set(tour.steps.filter((s) => m.state.visited.includes(s.id)).flatMap((s) => s.hunkIds));
  const unexplained = tour.steps.filter((s) => s.unexplained).length;

  const openHtml = open.length
    ? `<h2>Not yet marked</h2><ul>${open
        .map(({ s, i }) => `<li><button type="button" class="link" data-cmd="goTo" data-arg="${i}">${i + 1}. ${esc(s.title)}</button>${m.state.visited.includes(s.id) ? "" : ` <span class="muted small">not opened</span>`}</li>`)
        .join("")}</ul>`
    : `<p class="good">Every step is marked.</p>`;
  const concernHtml = concerns.length
    ? `<h2>Your concerns</h2><ul>${concerns
        .map((s) => `<li><button type="button" class="link" data-cmd="goTo" data-arg="${tour.steps.indexOf(s)}">${esc(s.title)}</button></li>`)
        .join("")}</ul>`
    : "";
  const findingsHtml = m.findings.length
    ? `<h2>Open agent findings</h2><p class="muted small">Add the ones you agree with to your notes, dismiss the rest.</p>${m.findings.map((f) => findingCard(f, true)).join("")}`
    : m.reviewers.some((r) => r.status === "done")
      ? `<h2>Open agent findings</h2><p class="muted">None left.</p>`
      : "";
  const quiz = tour.checkQuestions.length
    ? `<h2>Check your understanding</h2><p class="muted small">Answer in your head, then open the answer.</p>${tour.checkQuestions
        .map((q, i) => details(`q${i}`, esc(q.question), `<div class="prose">${md(q.answer)}</div>`, false))
        .join("")}`
    : "";
  const notesHtml = `<h2>Your notes (${m.state.notes.length})</h2>${m.state.notes.length ? m.state.notes.map(noteItem).join("") : `<p class="muted">No notes yet.</p>`}`;
  const submit = m.canSubmit
    ? `<div class="row">${btn("Submit review to GitHub", "submit", { cls: "primary" })}</div><p class="muted small">You choose Comment, Approve or Request changes and confirm before anything is posted.</p>`
    : `<p class="muted small">This review is not tied to a GitHub PR at this commit, so notes stay local.</p>`;

  return `<section>
    <h2>Where you stand</h2>
    <dl class="stats">
      <div><dt>Understood</dt><dd>${understood.length} / ${total}</dd></div>
      <div><dt>Concerns</dt><dd>${concerns.length}</dd></div>
      <div><dt>Changes opened</dt><dd>${seen.size} / ${m.totalHunks}</dd></div>
      <div><dt>Open findings</dt><dd>${m.findings.length}</dd></div>
    </dl>
    ${unexplained ? `<p class="warn">${unexplained} change${unexplained > 1 ? "s were" : " was"} not explained by the agent and need${unexplained > 1 ? "" : "s"} a direct read.</p>` : ""}
    ${openHtml}${concernHtml}${findingsHtml}${quiz}${askedSection(m, "finish", "Your questions")}${notesHtml}${submit}
  </section>`;
}

function hints(): string {
  return `<footer class="hints muted small" aria-label="Keyboard shortcuts">
    <kbd>j</kbd>/<kbd>k</kbd> scroll · <kbd>n</kbd>/<kbd>p</kbd> step · <kbd>u</kbd> understood · <kbd>x</kbd> concern · <kbd>c</kbd> note · <kbd>e</kbd> explain · <kbd>d</kbd> diff · <kbd>i</kbd> isolate · <kbd>a</kbd> ask about selected text · <kbd>b</kbd> to code · <kbd>o</kbd> overview · <kbd>f</kbd> finish
  </footer>`;
}

// ---------- rendering ----------

function render(): void {
  const m = model;
  if (!m) return;
  let body: string;
  let key: string;
  if (m.phase === "starting") {
    body = startingView(m);
    key = "starting";
  } else if (agentView && (m.phase === "generating" || (m.phase === "ready" && m.tour))) {
    body = agentFindingsView(m, agentView);
    key = `agent:${agentView}`;
  } else if (m.phase === "generating") {
    body = generatingView(m);
    key = "generating";
  } else if (m.phase === "error" || !m.tour) {
    body = errorView(m);
    key = "error";
  } else {
    const cur = m.state.current;
    const step = m.tour.steps[cur];
    if (step) body = stepView(m, step, cur);
    else if (cur < 0) body = overviewView(m);
    else body = finishView(m);
    key = `ready:${cur}`;
  }
  const scroll = key === lastViewKey ? window.scrollY : 0;
  const version = `<p class="muted small version">Review Guide ${esc(m.version ?? "")}</p>`;
  app.innerHTML = header(m) + body + (m.phase === "ready" ? hints() : "") + version;
  window.scrollTo(0, key === "generating" ? document.body.scrollHeight : scroll);
  if (key !== lastViewKey) {
    lastViewKey = key;
    if (document.hasFocus()) app.focus({ preventScroll: true });
  }
  syncAsk();
  void drawDiagrams(m);
}

async function drawDiagrams(m: ViewModel): Promise<void> {
  const visible = new Set(
    Array.from(app.querySelectorAll<HTMLElement>("[data-diagram]")).map((el) => el.dataset.diagram!),
  );
  // Diagrams inside closed <details> are drawn too, so opening one is instant.
  let changed = false;
  for (const d of m.tour?.diagrams ?? []) {
    if (!visible.has(d.id) || drawn.has(d.mermaid) || drawing.has(d.mermaid)) continue;
    drawing.add(d.mermaid);
    try {
      await mermaid.parse(d.mermaid);
      const { svg } = await mermaid.render(`mmd${renderSeq++}`, d.mermaid);
      drawn.set(d.mermaid, { svg });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      drawn.set(d.mermaid, { error });
      document.querySelectorAll("body > [id^='dmmd'], body > svg[id^='mmd']").forEach((el) => el.remove());
      vscode.postMessage({ type: "diagramError", id: d.id, error: error.slice(0, 1500) });
    }
    drawing.delete(d.mermaid);
    changed = true;
  }
  if (changed) render();
}

// ---------- events ----------

app.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-cmd]");
  if (!el) return;
  const cmd = el.dataset.cmd!;
  const arg = el.dataset.arg === undefined ? undefined : JSON.parse(el.dataset.arg);
  if (cmd === "ui:agent") {
    agentView = agentView === arg ? undefined : arg;
    render();
    return;
  }
  if (cmd === "ui:wide") {
    if (wideDiagrams.has(arg)) wideDiagrams.delete(arg);
    else wideDiagrams.add(arg);
    render();
    return;
  }
  send(cmd, arg);
});

app.addEventListener(
  "toggle",
  (e) => {
    const el = e.target as HTMLDetailsElement;
    const key = el.dataset?.key;
    if (!key) return;
    if (el.open) {
      openDetails.add(key);
      closedDetails.delete(key);
    } else {
      openDetails.delete(key);
      closedDetails.add(key);
    }
  },
  true,
);

const KEYS: Record<string, string> = {
  n: "next",
  l: "next",
  p: "prev",
  h: "prev",
  u: "understood",
  x: "concern",
  c: "note",
  e: "explain",
  d: "diff",
  i: "isolate",
  b: "code",
  o: "overview",
  f: "finish",
};

let pendingG = 0;

document.addEventListener("keydown", (e) => {
  const target = e.target as Partial<HTMLElement> | null;
  if (target?.closest?.("input, textarea, select")) return;
  if (e.metaKey || e.altKey) return;
  const page = window.innerHeight;
  if (e.ctrlKey) {
    if (e.key === "d") window.scrollBy(0, page / 2);
    else if (e.key === "u") window.scrollBy(0, -page / 2);
    else return;
    e.preventDefault();
    return;
  }
  if (e.key === "Escape" && ask.mode !== "hidden") {
    closeAsk();
    e.preventDefault();
    return;
  }
  if (e.key === "Escape" && agentView) {
    agentView = undefined;
    render();
    e.preventDefault();
    return;
  }
  if (!model || model.phase !== "ready") return;
  if (e.key === "a" && (ask.mode === "offer" || selectedGuideText())) {
    openAskForm();
    e.preventDefault();
    return;
  }
  switch (e.key) {
    case "j":
      window.scrollBy(0, 60);
      break;
    case "k":
      window.scrollBy(0, -60);
      break;
    case "?":
      send("shortcuts");
      break;
    case "G":
      window.scrollTo(0, document.body.scrollHeight);
      break;
    case "g":
      if (Date.now() - pendingG < 600) window.scrollTo(0, 0);
      pendingG = Date.now();
      break;
    default: {
      const cmd = KEYS[e.key];
      if (!cmd) return;
      send(cmd);
    }
  }
  e.preventDefault();
});

// ---------- ask about selected guide text ----------

/**
 * Selecting text in the guide offers "Ask about this". The popup lives outside #app
 * so it survives the re-renders that every state update causes.
 */
const ask: {
  mode: "hidden" | "offer" | "form" | "answer";
  quote: string;
  question: string;
  id: string;
  top: number;
  left: number;
} = { mode: "hidden", quote: "", question: "", id: "", top: 0, left: 0 };

const askEl = document.createElement("aside");
askEl.className = "ask-pop";
askEl.setAttribute("role", "dialog");
askEl.setAttribute("aria-label", "Ask about the selected text");
askEl.hidden = true;
document.body.appendChild(askEl);

function selectedGuideText(): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode || !app.contains(sel.anchorNode)) return "";
  const text = sel.toString().trim();
  return text.length >= 3 ? text : "";
}

function placeAtSelection(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  ask.top = rect.bottom + window.scrollY + 6;
  ask.left = rect.left + window.scrollX;
}

function paintAsk(): void {
  askEl.hidden = ask.mode === "hidden";
  if (ask.mode === "hidden") return;
  askEl.dataset.mode = ask.mode;
  const width = ask.mode === "offer" ? 170 : Math.min(460, window.innerWidth - 24);
  askEl.style.width = ask.mode === "offer" ? "auto" : `${width}px`;
  askEl.style.top = `${ask.top}px`;
  askEl.style.left = `${Math.max(12, Math.min(ask.left, window.scrollX + window.innerWidth - width - 12))}px`;

  if (ask.mode === "offer") {
    askEl.innerHTML = `<button type="button" class="primary" data-ask="open">Ask about this <kbd>a</kbd></button>`;
    return;
  }
  const quote = `<blockquote>${esc(clip(ask.quote, 220))}</blockquote>`;
  if (ask.mode === "form") {
    askEl.innerHTML = `${quote}
      <textarea rows="2" aria-label="Your question" placeholder="What do you want to know? Leave empty to have it explained in more depth."></textarea>
      <div class="row"><button type="button" class="primary" data-ask="send">Ask <kbd>Enter</kbd></button>
      <button type="button" data-ask="close">Cancel <kbd>Esc</kbd></button></div>`;
    askEl.querySelector("textarea")!.focus();
    return;
  }
  const entry = model?.state.asked.find((a) => a.id === ask.id);
  const body =
    !entry || entry.pending
      ? `<p class="muted"><span class="spinner" aria-hidden="true"></span> Reading the code to answer…</p>`
      : `<div class="body">${md(entry.answer)}</div>`;
  askEl.innerHTML = `${quote}${ask.question ? `<p><em>${esc(ask.question)}</em></p>` : ""}
    <div class="answer" aria-live="polite">${body}</div>
    <div class="row"><button type="button" data-ask="close">Close <kbd>Esc</kbd></button>
    <span class="muted small">Also saved under your questions.</span></div>`;
}

function openAskForm(): void {
  const text = selectedGuideText();
  if (text) {
    ask.quote = text;
    placeAtSelection();
  }
  if (!ask.quote) return;
  ask.mode = "form";
  ask.question = "";
  paintAsk();
}

function sendAsk(): void {
  const input = askEl.querySelector("textarea");
  ask.question = input?.value.trim() ?? "";
  ask.id = `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  ask.mode = "answer";
  paintAsk();
  send("askGuide", { id: ask.id, quote: ask.quote, question: ask.question });
}

function closeAsk(): void {
  ask.mode = "hidden";
  ask.quote = "";
  paintAsk();
  app.focus({ preventScroll: true });
}

/** Called after every render: fills in the answer once the host has it. */
function syncAsk(): void {
  if (ask.mode === "answer") paintAsk();
}

let selectionTimer: number | undefined;
document.addEventListener("selectionchange", () => {
  window.clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(() => {
    if (ask.mode === "form" || ask.mode === "answer") return;
    const text = model?.phase === "ready" ? selectedGuideText() : "";
    if (text) {
      ask.quote = text;
      ask.mode = "offer";
      placeAtSelection();
    } else {
      ask.mode = "hidden";
    }
    paintAsk();
  }, 180);
});

// Keep the text selected while the offer button is pressed.
askEl.addEventListener("mousedown", (e) => {
  if ((e.target as HTMLElement).closest("[data-ask='open']")) e.preventDefault();
});

askEl.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>("[data-ask]")?.dataset.ask;
  if (action === "open") openAskForm();
  else if (action === "send") sendAsk();
  else if (action === "close") closeAsk();
});

askEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeAsk();
    e.preventDefault();
    e.stopPropagation();
  } else if (e.key === "Enter" && !e.shiftKey && (e.target as HTMLElement).tagName === "TEXTAREA") {
    sendAsk();
    e.preventDefault();
    e.stopPropagation();
  }
});

window.addEventListener("message", (e) => {
  if (e.data?.type === "state") {
    model = e.data.model as ViewModel;
    render();
  }
});

// When the panel regains focus, put the keyboard on the guide so its keys work at once.
window.addEventListener("focus", () => {
  const active = document.activeElement;
  if (!active || active === document.body) app.focus({ preventScroll: true });
});

vscode.postMessage({ type: "ready" });
