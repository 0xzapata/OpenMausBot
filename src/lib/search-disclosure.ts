import { useEffect, useState, type SetStateAction } from "react";

const chosen = new Map<string, boolean>();

export function forgetSearchDisclosuresForTests(): void {
  chosen.clear();
}

export function useSearchDisclosure(
  key: string,
  query: string,
  matches: boolean,
  initial = false,
): [boolean, (next: SetStateAction<boolean>) => void] {
  const [own, setOwn] = useState(() => chosen.get(key) ?? initial);
  const [during, setDuring] = useState<boolean | null>(null);
  useEffect(() => setDuring(null), [query]);
  const searching = Boolean(query.trim());
  const open = searching ? (during ?? matches) : own;
  const set = (next: SetStateAction<boolean>) => {
    const value = typeof next === "function" ? next(open) : next;
    if (searching) {
      setDuring(value);
      return;
    }
    chosen.set(key, value);
    setOwn(value);
  };
  return [open, set];
}

export function searchMatchesThreads(
  query: string,
  tasks: ReadonlyArray<{ title: string; routineRunId?: string }> | undefined,
  folders: ReadonlyArray<{ name: string }> | undefined = [],
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return Boolean(tasks?.some((task) => !task.routineRunId && task.title.toLowerCase().includes(q)))
    || folders.some((folder) => folder.name.toLowerCase().includes(q));
}
