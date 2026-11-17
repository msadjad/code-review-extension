import { spawn } from "node:child_process";
import { resolveBinary } from "./agents";

export interface PrInfo {
  /** GraphQL node id, needed to tick "Viewed" on files. */
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  author: string;
}

export async function exec(cmd: string, args: string[], cwd: string, input?: string): Promise<string> {
  const bin = await resolveBinary(cmd);
  return new Promise((res, rej) => {
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => rej(new Error(`Could not run ${cmd}: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) res(Buffer.concat(out).toString("utf8"));
      else rej(new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${err.trim() || `exit ${code}`}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input ?? "");
  });
}

const git = (cwd: string, ...args: string[]) => exec("git", args, cwd);

async function tryGit(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    return (await git(cwd, ...args)).trim();
  } catch {
    return undefined;
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, "rev-parse", "--show-toplevel")).trim();
}

/** Directory for caches: inside .git so the working tree stays clean. */
export async function storageDir(root: string): Promise<string> {
  const dir = (await git(root, "rev-parse", "--absolute-git-dir")).trim();
  return `${dir}/review-guide`;
}

export async function isDirty(root: string): Promise<boolean> {
  return (await git(root, "status", "--porcelain", "--untracked-files=no")).trim() !== "";
}

export async function headSha(root: string): Promise<string> {
  return (await git(root, "rev-parse", "HEAD")).trim();
}

export async function currentBranch(root: string): Promise<string> {
  return (await tryGit(root, "rev-parse", "--abbrev-ref", "HEAD")) ?? "HEAD";
}

/** Best guess at the branch the current work will merge into. */
export async function defaultBase(root: string): Promise<string | undefined> {
  const originHead = await tryGit(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  const candidates = [originHead, "origin/main", "origin/master", "main", "master"];
  for (const c of candidates) {
    if (c && (await tryGit(root, "rev-parse", "--verify", "--quiet", `${c}^{commit}`))) return c;
  }
  return undefined;
}

export async function mergeBase(root: string, base: string): Promise<string> {
  return (await git(root, "merge-base", base, "HEAD")).trim();
}

export async function diffAgainst(root: string, baseSha: string): Promise<string> {
  return git(root, "diff", "--no-color", "--no-ext-diff", "--find-renames", "--unified=3", baseSha, "HEAD");
}

export async function showFile(root: string, ref: string, path: string): Promise<string> {
  return git(root, "show", `${ref}:${path}`);
}

export async function prInfo(root: string, ref: string): Promise<PrInfo> {
  const fields = "id,number,title,body,url,baseRefName,headRefName,headRefOid,author";
  const args = ["pr", "view", "--json", fields];
  if (ref) args.splice(2, 0, ref);
  const raw = JSON.parse(await exec("gh", args, root));
  return { ...raw, body: raw.body ?? "", author: raw.author?.login ?? "" };
}

export async function prCheckout(root: string, number: number): Promise<void> {
  await exec("gh", ["pr", "checkout", String(number)], root);
}

/**
 * Checks out the PR's head commit without a branch. Used when the PR branch cannot be
 * checked out here because another worktree already has it.
 */
export async function prCheckoutDetached(root: string, number: number): Promise<void> {
  await git(root, "fetch", "origin", `pull/${number}/head`);
  await git(root, "checkout", "--detach", "FETCH_HEAD");
}

/** The worktree (other than `root`) that has `branch` checked out, if any. */
export async function worktreeForBranch(root: string, branch: string): Promise<string | undefined> {
  const out = await tryGit(root, "worktree", "list", "--porcelain");
  if (!out) return undefined;
  const here = await tryGit(root, "rev-parse", "--show-toplevel");
  for (const block of out.split(/\n\s*\n/)) {
    const dir = /^worktree (.+)$/m.exec(block)?.[1];
    const ref = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (dir && ref === branch && dir !== here) return dir;
  }
  return undefined;
}

/** The other worktree a failed checkout says holds the branch, if that is why it failed. */
export function worktreeHoldingBranch(message: string): string | undefined {
  const m = /already (?:used by worktree|checked out) at '([^']+)'/.exec(message);
  return m?.[1];
}

export async function fetchBase(root: string, baseRefName: string): Promise<string> {
  await tryGit(root, "fetch", "origin", baseRefName);
  const remote = `origin/${baseRefName}`;
  if (await tryGit(root, "rev-parse", "--verify", "--quiet", `${remote}^{commit}`)) return remote;
  return baseRefName;
}

export async function repoSlug(root: string): Promise<string> {
  const raw = JSON.parse(await exec("gh", ["repo", "view", "--json", "nameWithOwner"], root));
  return raw.nameWithOwner;
}

export async function postReview(root: string, slug: string, number: number, payload: object): Promise<string> {
  const out = await exec(
    "gh",
    ["api", `repos/${slug}/pulls/${number}/reviews`, "--method", "POST", "--input", "-"],
    root,
    JSON.stringify(payload),
  );
  try {
    return JSON.parse(out).html_url ?? "";
  } catch {
    return "";
  }
}

/** Paths the signed-in user has ticked "Viewed" on in the PR. */
export async function viewedFiles(root: string, prId: string): Promise<Set<string>> {
  const query =
    "query($id:ID!,$after:String){node(id:$id){... on PullRequest{files(first:100,after:$after){" +
    "pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}";
  const viewed = new Set<string>();
  let after = "";
  for (let page = 0; page < 50; page++) {
    const args = ["api", "graphql", "-f", `query=${query}`, "-f", `id=${prId}`];
    if (after) args.push("-f", `after=${after}`);
    const files = JSON.parse(await exec("gh", args, root)).data?.node?.files;
    for (const f of files?.nodes ?? []) if (f.viewerViewedState === "VIEWED") viewed.add(f.path);
    if (!files?.pageInfo?.hasNextPage) break;
    after = files.pageInfo.endCursor;
  }
  return viewed;
}

/** Ticks or unticks "Viewed" on one file of the PR. Only the signed-in user sees this. */
export async function setFileViewed(root: string, prId: string, file: string, viewed: boolean): Promise<void> {
  const name = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
  const query = `mutation($id:ID!,$path:String!){${name}(input:{pullRequestId:$id,path:$path}){clientMutationId}}`;
  await exec("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `id=${prId}`, "-f", `path=${file}`], root);
}
