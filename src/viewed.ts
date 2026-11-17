/** Files whose every chunk has been read. */
export function fullyReadFiles(steps: { id: string; file: string }[], visited: string[]): Set<string> {
  const read = new Set(visited);
  const unread = new Set<string>();
  const files = new Set<string>();
  for (const s of steps) {
    files.add(s.file);
    if (!read.has(s.id)) unread.add(s.file);
  }
  return new Set([...files].filter((f) => !unread.has(f)));
}

/**
 * What to change on GitHub so its "Viewed" boxes follow the files read here.
 * A file is only unticked when it stopped being fully read here, so files ticked by hand
 * on GitHub are left alone.
 */
export function planViewedSync(
  done: Set<string>,
  previouslyDone: Set<string>,
  onGitHub: Set<string>,
): { mark: string[]; unmark: string[] } {
  return {
    mark: [...done].filter((f) => !onGitHub.has(f)),
    unmark: [...previouslyDone].filter((f) => !done.has(f) && onGitHub.has(f)),
  };
}
