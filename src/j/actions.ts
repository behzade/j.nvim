import { FileSystem, Path } from "@effect/platform";
import { Effect } from "effect";
import { runCommand, runCommandInherit } from "../shared/command";

type PathOps = {
  join: (...segments: string[]) => string;
  dirname: (path: string) => string;
  basename: (path: string, ext?: string) => string;
  relative: (from: string, to: string) => string;
  isAbsolute: (path: string) => boolean;
  sep: string;
};

type JournalPaths = {
  path: PathOps;
  journalDir: string;
  notesDir: string;
  stateDir: string;
  stateFile: string;
};

const getHomeDir = Effect.sync(() => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return home || ".";
});

export const getJournalPaths = Effect.gen(function* () {
  const path = yield* Path.Path;
  const homeDir = yield* getHomeDir;
  const journalDir = path.join(homeDir, "journal");
  const notesDir = path.join(journalDir, "notes");
  const stateDir = process.env.XDG_STATE_HOME
    ? path.join(process.env.XDG_STATE_HOME, "lm")
    : path.join(homeDir, ".local", "state", "lm");
  const stateFile = path.join(stateDir, "j-state.json");
  return { path, journalDir, notesDir, stateDir, stateFile } satisfies JournalPaths;
});

const isNotFoundError = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const reason = (error as { reason?: string }).reason;
  const code = (error as { code?: string }).code;
  return reason === "NotFound" || code === "ENOENT";
};

const isDirectoryInfo = (info: unknown) =>
  Boolean(
    (info as { type?: string })?.type?.toLowerCase?.() === "directory" ||
      (info as { isDirectory?: () => boolean })?.isDirectory?.()
  );

const isFileInfo = (info: unknown) =>
  Boolean(
    (info as { type?: string })?.type?.toLowerCase?.() === "file" ||
      (info as { isFile?: () => boolean })?.isFile?.()
  );

const getModifiedTimeMs = (info: unknown) => {
  if (!info || typeof info !== "object") {
    return 0;
  }
  const candidate = info as {
    mtimeMs?: number;
    mtime?: number | Date;
    modified?: number | Date;
    modificationTime?: number | Date;
    modifiedAt?: number | Date;
  };
  const value =
    candidate.mtimeMs ??
    candidate.mtime ??
    candidate.modified ??
    candidate.modificationTime ??
    candidate.modifiedAt ??
    0;
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  return 0;
};

const normalizeTag = (value: string) =>
  value.replace(/[^A-Za-z0-9_-]/g, "").toLowerCase();

const formatDate = (date: Date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

export const dateDaysAgo = (days: number) =>
  formatDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

const entryPathForDate = (paths: JournalPaths, date: string) =>
  paths.path.join(paths.journalDir, `${date}.md`);

const notePathForSlug = (paths: JournalPaths, slug: string) =>
  paths.path.join(paths.notesDir, `${slug}.md`);

const ensureFileExists = (filePath: string, title: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    const exists = yield* fs.stat(filePath).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false))
    );
    if (!exists) {
      yield* fs.writeFileString(filePath, `# ${title}\ntags:\n\n`);
    }
  });

const readFile = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(filePath);
  });

const statFile = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.stat(filePath);
  });

const recordLastOpened = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { stateDir, stateFile } = yield* getJournalPaths;
    yield* fs.makeDirectory(stateDir, { recursive: true });
    yield* fs.writeFileString(
      stateFile,
      JSON.stringify(
        {
          lastOpenedPath: filePath,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  });

const readLastOpened = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { stateFile } = yield* getJournalPaths;
    const content = yield* fs.readFileString(stateFile).pipe(
      Effect.catchAll((error) =>
        isNotFoundError(error) ? Effect.succeed("") : Effect.fail(error)
      )
    );
    if (!content) {
      return "";
    }
    let parsed: { lastOpenedPath?: string } | null = null;
    try {
      parsed = JSON.parse(content) as { lastOpenedPath?: string };
    } catch {
      return "";
    }
    const candidate = parsed?.lastOpenedPath;
    if (!candidate) {
      return "";
    }
    const exists = yield* fs.stat(candidate).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false))
    );
    return exists ? candidate : "";
  });

const openInEditor = (filePath: string, line?: string | number) =>
  Effect.gen(function* () {
    yield* recordLastOpened(filePath);
    const args = ["--cmd", "let g:journal_mode=1"];
    if (line !== undefined) {
      args.push(`+${line}`);
    }
    args.push("+ZenMode", filePath);
    yield* runCommandInherit("nvim", args);
  });

export const openEntry = (date: string) =>
  Effect.gen(function* () {
    const paths = yield* getJournalPaths;
    const filePath = entryPathForDate(paths, date);
    yield* ensureFileExists(filePath, date);
    yield* openInEditor(filePath);
  });

export const openNote = (slug: string) =>
  Effect.gen(function* () {
    const paths = yield* getJournalPaths;
    const filePath = notePathForSlug(paths, slug);
    yield* ensureFileExists(filePath, slug);
    yield* openInEditor(filePath);
  });

const readSecondLine = (content: string) => {
  const lines = content.split(/\r?\n/);
  return lines[1] ?? "";
};

export const fileHasTag = (filePath: string, want: string) =>
  Effect.gen(function* () {
    const normalizedWant = normalizeTag(want);
    if (!normalizedWant) {
      return false;
    }

    const content = yield* readFile(filePath);
    const line = readSecondLine(content);

    const hashtags = line.match(/#[A-Za-z0-9_-]+/g) ?? [];
    for (const tag of hashtags) {
      if (normalizeTag(tag.slice(1)) === normalizedWant) {
        return true;
      }
    }

    if (/^\s*tags\s*:/i.test(line)) {
      const stripped = line.replace(/^\s*tags\s*:\s*/i, "");
      const cleaned = stripped.replace(/[\[\],]/g, " ");
      const parts = cleaned.split(/\s+/).filter(Boolean);
      for (const part of parts) {
        if (normalizeTag(part) === normalizedWant) {
          return true;
        }
      }
    }

    return false;
  });

const walkMarkdownFiles = (rootDir: string, excludeDir: string[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const results: string[] = [];

    const walk = (dir: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const entries = yield* fs.readDirectory(dir);
        for (const entry of entries) {
          const name =
            typeof entry === "string"
              ? entry
              : (entry as { name?: string }).name ?? "";
          if (!name) {
            continue;
          }
          const fullPath = path.join(dir, name);
          const info = yield* fs.stat(fullPath);
          if (isDirectoryInfo(info)) {
            if (excludeDir.includes(name)) {
              continue;
            }
            yield* walk(fullPath);
          } else if (isFileInfo(info) && name.endsWith(".md")) {
            results.push(fullPath);
          }
        }
      });

    yield* walk(rootDir);

    return results;
  }).pipe(
    Effect.catchAll((error) =>
      isNotFoundError(error) ? Effect.succeed([]) : Effect.fail(error)
    )
  );

export const listEntryFiles = (tag?: string) =>
  Effect.gen(function* () {
    const { journalDir } = yield* getJournalPaths;
    const entries = yield* walkMarkdownFiles(journalDir, ["notes"]);
    const sorted = entries.sort().reverse();

    if (!tag) {
      return sorted;
    }

    const filtered: string[] = [];
    for (const filePath of sorted) {
      const hasTag = yield* fileHasTag(filePath, tag);
      if (hasTag) {
        filtered.push(filePath);
      }
    }

    return filtered;
  });

export const listTags = () =>
  Effect.gen(function* () {
    const files = yield* listEntryFiles();
    const tagSet = new Set<string>();

    for (const filePath of files) {
      const content = yield* readFile(filePath);
      const line = readSecondLine(content);

      const hashtags = line.match(/#[A-Za-z0-9_-]+/g) ?? [];
      for (const tag of hashtags) {
        const normalized = normalizeTag(tag.slice(1));
        if (normalized) {
          tagSet.add(normalized);
        }
      }

      if (/^\s*tags\s*:/i.test(line)) {
        const stripped = line.replace(/^\s*tags\s*:\s*/i, "");
        const cleaned = stripped.replace(/[\[\],]/g, " ");
        const parts = cleaned.split(/\s+/).filter(Boolean);
        for (const part of parts) {
          const normalized = normalizeTag(part);
          if (normalized) {
            tagSet.add(normalized);
          }
        }
      }
    }

    return Array.from(tagSet).sort();
  });

export const listNoteSlugs = () =>
  Effect.gen(function* () {
    const { notesDir, path } = yield* getJournalPaths;
    const files = yield* walkMarkdownFiles(notesDir, []);
    return files
      .map((filePath) => path.basename(filePath, ".md"))
      .sort();
  });

const getPreviewLine = (content: string) => {
  const lines = content.split(/\r?\n/).slice(0, 12);
  for (const line of lines) {
    if (/^\s*#/.test(line)) {
      continue;
    }
    if (/^\s*tags\s*:/i.test(line)) {
      continue;
    }
    if (!line.trim()) {
      continue;
    }
    return line.slice(0, 80);
  }
  return "";
};

export const getEntries = (tag?: string) =>
  Effect.gen(function* () {
    const { path } = yield* getJournalPaths;
    const files = yield* listEntryFiles(tag);
    return files.map((filePath) => ({
      date: path.basename(filePath, ".md"),
      path: filePath,
    }));
  });

export const getTimelineEntries = (tag?: string) =>
  Effect.gen(function* () {
    const { path } = yield* getJournalPaths;
    const files = yield* listEntryFiles(tag);
    const entries: { date: string; path: string; preview: string }[] = [];

    for (const filePath of files) {
      const datePart = path.basename(filePath, ".md");
      const content = yield* readFile(filePath);
      const previewLine = getPreviewLine(content) || "(empty)";
      entries.push({ date: datePart, path: filePath, preview: previewLine });
    }

    return entries;
  });

export const getNotes = () =>
  Effect.gen(function* () {
    const { notesDir, path } = yield* getJournalPaths;
    const files = yield* walkMarkdownFiles(notesDir, []);
    return files
      .map((filePath) => ({
        slug: path.basename(filePath, ".md"),
        path: filePath,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  });

export const getSearchMatches = () =>
  Effect.gen(function* () {
    const { journalDir } = yield* getJournalPaths;
    const result = yield* runCommand("rg", ["--json", "--smart-case", "", journalDir]);
    if (!result.stdout) {
      return [];
    }

    const matches: { path: string; line: number; text: string }[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as {
          type?: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };
        if (event.type !== "match" || !event.data) {
          continue;
        }
        const filePath = event.data.path?.text ?? "";
        const lineNumber = event.data.line_number ?? 0;
        const text = (event.data.lines?.text ?? "").replace(/\n$/, "");
        if (filePath && lineNumber > 0) {
          matches.push({ path: filePath, line: lineNumber, text });
        }
      } catch {
        continue;
      }
    }

    return matches;
  });

const fzfSelect = (lines: string[], options: {
  prompt?: string;
  preview?: string;
  previewWindow?: string;
  ansi?: boolean;
  noSort?: boolean;
  noMulti?: boolean;
  delimiter?: string;
}) =>
  Effect.gen(function* () {
    if (lines.length === 0) {
      return "";
    }

    const args: string[] = [];
    if (options.ansi) args.push("--ansi");
    if (options.noSort) args.push("--no-sort");
    if (options.noMulti) args.push("--no-multi");
    if (options.delimiter) args.push("--delimiter", options.delimiter);
    if (options.preview) args.push("--preview", options.preview);
    if (options.previewWindow)
      args.push("--preview-window", options.previewWindow);
    if (options.prompt) args.push("--prompt", options.prompt);

    const result = yield* runCommand("fzf", args, { stdin: `${lines.join("\n")}\n` });
    if (result.exitCode !== 0) {
      return "";
    }

    return result.stdout.trim();
  });

export const searchByDate = (tag?: string) =>
  Effect.gen(function* () {
    const { journalDir, path } = yield* getJournalPaths;
    const files = yield* listEntryFiles(tag);
    const relative = files.map((filePath) => path.relative(journalDir, filePath));
    const selection = yield* fzfSelect(relative, {
      preview: `cat ${journalDir}/{}`,
      previewWindow: "right:60%:wrap",
      prompt: `Select date${tag ? ` (tag: ${tag})` : ""}: `,
    });

    if (!selection) {
      return;
    }

    yield* openInEditor(path.join(journalDir, selection));
  });

export const searchByContent = () =>
  Effect.gen(function* () {
    const { journalDir } = yield* getJournalPaths;
    const result = yield* runCommand("rg", [
      "--line-number",
      "--color=always",
      "--smart-case",
      "",
      journalDir,
    ]);

    if (!result.stdout) {
      return;
    }

    const selection = yield* fzfSelect(result.stdout.split(/\n/).filter(Boolean), {
      ansi: true,
      delimiter: ":",
      preview:
        "bat --color=always --highlight-line {2} {1} 2>/dev/null || cat {1}",
      previewWindow: "right:60%:wrap:+{2}-10",
      prompt: "Search content: ",
    });

    if (!selection) {
      return;
    }

    const [file, line] = selection.split(":");
    if (!file || !line) {
      return;
    }

    yield* openInEditor(file, line);
  });

export const timelineView = (tag?: string) =>
  Effect.gen(function* () {
    const { journalDir, path } = yield* getJournalPaths;
    const files = yield* listEntryFiles(tag);
    const lines: string[] = [];

    for (const filePath of files) {
      const datePart = path.basename(filePath, ".md");
      const content = yield* readFile(filePath);
      const previewLine = getPreviewLine(content) || "(empty)";
      lines.push(`${datePart}  \x1b[90m${previewLine}\x1b[0m`);
    }

    const selection = yield* fzfSelect(lines, {
      ansi: true,
      noSort: true,
      preview: `cat ${journalDir}/{1}.md`,
      previewWindow: "right:65%:wrap",
      prompt: `Timeline${tag ? ` (tag: ${tag})` : ""}: `,
    });

    if (!selection) {
      return;
    }

    const dateSelected = selection.split(/\s+/)[0];
    if (!dateSelected) {
      return;
    }

    yield* openInEditor(path.join(journalDir, `${dateSelected}.md`));
  });

export const tagBrowse = (tag?: string) =>
  Effect.gen(function* () {
    let selectedTag = tag ?? "";
    if (!selectedTag) {
      const tags = yield* listTags();
      selectedTag = yield* fzfSelect(tags, { prompt: "Select tag: ", noMulti: true });
    }

    if (!selectedTag) {
      return;
    }

    yield* searchByDate(selectedTag);
  });

export const noteBrowse = (slug?: string) =>
  Effect.gen(function* () {
    const { notesDir } = yield* getJournalPaths;
    let selected = slug ?? "";
    if (!selected) {
      const notes = yield* listNoteSlugs();
      selected = yield* fzfSelect(notes, {
        prompt: "Select note: ",
        preview: `cat ${notesDir}/{}.md`,
        previewWindow: "right:60%:wrap",
        noMulti: true,
      });
    }

    if (!selected) {
      return;
    }

    yield* openNote(selected);
  });

export const getMostRecentPath = () =>
  Effect.gen(function* () {
    const { journalDir } = yield* getJournalPaths;
    const lastOpened = yield* readLastOpened();
    if (lastOpened) {
      return lastOpened;
    }

    const files = yield* walkMarkdownFiles(journalDir, []);
    if (files.length === 0) {
      return "";
    }

    let bestFile = files[0];
    let bestMtime = 0;
    for (const filePath of files) {
      const stats = yield* statFile(filePath);
      const mtime = getModifiedTimeMs(stats);
      if (mtime >= bestMtime) {
        bestMtime = mtime;
        bestFile = filePath;
      }
    }

    return bestFile;
  });

export const openMostRecent = () =>
  Effect.gen(function* () {
    const bestFile = yield* getMostRecentPath();
    if (!bestFile) {
      return yield* Effect.fail(new Error("No entries found."));
    }
    yield* openInEditor(bestFile);
  });

const isDateSlug = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const stripMarkdownExtension = (value: string) =>
  value.toLowerCase().endsWith(".md") ? value.slice(0, -3) : value;

const normalizeNoteSlug = (paths: JournalPaths, value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutExt = stripMarkdownExtension(trimmed);
  if (paths.path.isAbsolute(withoutExt)) {
    const relative = paths.path.relative(paths.notesDir, withoutExt);
    if (!relative.startsWith("..")) {
      return relative;
    }
  }
  if (
    withoutExt.startsWith(`notes${paths.path.sep}`) ||
    withoutExt.startsWith("notes/")
  ) {
    return withoutExt.replace(/^notes[\\/]/, "");
  }
  return withoutExt;
};

const resolveSource = (paths: JournalPaths, source: string) => {
  const trimmed = source.trim();
  if (!trimmed) {
    return { kind: "unknown" as const, id: "" };
  }

  const withoutExt = stripMarkdownExtension(trimmed);
  if (paths.path.isAbsolute(withoutExt)) {
    const relativeToNotes = paths.path.relative(paths.notesDir, withoutExt);
    if (!relativeToNotes.startsWith("..")) {
      return { kind: "note" as const, id: relativeToNotes };
    }
    const relativeToJournal = paths.path.relative(paths.journalDir, withoutExt);
    if (!relativeToJournal.startsWith("..")) {
      const base = paths.path.basename(withoutExt);
      if (isDateSlug(base)) {
        return { kind: "entry" as const, id: base };
      }
    }
  }

  if (
    withoutExt.startsWith(`notes${paths.path.sep}`) ||
    withoutExt.startsWith("notes/")
  ) {
    return { kind: "note" as const, id: withoutExt.replace(/^notes[\\/]/, "") };
  }
  if (isDateSlug(withoutExt)) {
    return { kind: "entry" as const, id: withoutExt };
  }
  return { kind: "note" as const, id: withoutExt };
};

const appendWithSpacing = (existing: string, addition: string) => {
  if (!existing) {
    return `${addition}${addition.endsWith("\n") ? "" : "\n"}`;
  }
  const separator = existing.endsWith("\n\n")
    ? ""
    : existing.endsWith("\n")
      ? "\n"
      : "\n\n";
  return `${existing}${separator}${addition}${addition.endsWith("\n") ? "" : "\n"}`;
};

const isBlankLine = (line: string) => line.trim() === "";

const isSeparatorLine = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  const collapsed = trimmed.replace(/\s+/g, "");
  if (collapsed.length < 3) {
    return false;
  }
  const char = collapsed[0];
  if (!["-", "*", "_"].includes(char)) {
    return false;
  }
  for (const value of collapsed) {
    if (value !== char) {
      return false;
    }
  }
  return true;
};

type Section = {
  index: number;
  startLine: number;
  endLine: number;
  blockEndLine: number;
  title: string;
  preview: string;
};

const collectSections = (content: string): Section[] => {
  const lines = content.split(/\r?\n/);
  const sections: Omit<Section, "index">[] = [];
  let startLine: number | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNumber = i + 1;
    if (isSeparatorLine(line)) {
      if (startLine !== null) {
        let endLine = lineNumber - 1;
        while (endLine >= startLine && isBlankLine(lines[endLine - 1] ?? "")) {
          endLine -= 1;
        }
        if (endLine >= startLine) {
          sections.push({ startLine, endLine, title: "", preview: "" });
        }
        startLine = null;
      }
      continue;
    }

    if (startLine === null && !isBlankLine(line)) {
      startLine = lineNumber;
    }
  }

  if (startLine !== null) {
    let endLine = lines.length;
    while (endLine >= startLine && isBlankLine(lines[endLine - 1] ?? "")) {
      endLine -= 1;
    }
    if (endLine >= startLine) {
      sections.push({ startLine, endLine, title: "", preview: "" });
    }
  }

  return sections.map((section, idx) => {
    let title = "(empty section)";
    for (let lineIndex = section.startLine; lineIndex <= section.endLine; lineIndex += 1) {
      const text = (lines[lineIndex - 1] ?? "").trim();
      if (text) {
        title = text;
        break;
      }
    }
    let blockEndLine = section.endLine;
    let scanLine = section.endLine + 1;
    while (scanLine <= lines.length && isBlankLine(lines[scanLine - 1] ?? "")) {
      scanLine += 1;
    }
    if (scanLine <= lines.length && isSeparatorLine(lines[scanLine - 1] ?? "")) {
      blockEndLine = scanLine;
    }
    const preview = lines.slice(section.startLine - 1, blockEndLine).join("\n");
    return {
      index: idx + 1,
      startLine: section.startLine,
      endLine: section.endLine,
      blockEndLine,
      title,
      preview,
    } satisfies Section;
  });
};

const parseSectionList = (input: string) =>
  input
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

const resolveSourcePath = (paths: JournalPaths, source: string) => {
  const sourceInfo = resolveSource(paths, source);
  if (sourceInfo.kind === "unknown") {
    return null;
  }
  const sourcePath =
    sourceInfo.kind === "entry"
      ? entryPathForDate(paths, sourceInfo.id)
      : notePathForSlug(paths, sourceInfo.id);
  return { sourcePath, sourceInfo };
};

export const listSections = (source: string) =>
  Effect.gen(function* () {
    const paths = yield* getJournalPaths;
    const resolved = resolveSourcePath(paths, source);
    if (!resolved) {
      return yield* Effect.fail(new Error("Missing source note."));
    }
    const content = yield* readFile(resolved.sourcePath).pipe(
      Effect.catchAll((error) =>
        isNotFoundError(error)
          ? Effect.fail(new Error(`Source note not found: ${resolved.sourcePath}`))
          : Effect.fail(error)
      )
    );
    return collectSections(content);
  });

export const extractSectionsToNote = (options: {
  source: string;
  sections: number[] | string;
  slug: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* getJournalPaths;
    const resolved = resolveSourcePath(paths, options.source);
    if (!resolved) {
      return yield* Effect.fail(new Error("Missing source note."));
    }

    const targetSlug = normalizeNoteSlug(paths, options.slug);
    if (!targetSlug) {
      return yield* Effect.fail(new Error("Missing target note slug."));
    }

    const sourceContent = yield* readFile(resolved.sourcePath).pipe(
      Effect.catchAll((error) =>
        isNotFoundError(error)
          ? Effect.fail(new Error(`Source note not found: ${resolved.sourcePath}`))
          : Effect.fail(error)
      )
    );

    const sections = collectSections(sourceContent);
    const requested =
      typeof options.sections === "string"
        ? parseSectionList(options.sections)
        : options.sections;
    const unique = Array.from(new Set(requested)).sort((a, b) => a - b);
    if (unique.length === 0) {
      return yield* Effect.fail(new Error("No sections selected."));
    }

    const selectedSections = unique.map((index) => sections[index - 1]).filter(Boolean);
    if (selectedSections.length === 0) {
      return yield* Effect.fail(new Error("No matching sections found."));
    }

    const lines = sourceContent.split(/\r?\n/);
    const extractedChunks: string[] = [];
    const linkTarget = `notes/${targetSlug}.md`;
    const sourceLabel =
      resolved.sourceInfo.kind === "entry"
        ? resolved.sourceInfo.id
        : paths.path.basename(resolved.sourcePath, ".md");
    const sourceLinkTarget = paths.path
      .relative(paths.notesDir, resolved.sourcePath)
      .replace(/\\/g, "/");
    const sourceLinkLine = sourceLinkTarget
      ? `Source: [${sourceLabel}](${sourceLinkTarget})`
      : "";

    const replacements = selectedSections
      .map((section) => {
        const startLine = section.startLine;
        const endLine = section.blockEndLine ?? section.endLine;
        const block = lines.slice(startLine - 1, endLine).join("\n");
        extractedChunks.push(block);
        const indent = (lines[startLine - 1] ?? "").match(/^\s*/)?.[0] ?? "";
        const linkLine = `${indent}[${targetSlug}](${linkTarget})`;
        return { startLine, endLine, linkLine };
      })
      .sort((a, b) => b.startLine - a.startLine);

    for (const replacement of replacements) {
      lines.splice(
        replacement.startLine - 1,
        replacement.endLine - replacement.startLine + 1,
        replacement.linkLine
      );
    }

    yield* fs.writeFileString(resolved.sourcePath, lines.join("\n"));

    const extractedText = extractedChunks.filter((chunk) => chunk.trim()).join("\n\n");
    if (extractedText.trim()) {
      const mergedText = sourceLinkLine
        ? `${sourceLinkLine}\n\n${extractedText}`
        : extractedText;
      const targetPath = notePathForSlug(paths, targetSlug);
      yield* ensureFileExists(targetPath, targetSlug);
      const targetContent = yield* readFile(targetPath);
      const updatedTarget = appendWithSpacing(targetContent, mergedText);
      yield* fs.writeFileString(targetPath, updatedTarget);
    }
  });

export const extractToNote = (options: {
  source: string;
  startLine: number;
  endLine: number;
  slug: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const paths = yield* getJournalPaths;
    const resolved = resolveSourcePath(paths, options.source);
    if (!resolved) {
      return yield* Effect.fail(new Error("Missing source note."));
    }

    const targetSlug = normalizeNoteSlug(paths, options.slug);
    if (!targetSlug) {
      return yield* Effect.fail(new Error("Missing target note slug."));
    }

    const sourcePath = resolved.sourcePath;
    const targetPath = notePathForSlug(paths, targetSlug);

    const sourceContentResult = yield* readFile(sourcePath).pipe(
      Effect.catchAll((error) =>
        isNotFoundError(error)
          ? Effect.fail(new Error(`Source note not found: ${sourcePath}`))
          : Effect.fail(error)
      )
    );

    const lines = sourceContentResult.split(/\r?\n/);
    const start = options.startLine;
    const end = options.endLine;

    if (start < 1 || end < start || end > lines.length) {
      return yield* Effect.fail(
        new Error(
          `Invalid line range ${start}-${end} for ${lines.length} lines.`
        )
      );
    }

    const extractedLines = lines.slice(start - 1, end);
    const extractedText = extractedLines.join("\n");
    const indent = extractedLines[0]?.match(/^\s*/)?.[0] ?? "";
    const linkLine = `${indent}[${targetSlug}](notes/${targetSlug}.md)`;
    lines.splice(start - 1, end - start + 1, linkLine);
    yield* fs.writeFileString(sourcePath, lines.join("\n"));

    if (extractedText.trim()) {
      const sourceLabel =
        resolved.sourceInfo.kind === "entry"
          ? resolved.sourceInfo.id
          : paths.path.basename(sourcePath, ".md");
      const sourceLinkTarget = paths.path
        .relative(paths.notesDir, sourcePath)
        .replace(/\\/g, "/");
      const sourceLinkLine = sourceLinkTarget
        ? `Source: [${sourceLabel}](${sourceLinkTarget})`
        : "";
      const mergedText = sourceLinkLine
        ? `${sourceLinkLine}\n\n${extractedText}`
        : extractedText;
      yield* ensureFileExists(targetPath, targetSlug);
      const targetContent = yield* readFile(targetPath);
      const updatedTarget = appendWithSpacing(targetContent, mergedText);
      yield* fs.writeFileString(targetPath, updatedTarget);
    }
  });
