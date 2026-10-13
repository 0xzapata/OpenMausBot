// The safety floor: a short never-list of shell commands the server will not
// approve by itself, at any approval level.
//
// Full access means "answer every permission request for me" and a saved
// command means "answer this one". Neither was meant to cover wiping the
// machine. The list is what no task needs: a recursive delete of the
// filesystem root, of the home directory or of a top-level system directory;
// formatting or overwriting a disk; a fork bomb.
//
// This file only reads a command line and names the rule it meets. It does no
// I/O and decides nothing about approvals: server/safety-floor-gate.ts applies
// it where the server would otherwise allow a command with nobody looking.
//
// The two possible mistakes are not equal. Blocking a command that was fine
// stops real work and teaches people to switch the floor off, so every rule
// leans towards letting a command through: a path the text does not spell out
// (`rm -rf "$DIR"`), a relative path, and any spelling the reader below does
// not understand are all allowed. The same words as DATA are never a command:
// a commit message, an echo, a heredoc body, a comment.
//
// So the command is read the way a shell reads it, far enough to tell a
// command from its arguments: quotes, escapes, `;` `&&` `||` `|` and newlines,
// subshells, `$( … )`, heredocs, redirections, and the wrappers that run
// another command line (`sudo`, `env`, `sh -c`, `cmd /c`, `powershell -Command`).
//
// Nothing says which shell a line is for, and the two families disagree about
// a backslash: POSIX shells escape with it, cmd and PowerShell end a path with
// it. So a line is read both ways. The POSIX reading feeds the POSIX rules
// (`rm`, `dd`, `mkfs`, `diskutil`, redirections); the cmd and PowerShell
// reading feeds theirs (`rd`, `del`, `Remove-Item`, `format`). A line that is
// plainly one kind is read only that way: a heredoc or a backslash at the end
// of a line is POSIX, and quotes that close in one reading and not in the
// other settle it too.

export type FloorRule = "delete-root" | "delete-home" | "delete-system-directory" | "format-disk" | "overwrite-disk" | "fork-bomb";

export interface FloorVerdict {
  /** Which rule matched: a stable name, for the decision log. */
  rule: FloorRule;
  /** What was blocked, in words a person reads. Never the command itself, so
   * a credential typed into the command line cannot travel with it. */
  label: string;
}

const DELETE_ROOT: FloorVerdict = { rule: "delete-root", label: "recursive delete of the filesystem root" };
const DELETE_DRIVE: FloorVerdict = { rule: "delete-root", label: "recursive delete of a drive root" };
const DELETE_HOME: FloorVerdict = { rule: "delete-home", label: "recursive delete of the home directory" };
const FORMAT_DISK: FloorVerdict = { rule: "format-disk", label: "formatting a disk" };
const OVERWRITE_DISK: FloorVerdict = { rule: "overwrite-disk", label: "overwriting a disk device" };
const FORK_BOMB: FloorVerdict = { rule: "fork-bomb", label: "a fork bomb" };
const deleteSystem = (name: string): FloorVerdict => ({ rule: "delete-system-directory", label: `recursive delete of ${name}` });

/** Top-level directories a machine does not survive losing. */
const SYSTEM_DIRECTORIES = [
  "/etc", "/usr", "/bin", "/sbin", "/var", "/boot", "/home", "/lib", "/lib32", "/lib64", "/libx32", "/lib*",
  "/System", "/Library", "/Applications", "/Users",
];
/** Where macOS really keeps `/etc` and `/var`. Anywhere else `/private` is
 * a directory somebody made. */
const MAC_DIRECTORIES = ["/private", "/private/etc", "/private/var"];
/** The same on a Windows drive, by lowercase name. */
const WINDOWS_DIRECTORIES = new Map([
  ["windows", "Windows"], ["users", "Users"], ["program files", "Program Files"],
  ["program files (x86)", "Program Files (x86)"], ["programdata", "ProgramData"],
]);
const deleteWindowsSystem = (name: string): FloorVerdict => deleteSystem(`a Windows system folder (${name})`);

// A lexed word keeps what the shell would substitute as one of two private-use
// characters, so a rule can tell `~` (the home directory) from `'~'` (a
// directory that is only named that), and never guesses at a variable.
/** The home directory: an unquoted `~`, `$HOME`, `%USERPROFILE%`. */
const HOME = "\uE000";
/** Anything else substituted at run time. A word holding one is unknown. */
const DYNAMIC = "\uE001";

/** What `%NAME%` and `$env:NAME` stand for on Windows, by lowercase name. */
const WINDOWS_VARIABLES: Record<string, string> = {
  userprofile: HOME, home: HOME,
  systemdrive: "C:", homedrive: "C:",
  systemroot: "C:\\Windows", windir: "C:\\Windows",
  programfiles: "C:\\Program Files", "programfiles(x86)": "C:\\Program Files (x86)",
  programdata: "C:\\ProgramData", allusersprofile: "C:\\ProgramData",
};

/** A whole disk, one of its partitions, a RAID array or a mapped volume, by
 * device path: what `dd` and a redirection must not write over. `/dev` holds
 * far more that is fine to write to (null, a terminal, a serial port), so
 * this is a list of what is a disk and not of what is not. */
const DISK_DEVICE = /^\/dev\/(?:r?disk\d+(?:s\d+)*|disk\/.+|sd[a-z]{1,3}\d*|hd[a-z]\d*|x?vd[a-z]{1,2}\d*|nvme\d+(?:n\d+)?(?:p\d+)?|mmcblk\d+(?:p\d+)?|md\d+(?:p\d+)?|md\/[^/]+|dm-\d+|mapper\/(?!loop\d)[^/]+)$/;
const diskDevice = (word: string): boolean => DISK_DEVICE.test(word.replace(/\/{2,}/g, "/"));
/** The devices a disk image is built on: loop, RAM, network block and
 * compressed-RAM devices, and a loop device's partitions under /dev/mapper. */
const SCRATCH_DEVICE = /^\/dev\/(?:mapper\/)?(?:loop|ram|nbd|zram)\d/;
/** What `mkfs` must not be pointed at: any device, except the ones above.
 * Nothing but a filesystem's storage is ever handed to mkfs, so here every
 * device counts unless it is known to be scratch. A file is not a device,
 * and a name a variable holds is not known to be one. */
const formatsDevice = (word: string): boolean => {
  const path = word.replace(/\/{2,}/g, "/");
  return /^\/dev\/[^\uE000\uE001]+$/.test(path) && !SCRATCH_DEVICE.test(path);
};

// A function that pipes itself into itself in the background, then runs. The
// name is bounded and must start a word, so a long unbroken token costs
// nothing to rule out.
const BOMB_BODY = String.raw`\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1(?![\w:.-])`;
const BOMB_NAME = String.raw`([A-Za-z_:.][\w:.-]{0,63})`;
const FORK_BOMBS = [
  new RegExp(String.raw`(?:^|[\s;&|(){}])${BOMB_NAME}\s*\(\s*\)${BOMB_BODY}`),
  new RegExp(String.raw`(?:^|[\s;&|(){}])function\s+${BOMB_NAME}\s*(?:\(\s*\))?${BOMB_BODY}`),
];

/** One simple command: what a shell would run as a unit. */
interface Command {
  /** Its words with quotes removed; substitutions appear as HOME or DYNAMIC. */
  words: string[];
  /** Where each word starts in the source. */
  starts: number[];
  /** The files its output is redirected into. */
  writes: string[];
  from: number;
  to: number;
}

/** How deep `$( … )` may nest before the rest is left unread. */
const MAX_NESTING = 40;

interface Reading {
  commands: Command[];
  /** The text outside every quote, heredoc and comment. */
  bare: string;
  /** Every quote that opened also closed. */
  closed: boolean;
  /** The line used something only a POSIX shell has: a heredoc, or a
   * backslash carrying it onto the next line. */
  posixOnly: boolean;
}

/** Whether the text before a `\"` ends in a path, as cmd and PowerShell
 * write one: `"C:\Users\me\"`. There the backslash belongs to the path and
 * the quote closes the string. Anywhere else (`"say \"hi\""`, JSON) the pair
 * is a quote inside the string, which is how programs on Windows read it too. */
function endsInPath(text: string): boolean {
  const last = text.slice(text.search(/\S*$/));
  if (last === "" || last.includes('"')) return false;
  const startsPath = /^(?:[A-Za-z]:|\\\\|\.{1,2}[\\/]|%[^%\s]+%|[\uE000\uE001])/;
  // The last word is a path, or the whole string is one with spaces in it
  // ("C:\Program Files\").
  return startsPath.test(last) || last.includes("\\") || (startsPath.test(text) && !text.includes('"'));
}

/** Reads a command line into its simple commands, every one a shell would
 * run: chained, grouped, or inside `$( … )`. `windows` reads it as cmd and
 * PowerShell do, where a backslash is part of a path and not an escape. */
function lex(source: string, windows: boolean): Reading {
  const commands: Command[] = [];
  const heredocs: Array<{ end: string; tabs: boolean }> = [];
  let bare = "";
  let at = 0;
  let nesting = 0;
  let closed = true;
  let posixOnly = false;

  /** What a variable stands for in a word. */
  const variable = (name: string): string => {
    // ${HOME:?} and ${HOME?message} are $HOME, or an error when it is unset.
    if (!windows) return /^HOME(?::?\?[^}]*)?$/.test(name) ? HOME : DYNAMIC;
    const key = name.toLowerCase();
    if (key === "home") return HOME;
    return key.startsWith("env:") ? WINDOWS_VARIABLES[key.slice(4)] ?? DYNAMIC : DYNAMIC;
  };

  /** Skips to the `shut` that closes an already opened pair; quoted text and
   * nested pairs belong to it. Returns what was inside. Double quotes quote
   * in here even when the pair itself sits between double quotes
   * (`"${X:-"}"}"`); an apostrophe there is only an apostrophe. */
  const balanced = (open: string, shut: string, inDoubleQuotes: boolean): string => {
    const from = at;
    for (let depth = 1; at < source.length; at++) {
      const c = source[at];
      if (c === "\\" && !windows) at++;
      else if (c === "'" && !inDoubleQuotes) at = endOf("'", at + 1);
      else if (c === '"') {
        for (at++; at < source.length && source[at] !== '"'; at++) if (source[at] === "\\" && !windows) at++;
      } else if (c === open) depth++;
      else if (c === shut && --depth === 0) return source.slice(from, at++);
    }
    return source.slice(from);
  };
  /** The index of the next `mark`, or the end of the source. */
  const endOf = (mark: string, from: number): number => {
    const found = source.indexOf(mark, from);
    return found === -1 ? source.length : found;
  };

  /** A `$name`, `${name}` or `$'…'` at the cursor: consumes it and returns
   * what it adds to a word. */
  const variableAt = (inDoubleQuotes: boolean): string => {
    const next = source[at + 1];
    if (next === "{") {
      at += 2;
      return variable(balanced("{", "}", inDoubleQuotes));
    }
    if (next === "'" && !windows && !inDoubleQuotes) {
      // $'…' decodes escapes such as \x2f, so its text is not read here.
      for (at += 2; at < source.length && source[at] !== "'"; at++) if (source[at] === "\\") at++;
      at++;
      return DYNAMIC;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(at + 1, at + 130))?.[0];
    if (name) {
      at += 1 + name.length;
      const scoped = windows && name.toLowerCase() === "env" ? /^:[A-Za-z0-9_]+/.exec(source.slice(at, at + 130))?.[0] : undefined;
      if (scoped) at += scoped.length;
      return variable(name + (scoped ?? ""));
    }
    if (next !== undefined && /[0-9@*#?$!_-]/.test(next)) {
      at += 2;
      return DYNAMIC;
    }
    at++;
    return "$";
  };

  /** Reads commands until `close` ends this script, or the source ends. */
  function script(close: string | null): void {
    let command: Command = { words: [], starts: [], writes: [], from: at, to: at };
    // Written through the helpers below, so its type is stated rather than
    // narrowed from this first value.
    let word = null as string | null;
    let wordAt = 0;
    let token = 0;
    /** What the next word is, when it is not an argument. */
    let next: "argument" | "write" | "read" | "heredoc" | "heredoc-tabs" = "argument";
    let depth = 0;

    const add = (text: string) => {
      if (word === null) {
        word = "";
        wordAt = token;
      }
      word += text;
    };
    const endWord = () => {
      if (word === null) return;
      if (next === "argument") {
        command.words.push(word);
        command.starts.push(wordAt);
      } else if (next === "write") command.writes.push(word);
      else if (next !== "read") heredocs.push({ end: word, tabs: next === "heredoc-tabs" });
      word = null;
      next = "argument";
    };
    /** Ends the command at the cursor and starts the next one `skip` later. */
    const cut = (skip: number) => {
      endWord();
      next = "argument";
      command.to = at;
      if (command.words.length || command.writes.length) commands.push(command);
      at += skip;
      command = { words: [], starts: [], writes: [], from: at, to: at };
    };
    const nested = (shut: string) => {
      if (++nesting > MAX_NESTING) at = source.length;
      else script(shut);
      nesting--;
    };
    /** The text between double quotes; the cursor is just past the opening one. */
    const quoted = () => {
      const from = (word ?? "").length;
      while (at < source.length) {
        const c = source[at];
        const after = source[at + 1];
        if (c === '"') {
          at++;
          return;
        }
        if (!windows && c === "\\" && after !== undefined && "$`\"\\\n".includes(after)) {
          if (after !== "\n") add(after);
          at += 2;
        } else if (windows && c === "`" && after !== undefined) {
          add(after);
          at += 2;
        } else if (windows && c === "\\" && after === '"' && !endsInPath((word ?? "").slice(from))) {
          add('"');
          at += 2;
        } else if (c === "$") add(dollar(true));
        else if (c === "`" && !windows) {
          at++;
          nested("`");
          add(DYNAMIC);
        } else {
          add(c);
          at++;
        }
      }
      closed = false;
    };
    /** `$( … )` runs what is inside it; every other `$` is a variable. */
    const dollar = (inDoubleQuotes: boolean): string => {
      if (source[at + 1] !== "(") return variableAt(inDoubleQuotes);
      at += 2;
      // $(( … )) is arithmetic: `<<` in it shifts, and nothing in it runs.
      if (source[at] === "(") balanced("(", ")", inDoubleQuotes);
      else nested(")");
      return DYNAMIC;
    };

    while (at < source.length) {
      const c = source[at];
      const after = source[at + 1];
      token = at;
      if (c === close && depth === 0) {
        cut(1);
        return;
      }
      if (windows ? c === "^" || c === "`" : c === "\\") {
        // An escaped newline continues the line; anything else is itself.
        if (after !== "\n" && after !== undefined) add(after);
        else if (after === "\n" && !windows) posixOnly = true;
        at += 2;
      } else if (c === "'") {
        const end = endOf("'", at + 1);
        if (end === source.length) closed = false;
        add(source.slice(at + 1, end));
        at = end + 1;
      } else if (c === '"') {
        add("");
        at++;
        quoted();
      } else if (c === "$") add(dollar(false));
      else if (c === "`") {
        at++;
        nested("`");
        add(DYNAMIC);
      } else if (c === " " || c === "\t" || c === "\r") {
        endWord();
        bare += c;
        at++;
      } else if (c === "\n") {
        cut(1);
        bare += c;
        // A heredoc's body is input, not commands: skip to its closing line.
        for (const heredoc of heredocs.splice(0)) {
          posixOnly = true;
          while (at < source.length) {
            const end = endOf("\n", at);
            const line = source.slice(at, end).replace(/\r$/, "");
            at = Math.min(end + 1, source.length);
            if ((heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.end) break;
          }
        }
        command.from = command.to = at;
      } else if (c === "#" && word === null) at = endOf("\n", at);
      else if (c === ";" || c === "|" || (c === "&" && after !== ">")) {
        bare += c;
        cut(1);
      } else if (c === "(" && word !== null && !/^\s*\)/.test(source.slice(at + 1, at + 40))) {
        // Inside a word, `( … )` is data and not a subshell: the words of an
        // array (name=( … )) or a group in a path (logs/(old|tmp)). Either
        // way the word is one this text cannot place. `name()` with nothing
        // inside defines a function, and is read below.
        at++;
        balanced("(", ")", false);
        add(DYNAMIC);
      } else if (c === "(" || c === ")") {
        // A subshell, or the parentheses of a function: what is inside runs.
        bare += c;
        depth = Math.max(0, depth + (c === "(" ? 1 : -1));
        cut(1);
      } else if ((c === "<" || c === ">") && after === "(") {
        at += 2;
        nested(")");
        add(DYNAMIC);
      } else if (c === "<" || c === ">" || c === "&") {
        // A redirection. Digits right before it name a descriptor (2>).
        if (word !== null && /^\d+$/.test(word)) word = null;
        else endWord();
        bare += c;
        at += c === "&" ? 2 : 1;
        const duplicate = () => {
          const descriptor = /^&[\d-]+/.exec(source.slice(at, at + 12))?.[0];
          if (descriptor) at += descriptor.length;
          else if (source[at] === "&") at++;
          return Boolean(descriptor);
        };
        if (c !== "<") {
          if (source[at] === ">" || source[at] === "|") at++;
          next = duplicate() ? "argument" : "write";
        } else if (source[at] === "<") {
          at++;
          const hereString = source[at] === "<" || windows;
          const tabs = !hereString && source[at] === "-";
          if (source[at] === "<" || tabs) at++;
          next = hereString ? "read" : tabs ? "heredoc-tabs" : "heredoc";
        } else if (source[at] === ">") {
          at++;
          next = "write";
        } else next = duplicate() ? "argument" : "read";
      } else if (c === "~" && word === null) {
        // `~` and `~/…` are the home directory; `~name` is somebody else's.
        add(after === undefined || /[\s/;&|()<>`]/.test(after) || (windows && after === "\\") ? HOME : DYNAMIC);
        bare += c;
        at++;
      } else {
        add(c);
        bare += c;
        at++;
      }
    }
    cut(0);
  }

  script(null);
  return { commands, bare, closed, posixOnly };
}

/** Commands that run the command line after them. `values`: the one-letter
 * options that take a value of their own, `named` the long ones. `asks`: the
 * options that make it report on a command instead of running it. */
const PREFIXES: Record<string, { values?: string; named?: string[]; operands?: number; asks?: string; asksNamed?: string[] }> = {
  // `sudo -l rm` lists whether rm may be run; it runs nothing.
  sudo: { values: "CDghpRrtTUu", named: ["user", "group", "host", "prompt", "chdir", "chroot", "role", "type", "other-user", "close-from", "command-timeout"], asks: "l", asksNamed: ["list"] },
  doas: { values: "Cu" },
  env: { values: "uCS", named: ["unset", "chdir", "split-string"] },
  nice: { values: "n", named: ["adjustment"] },
  timeout: { values: "ks", named: ["kill-after", "signal"], operands: 1 },
  exec: { values: "a" },
  // `command -v rm` looks a command up; it does not run it.
  command: { asks: "vV" },
  nohup: {}, time: {}, builtin: {}, busybox: {},
};
/** Shell words that sit in front of a command without being one. */
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);
/** How many command lines deep a wrapper is followed (`sh -c "bash -c …"`). */
const MAX_DEPTH = 4;

/** The program a word names: no directory, no `.exe`, lowercase. */
function programName(word: string): string {
  return word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1).toLowerCase().replace(/\.(?:exe|com|cmd|bat)$/, "");
}

/** The index of the word that is the command itself, past variable
 * assignments, shell keywords and prefix commands; -1 when there is none. */
function commandIndex(words: string[]): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (ASSIGNMENT.test(word) || KEYWORDS.has(word)) {
      index++;
      continue;
    }
    if (word === "function") {
      // `function name { … }`: the body is what would run.
      index += 2;
      continue;
    }
    const prefix = PREFIXES[programName(word)];
    if (!prefix) return index;
    index++;
    while (index < words.length && /^-./.test(words[index])) {
      const option = words[index++];
      if (option === "--") break;
      if (option.startsWith("--")) {
        if (prefix.asksNamed?.includes(option.slice(2))) return -1;
        if (prefix.named?.includes(option.slice(2))) index++;
        continue;
      }
      // In a cluster the first letter that takes a value ends the options:
      // the value is the rest of the word (-uroot), or the next word when
      // nothing is left (-u root, -nu root).
      const letters = option.slice(1).split("");
      const value = letters.findIndex((letter) => prefix.values?.includes(letter));
      if (letters.slice(0, value < 0 ? undefined : value).some((letter) => prefix.asks?.includes(letter))) return -1;
      if (value === letters.length - 1) index++;
    }
    index += prefix.operands ?? 0;
  }
  return -1;
}

/** The command line a shell is handed with `-c`, or null. */
function inlineScript(args: string[]): string | null {
  let inline = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (/^--[a-z-]+$/.test(arg)) {
      if (arg === "--rcfile" || arg === "--init-file") index++;
    } else if (/^[-+][A-Za-z]+$/.test(arg)) {
      if (arg[0] === "-" && arg.includes("c")) inline = true;
      // -o pipefail and -O extglob take a value
      if (/[oO]$/.test(arg)) index++;
    } else return inline ? arg : null;
  }
  return null;
}

/** What `rm` is asked to delete, or null when it is not recursive. Options
 * may come in any order and on either side of the paths. */
function rmTargets(args: string[]): string[] | null {
  const targets: string[] = [];
  let recursive = false;
  let operandsOnly = false;
  for (const arg of args) {
    if (operandsOnly || !/^-./.test(arg)) targets.push(arg);
    else if (arg === "--") operandsOnly = true;
    // -r, -R, or either inside a cluster of rm's own letters; --recursive and
    // the prefixes of it that GNU rm accepts.
    else if (/^-[dfiIPvWx]*[rR][dfiIPRrvWx]*$/.test(arg) || (arg.length > 2 && "--recursive".startsWith(arg))) recursive = true;
  }
  return recursive ? targets : null;
}

/** `.` and `..` resolved by spelling, and a final `*` dropped: everything in
 * a directory is the directory. `above` counts steps past the start. */
function resolved(segments: string[]): { parts: string[]; above: number } {
  const parts: string[] = [];
  let above = 0;
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") parts.push(segment);
    else if (parts.length) parts.pop();
    else above++;
  }
  if (parts.at(-1) === "*" || parts.at(-1) === "*.*") parts.pop();
  return { parts, above };
}

interface Host {
  /** macOS and Windows find `/ETC` where Linux does not. */
  foldCase: boolean;
  mac: boolean;
  windows: boolean;
  /** The home directory's own absolute path, when the caller knows it. */
  home?: string;
}

/** A home directory that is, or sits inside, a scratch place: HOME=/tmp in a
 * container, a fixture's throwaway home under the temp folder. Deleting one
 * is cleanup, so its path is not taken for the home directory. `~` and
 * `$HOME` in a command still mean home, whatever they point at. */
const SCRATCH_HOME = /(?:^|[\\/])te?mp(?:[\\/]|$)|^(?:\/private)?\/var\/folders(?:\/|$)|^\/dev\/shm(?:\/|$)/i;

/** Why deleting this path recursively is on the never-list, or null. The
 * path is one a POSIX shell would hand to `rm`. */
function posixTarget(word: string, host: Host): FloorVerdict | null {
  if (word.includes(DYNAMIC)) return null;
  const fromHome = word.startsWith(HOME);
  const path = fromHome ? word.slice(1) : word;
  if (path.includes(HOME) || !(path.startsWith("/") || (fromHome && path === ""))) return null;
  const { parts } = resolved(path.split("/"));
  // `~`, and `~/..` or anything above it, which holds the home directory.
  // `~/../name` is a place this text cannot place, so it is left alone.
  if (fromHome) return parts.length ? null : DELETE_HOME;
  if (!parts.length) return DELETE_ROOT;
  const spelled = `/${parts.join("/")}`;
  const same = (left: string, right: string) => host.foldCase ? left.toLowerCase() === right.toLowerCase() : left === right;
  const system = [...SYSTEM_DIRECTORIES, ...(host.mac ? MAC_DIRECTORIES : [])].find((directory) => same(directory, spelled));
  if (system) return deleteSystem(system);
  // A Windows home (C:\Users\me) is /c/Users/me to the Git Bash it ships.
  const home = host.home?.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_match, drive: string) => `/${drive.toLowerCase()}`).replace(/\/+$/, "");
  if (home?.startsWith("/") && same(home, spelled)) return DELETE_HOME;
  // A Windows drive as Git Bash spells it: on Windows a one-letter directory
  // at the root is a drive. (WSL's /mnt/c is not read: on any other Linux
  // /mnt/<letter> is a mount somebody named, and the text cannot tell.)
  const drive = host.windows ? /^\/[A-Za-z](?:\/(.+))?$/.exec(spelled) : null;
  if (!drive) return null;
  if (drive[1] === undefined) return DELETE_DRIVE;
  const folder = WINDOWS_DIRECTORIES.get(drive[1].toLowerCase());
  return folder ? deleteWindowsSystem(folder) : null;
}

/** The same for a path as cmd and PowerShell read it. `percent`: the command
 * is one of cmd's, which substitutes `%NAME%` wherever it appears. */
function windowsTarget(word: string, percent: boolean, host: Host): FloorVerdict | null {
  const expanded = percent ? word.replace(/%([^%\s]+)%/g, (_match, name: string) => WINDOWS_VARIABLES[name.toLowerCase()] ?? DYNAMIC) : word;
  if (expanded.includes(DYNAMIC)) return null;
  const fromHome = expanded.startsWith(HOME);
  const path = (fromHome ? expanded.slice(1) : expanded).replace(/\//g, "\\");
  const drive = fromHome ? "" : /^[A-Za-z]:/.exec(path)?.[0] ?? "";
  const rest = path.slice(drive.length);
  // `C:` and `C:\` are the drive; `C:name` and `name` depend on where it runs.
  if (path.includes(HOME) || !(rest === "" ? fromHome || drive : rest.startsWith("\\"))) return null;
  // \\server\share is somebody else's machine. After a drive letter a
  // doubled backslash is only a separator written twice.
  if (!drive && !fromHome && rest.startsWith("\\\\")) return null;
  const { parts } = resolved(rest.split("\\"));
  if (fromHome) return parts.length ? null : DELETE_HOME;
  if (!parts.length) return DELETE_DRIVE;
  const folder = parts.length === 1 ? WINDOWS_DIRECTORIES.get(parts[0].toLowerCase()) : undefined;
  if (folder) return deleteWindowsSystem(folder);
  const home = host.home?.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  return home && drive && home === `${drive}\\${parts.join("\\")}`.toLowerCase() ? DELETE_HOME : null;
}

/** How a script is being read. `posix`: as a POSIX shell line, for the POSIX
 * rules. `windows-line`: a line of unknown kind read as cmd and PowerShell
 * would, for their rules alone. `windows`: a script known to be theirs (what
 * follows `cmd /c` or `powershell -Command`), where every rule applies and
 * `rm` is PowerShell's Remove-Item. */
type Mode = "posix" | "windows" | "windows-line";

/** The rule one simple command meets, or null. */
function judge(command: Command, source: string, host: Host, mode: Mode, depth: number): FloorVerdict | null {
  const posixRules = mode !== "windows-line";
  const windowsRules = mode !== "posix";
  if (posixRules && command.writes.some(diskDevice)) return OVERWRITE_DISK;
  const index = commandIndex(command.words);
  if (index < 0) return null;
  const program = programName(command.words[index]);
  const args = command.words.slice(index + 1);
  const run = (line: string | null | undefined, as: Mode) => line && depth < MAX_DEPTH ? scan(line, host, as, depth + 1) : null;

  if (program === "cmd" || program === "powershell" || program === "pwsh") {
    // These take a command line of their own kind, so it is read as they
    // read it even when the line around it is a POSIX one.
    let text = source;
    let read: Command | undefined = command;
    if (mode === "posix") {
      text = source.slice(command.from, command.to);
      read = lex(text, true).commands.find((candidate) => candidate.words.some((word) => programName(word) === program));
    }
    if (!read) return null;
    const first = read.words.findIndex((word) => programName(word) === program) + 1;
    const flag = read.words.findIndex((arg, at) => at >= first &&
      (program === "cmd" ? /^\/[ck]$/i.test(arg) : arg.length > 1 && "-command".startsWith(arg.toLowerCase())));
    if (flag < 0) return null;
    // One quoted argument is the whole command line. Otherwise the line is
    // everything after the flag, with its own quotes still in place.
    const rest = read.words.slice(flag + 1);
    return run(rest.length === 1 ? rest[0] : text.slice(read.starts[flag + 1] ?? read.to, read.to), "windows");
  }
  if (posixRules) {
    if (SHELLS.has(program)) return run(inlineScript(args), "posix");
    if (program === "eval") return run(args.join(" "), mode);
    if (program === "rm") {
      for (const target of rmTargets(args) ?? []) {
        const verdict = posixTarget(target, host);
        if (verdict) return verdict;
      }
    }
    if (program === "dd") return args.some((arg) => arg.startsWith("of=") && diskDevice(arg.slice(3))) ? OVERWRITE_DISK : null;
    // Making a filesystem inside an image file is ordinary work; on a device
    // it erases what the device holds.
    if (program === "mkfs" || program.startsWith("mkfs.")) return args.some(formatsDevice) ? FORMAT_DISK : null;
    if (program === "diskutil") {
      const operands = args.filter((arg) => !arg.startsWith("-"));
      const verb = (operands[0]?.toLowerCase() === "apfs" ? operands[1] : operands[0])?.toLowerCase() ?? "";
      // The disk comes last. One made a moment ago (`$(hdiutil attach …)`, how
      // a RAM disk is created) is not one anybody keeps files on.
      return ["erasedisk", "erasevolume", "reformat"].includes(verb) && !args.at(-1)!.includes(DYNAMIC) ? FORMAT_DISK : null;
    }
  }
  if (!windowsRules) return null;
  // cmd's and PowerShell's own deletes. `rm` is one of them where the shell
  // is known to be PowerShell, or on Windows, where it is PowerShell's name
  // for Remove-Item: elsewhere `rm -rf C:` removes a stray directory that is
  // merely called `C:`.
  const cmdStyle = program === "rd" || program === "rmdir" || program === "del" || program === "erase";
  if (cmdStyle || program === "ri" || program === "remove-item" || (program === "rm" && (mode === "windows" || host.windows))) {
    // cmd writes its switches /s /q (or /s/q); PowerShell writes -Recurse,
    // or any unambiguous start of it.
    const isSwitch = (arg: string) => /^-./.test(arg) || (cmdStyle && /^\/[A-Za-z?]/.test(arg));
    const recursive = args.some((arg) => isSwitch(arg) && (arg[0] === "/"
      ? arg.toLowerCase().split("/").includes("s")
      : "-recurse".startsWith(arg.toLowerCase()))) || (program === "rm" && rmTargets(args) !== null);
    if (!recursive) return null;
    for (const target of args) {
      const verdict = isSwitch(target) ? null : windowsTarget(target, cmdStyle, host);
      if (verdict) return verdict;
    }
    return null;
  }
  if (program === "format") return args.some((arg) => /^[A-Za-z]:\\?$/.test(arg)) ? FORMAT_DISK : null;
  return null;
}

/** The first rule any command of a reading meets. */
function judgeAll(reading: Reading, source: string, host: Host, mode: Mode, depth: number): FloorVerdict | null {
  if (mode !== "windows-line" && FORK_BOMBS.some((bomb) => bomb.test(reading.bare))) return FORK_BOMB;
  for (const command of reading.commands) {
    const verdict = judge(command, source, host, mode, depth);
    if (verdict) return verdict;
  }
  return null;
}

/** A script whose kind is known: what a wrapper hands to another shell. */
function scan(source: string, host: Host, mode: Mode, depth: number): FloorVerdict | null {
  return judgeAll(lex(source, mode !== "posix"), source, host, mode, depth);
}

/** A whole command line, whose shell is not known: read both ways (see the
 * top of this file), each reading for its own rules. */
function scanLine(line: string, host: Host): FloorVerdict | null {
  const posix = lex(line, false);
  const windows = posix.posixOnly ? null : lex(line, true);
  // Quotes that close in only one reading say which kind of line this is.
  const asPosix = !windows || posix.closed || !windows.closed;
  const asWindows = windows !== null && (windows.closed || !posix.closed);
  return (asPosix ? judgeAll(posix, line, host, "posix", 0) : null)
    ?? (asWindows ? judgeAll(windows!, line, host, "windows-line", 0) : null);
}

/** What reading a command line came to: the rule it meets (or none), or
 * that it could not be read at all. The two are different answers: "not on
 * the list" lets an automatic approval go ahead, "could not read" must not. */
export type FloorReading = { read: true; verdict: FloorVerdict | null } | { read: false };

/** Reads a shell command line against the never-list. Never throws: a reader
 * that fails part-way reports `{ read: false }`, so a caller that enforces
 * the floor can refuse to answer for a command nobody understood.
 *
 * Every spelling is read from the text alone, cmd's and PowerShell's
 * included, so the answer is the same wherever the server runs. `platform`
 * (default: this machine's) settles only what the text cannot: macOS and
 * Windows find a directory whatever its letter case, `/private` is a system
 * directory only on macOS, and only on Windows is `rm` also PowerShell's
 * Remove-Item and `/c` a drive. `home` is the home directory's absolute
 * path, for a delete that spells it out instead of writing `~`; without it
 * only `~` and `$HOME` are known to be home. */
export function floorReading(command: string, platform: NodeJS.Platform = process.platform, home?: string): FloorReading {
  if (typeof command !== "string" || !command.trim()) return { read: true, verdict: null };
  try {
    const host: Host = {
      foldCase: platform === "darwin" || platform === "win32",
      mac: platform === "darwin",
      windows: platform === "win32",
      home: home && !SCRATCH_HOME.test(home.replace(/[\\/]+$/, "")) ? home : undefined,
    };
    // The two marker characters mean something only when the lexer wrote them.
    return { read: true, verdict: scanLine(command.replace(/[]/g, "�"), host) };
  } catch {
    return { read: false };
  }
}

/** The never-list rule a shell command line meets, or null when there is
 * none to name: the command is not on the list, or it could not be read.
 * Code that decides an approval from this must use floorReading, which
 * tells those two apart. */
export function floorVerdict(command: string, platform: NodeJS.Platform = process.platform, home?: string): FloorVerdict | null {
  const reading = floorReading(command, platform, home);
  return reading.read ? reading.verdict : null;
}
