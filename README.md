# Review Guide

A VS Code extension for reviewing code you did not write and do not know yet.

It turns a pull request into a guided tour: small chunks in an order that makes sense, each explained in terms of business logic, with diagrams of how the system and its database tables fit together. Independent agents (Claude Code and Codex) review the same change in parallel, and their findings appear next to the code they concern.

The code is always shown in a normal editor, so go-to-definition, your Vim bindings and the Claude Code IDE connection work as usual.

## Requirements

- [Claude Code CLI](https://claude.com/claude-code) (`claude`), logged in. It writes the tour.
- Optional: Codex CLI (`codex`), logged in. It is the second reviewer.
- Optional: GitHub CLI (`gh`), logged in. Needed to start from a PR number and to submit a review.

## Start a review

Open the repository folder, then use any of:

- the **Review Guide** button in the status bar,
- the **Start Guided Review** button in the Review Guide side bar,
- the command **Review Guide: Start Review**.

Enter a PR number or URL, or leave the box empty to review the current branch against its base. A PR is checked out with `gh pr checkout`; if you have uncommitted changes the extension stops instead of touching them.

Preparing a tour takes a few minutes. Tours, progress, notes and findings are cached per commit in `.git/review-guide/`, so reopening a review is instant.

## What you get

- **Overview**: what the change does in business terms, an **Explain like I'm 5** section (a plain-language version for someone new to the domain, not written for a child), where a mistake would hurt, a flow or sequence diagram, and a database diagram when the change touches queries or migrations.
- **Drafted comments on the risks**: each entry under "Where a mistake would hurt" comes with a review comment already written for the line it concerns. **Agree, add this comment** turns it into one of your notes in one click (Undo removes it); it is posted with your review when you submit. Risks with nothing concrete to ask have no draft.
- **Reviewer chips**: the **Claude: n findings** and **Codex: n findings** chips at the top open that agent's verdict and all its findings.
- **Steps**: each opens the real file at one chunk, dims the rest, and explains what the chunk is for, why it changed, and what to check. Every changed hunk is covered; anything the agent failed to explain is listed under "Not yet explained" rather than dropped.
- **Inline note**: each chunk carries a short note in the editor, directly above the code. It only says what the code does not show: where the chunk fits (which user action or caller reaches it), a fact that is not in the code (a reason, a domain meaning, a rule defined elsewhere), and the one thing to check. The guide tab has the fuller explanation.
- **Changed files**: starting a review switches the side bar to Review Guide. Its **Changed Files** view lists every changed file with a checkbox: checked once all its chunks are read, `2/5 read` while partly read, and the view title shows how many files are left. Expand a file to see its chunks; the current chunk stays selected as you step. Tick or untick boxes yourself to mark things read or unread. You can drag the view into the Explorer if you prefer it there. When you review a pull request, a file whose chunks are all read is also ticked **Viewed** on GitHub (shown as `read, viewed on GitHub`), and unticked there if you mark it unread again. Files you ticked on GitHub yourself are never unticked.
- **Agent findings**: each configured reviewer reviews the whole change on its own. Findings show on the step whose lines they concern. A finding is marked when another agent flagged the same lines too. That is a match on location, so read both before treating it as agreement.
- **Finish**: how many steps you understood, your concerns, open findings, a few questions to check your understanding, and your notes.
- **Submit**: posts your notes as one GitHub review (Comment, Approve or Request changes) after you confirm. Notes on lines outside the diff go into the review body.

A review that is open stays open while you start another: if the new one is cancelled, fails, or opens in another worktree's window, the first carries on where it was, so two PRs in two worktrees can be reviewed side by side, one window each.

Reloading or reopening the window brings the review back at the step you were on, as long as the checkout is still on the same commit. **Review Guide: End Review** ends it for good.

## Keys

The guide opens as a tab among your code tabs, so the editor is never split: you see either the guide or the code. A step shows its code with a one-paragraph note above it; `ctrl+alt+g` switches to the guide for the full explanation, and `b` in the guide returns to the code. Set `reviewGuide.layout` to `split` to have the guide beside the code instead.

With VSCodeVim in normal mode, plain `n` and `p` in a code editor go to the next and previous step while a review is active. This replaces Vim's search-next and paste during the review; turn it off with `reviewGuide.stepKeysInEditor` and use `alt+j`/`alt+k`.

Press `?` for a list of every shortcut: in the guide tab, or in a code editor with Vim in normal mode (there it replaces Vim's backward search during the review, under the same `reviewGuide.stepKeysInEditor` setting). **Review Guide: Show Keyboard Shortcuts** in the command palette opens the same list. Picking an editor shortcut from the list runs it.

With VSCodeVim, the other actions are on backslash chords in normal mode, so nothing depends on the alt key: `\d` diff, `\i` isolate, `\u` understood, `\x` concern, `\c` note, `\e` explain (also in visual mode, for the selection), `\o` overview, `\b` back to the chunk, `\g` guide, `\f` finish.

In the editor (only while a review is active):

| Key | Action |
| --- | --- |
| `alt+j` / `alt+k` | next / previous step |
| `alt+u` | mark understood and go to the next step |
| `alt+x` | mark as concern and write a note |
| `alt+c` | add a note at the cursor line |
| `alt+e` | explain the selection (or the current chunk) |
| `alt+d` | toggle diff view (base on the left, real file on the right) |
| `alt+i` | toggle isolate: fold everything except the chunk |
| `alt+b` | back to the current chunk, after you wandered off with go-to-definition |
| `alt+o` | overview |
| `ctrl+alt+g` | focus the guide |

In the panel: `j`/`k` scroll, `ctrl+d`/`ctrl+u` half page, `gg`/`G` top/bottom, `n`/`p` (or `l`/`h`) next/previous step, `u` understood, `x` concern, `c` note, `e` explain, `a` ask about selected guide text, `d` diff, `i` isolate, `b` jump to the code, `o` overview, `f` finish.

### Vim leader mappings

With VSCodeVim, add to `settings.json` to drive the review from normal mode:

```json
"vim.normalModeKeyBindingsNonRecursive": [
  { "before": ["<leader>", "j"], "commands": ["reviewGuide.next"] },
  { "before": ["<leader>", "k"], "commands": ["reviewGuide.prev"] },
  { "before": ["<leader>", "u"], "commands": ["reviewGuide.markUnderstood"] },
  { "before": ["<leader>", "x"], "commands": ["reviewGuide.markConcern"] },
  { "before": ["<leader>", "c"], "commands": ["reviewGuide.addNote"] },
  { "before": ["<leader>", "d"], "commands": ["reviewGuide.toggleDiff"] },
  { "before": ["<leader>", "i"], "commands": ["reviewGuide.toggleIsolate"] },
  { "before": ["<leader>", "b"], "commands": ["reviewGuide.backToStep"] },
  { "before": ["<leader>", "o"], "commands": ["reviewGuide.overview"] },
  { "before": ["<leader>", "p"], "commands": ["reviewGuide.focusPanel"] }
],
"vim.visualModeKeyBindingsNonRecursive": [
  { "before": ["<leader>", "e"], "commands": ["reviewGuide.explainSelection"] }
]
```

### Homerow

Every control in the panel is a real button with a text label, and the step list is a native tree view, so Homerow has labelled targets to hint. This has not been tested with Homerow itself yet.

## Understanding a piece of code

- Select text in the guide itself (an explanation, a risk, a finding) and choose **Ask about this**, or press `a`. Type a question and press Enter; the answer appears in the popup and is kept under your questions for that step. Leave the question empty to have the passage explained in more depth.
- Select code in the editor: an **Ask Review Guide about this** link appears just above the selection (or press `alt+e`). Type a question, or press Enter for a plain explanation. The answer appears inline under the code you selected and is also kept in the guide under your questions for that step. Turn the link off with `reviewGuide.askLens`.
- Keep the conversation going: the answer under the code has a reply box. Type a follow-up and press **Ask**; each answer builds on what was already said. **Add Review Comment** (below the box, or the icon in the thread's title bar) has the agent write a review comment from the conversation and adds it to your notes, so it is posted when you submit the review. Anything typed in the box first says what the comment should ask for. Delete it under the step's notes in the guide if you change your mind.
- The Claude Code extension still sees your selection as usual, for longer conversations.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `reviewGuide.tourAgent` | `claude` | Agent that writes the tour and answers Explain Selection. |
| `reviewGuide.reviewers` | `["claude", "codex"]` | Agents that review independently. An agent whose CLI is missing is skipped. |
| `reviewGuide.claudeModel`, `reviewGuide.codexModel` | empty | Model override; empty uses the CLI default. |
| `reviewGuide.claudePath`, `reviewGuide.codexPath` | `claude`, `codex` | CLI locations. |
| `reviewGuide.layout` | `tab` | `tab`: guide is a tab in the same editor group. `split`: guide sits beside the code. |
| `reviewGuide.stepKeysInEditor` | `true` | `n`/`p` step through the review from a code editor in Vim normal mode. |
| `reviewGuide.syncViewedToGitHub` | `true` | Tick "Viewed" on the GitHub PR for each file once all its chunks are read. |
| `reviewGuide.singlePassMaxChars` | `120000` | Larger diffs are toured in two passes: an outline, then each section in parallel. |
| `reviewGuide.timeoutMinutes` | `20` | Limit for one agent run. |

Agents run read-only: Claude is limited to reading and searching files and to `git log`, `git show` and `git blame`; Codex runs in its read-only sandbox.

## Development

```sh
npm install
npm run build      # bundles the extension and the panel into dist/
npm test           # unit tests
npm run package    # builds review-guide.vsix
```

Press F5 in VS Code to try it in an Extension Development Host.
