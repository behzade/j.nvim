import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import {
  dateDaysAgo,
  getJournalPaths,
  getEntries,
  getMostRecentPath,
  getNotes,
  getSearchMatches,
  getTimelineEntries,
  listSections,
  listTags,
  noteBrowse,
  openEntry,
  extractToNote,
  extractSectionsToNote,
  openMostRecent,
  searchByContent,
  searchByDate,
  tagBrowse,
  timelineView,
} from "./actions";

const usageText = `Usage: j [options] | j -N

  (no args)          Open today's journal entry
  -N                 Open entry for N days ago (e.g. -1 = yesterday, -7 = 7 days ago)

Browse/search:
  -d, --date         Select entry by date (fzf + fd)
  -s, --search       Search entries by content (fzf + rg)  [full scan]

Timeline:
  -l, --timeline     Browse entries chronologically with preview
                     Combine with tag filter: j -l -t=ai

Tags (line 2 only, not full document):
  -t, --tag TAG      Browse entries that contain TAG on line 2
  -t, --tag          Pick a tag from a list, then browse entries
  -t=TAG, --tag=TAG  Same (example: j -t=ai)

  -h, --help         Show this help
  --json             Output JSON results (no fzf/nvim)

Tag conventions supported (line 2 only):
  - tags: ai, work
  - tags: [ai, work]
  - hashtags: #ai #work

Notes:
  -n, --note [SLUG]  Open note (if SLUG omitted, pick from list)
  -n=SLUG, --note=SLUG
  -c, --continue     Open most recently opened entry (daily or note)
  -x, --extract SRC --sections=LIST --slug SLUG
                     Extract sections (comma-separated indices) to note
  --sections SRC     List sections in SRC
`;

type Mode =
  | "today"
  | "offset"
  | "date"
  | "search"
  | "timeline"
  | "tag"
  | "note"
  | "continue"
  | "extract"
  | "sections";

type ParsedArgs = {
  mode: Mode;
  tag?: string;
  daysAgo?: number;
  noteSlug?: string;
  extractSource?: string;
  extractStart?: number;
  extractEnd?: number;
  extractSections?: number[];
  extractSlug?: string;
  sectionsSource?: string;
  json?: boolean;
};

const formatDate = (date: Date) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

const outputJson = (value: unknown) =>
  Effect.sync(() => console.log(JSON.stringify(value, null, 2)));

const parseSectionListArg = (value: string) =>
  value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry > 0);

const parseArgs = (args: string[]): Effect.Effect<ParsedArgs | null> =>
  Effect.gen(function* () {
    let json = false;
    const filteredArgs = args.filter((arg) => {
      if (arg === "--json") {
        json = true;
        return false;
      }
      return true;
    });

    if (filteredArgs.length === 1 && /^-\d+$/.test(filteredArgs[0])) {
      return {
        mode: "offset",
        daysAgo: Number(filteredArgs[0].slice(1)),
        json,
      } satisfies ParsedArgs;
    }

    let mode: Mode = "today";
    let tag: string | undefined;
    let daysAgo: number | undefined;
    let noteSlug: string | undefined;
    let extractSource: string | undefined;
    let extractStart: number | undefined;
    let extractEnd: number | undefined;
    let extractSections: number[] | undefined;
    let extractSlug: string | undefined;
    let sectionsSource: string | undefined;

    let index = 0;
    while (index < filteredArgs.length) {
      const arg = filteredArgs[index];

      switch (arg) {
        case "-h":
        case "--help":
          yield* Effect.sync(() => console.log(usageText));
          return null;
        case "-d":
        case "--date":
          mode = "date";
          index += 1;
          break;
        case "-s":
        case "--search":
          mode = "search";
          index += 1;
          break;
        case "-l":
        case "--timeline":
          mode = "timeline";
          index += 1;
          break;
        case "-t":
        case "--tag": {
          const next = args[index + 1];
          if (next && !next.startsWith("-")) {
            tag = next;
            index += 2;
          } else {
            tag = "";
            index += 1;
          }
          if (mode === "today") mode = "tag";
          break;
        }
        case "-n":
        case "--note": {
          mode = "note";
          const next = args[index + 1];
          if (next && !next.startsWith("-")) {
            noteSlug = next;
            index += 2;
          } else {
            index += 1;
          }
          break;
        }
        case "-c":
        case "--continue":
          mode = "continue";
          index += 1;
          break;
        case "-x":
        case "--extract": {
          const source = filteredArgs[index + 1];
          if (!source) {
            yield* Effect.sync(() =>
              console.error("Error: --extract requires a source file.")
            );
            yield* Effect.sync(() => console.log(usageText));
            return yield* Effect.fail(new Error("Missing --extract arguments"));
          }
          mode = "extract";
          extractSource = source;
          index += 2;
          break;
        }
        case "--sections": {
          const next = filteredArgs[index + 1];
          if (!next) {
            yield* Effect.sync(() =>
              console.error("Error: --sections requires a value.")
            );
            yield* Effect.sync(() => console.log(usageText));
            return yield* Effect.fail(new Error("Missing --sections value"));
          }
          if (mode === "extract") {
            extractSections = parseSectionListArg(next);
          } else {
            mode = "sections";
            sectionsSource = next;
          }
          index += 2;
          break;
        }
        case "--slug": {
          const next = filteredArgs[index + 1];
          if (!next) {
            yield* Effect.sync(() =>
              console.error("Error: --slug requires a value.")
            );
            yield* Effect.sync(() => console.log(usageText));
            return yield* Effect.fail(new Error("Missing --slug value"));
          }
          extractSlug = next;
          index += 2;
          break;
        }
        default: {
          if (arg.startsWith("--tag=")) {
            tag = arg.slice("--tag=".length);
            if (mode === "today") mode = "tag";
            index += 1;
            break;
          }
          if (arg.startsWith("--sections=")) {
            const value = arg.slice("--sections=".length);
            if (mode === "extract") {
              extractSections = parseSectionListArg(value);
            } else {
              mode = "sections";
              sectionsSource = value;
            }
            index += 1;
            break;
          }
          if (arg.startsWith("--slug=")) {
            extractSlug = arg.slice("--slug=".length);
            index += 1;
            break;
          }
          if (arg.startsWith("-t=")) {
            tag = arg.slice(3);
            if (mode === "today") mode = "tag";
            index += 1;
            break;
          }
          if (arg.startsWith("--note=")) {
            mode = "note";
            noteSlug = arg.slice("--note=".length);
            index += 1;
            break;
          }
          if (arg.startsWith("-n=")) {
            mode = "note";
            noteSlug = arg.slice(3);
            index += 1;
            break;
          }
          if (mode === "extract" && /^\d+$/.test(arg)) {
            const value = Number(arg);
            if (extractStart === undefined) {
              extractStart = value;
              index += 1;
              break;
            }
            if (extractEnd === undefined) {
              extractEnd = value;
              index += 1;
              break;
            }
          }
          if (mode === "extract" && !arg.startsWith("-") && !extractSlug) {
            extractSlug = arg;
            index += 1;
            break;
          }
          if (/^-\d+$/.test(arg)) {
            daysAgo = Number(arg.slice(1));
            mode = "offset";
            index += 1;
            break;
          }

          yield* Effect.sync(() => console.error(`Unknown option: ${arg}`));
          yield* Effect.sync(() => console.log(usageText));
          return yield* Effect.fail(new Error("Unknown option"));
        }
      }
    }

    return {
      mode,
      tag,
      daysAgo,
      noteSlug,
      extractSource,
      extractStart,
      extractEnd,
      extractSections,
      extractSlug,
      sectionsSource,
      json,
    } satisfies ParsedArgs;
  });

export const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const parsed = yield* parseArgs(args);
  if (!parsed) {
    return;
  }

  const fs = yield* FileSystem.FileSystem;
  const paths = yield* getJournalPaths;
  const { journalDir } = paths;
  yield* fs.makeDirectory(journalDir, { recursive: true });

  if (parsed.json) {
    switch (parsed.mode) {
      case "today": {
        const date = formatDate(new Date());
        const path = paths.path.join(paths.journalDir, `${date}.md`);
        yield* outputJson({ date, path });
        break;
      }
      case "offset": {
        if (parsed.daysAgo === undefined) {
          return;
        }
        const date = dateDaysAgo(parsed.daysAgo);
        const path = paths.path.join(paths.journalDir, `${date}.md`);
        yield* outputJson({ date, path });
        break;
      }
      case "date": {
        const entries = yield* getEntries(parsed.tag);
        yield* outputJson(parsed.tag ? { tag: parsed.tag, entries } : { entries });
        break;
      }
      case "search": {
        const matches = yield* getSearchMatches();
        yield* outputJson({ matches });
        break;
      }
      case "timeline": {
        const entries = yield* getTimelineEntries(parsed.tag);
        yield* outputJson(parsed.tag ? { tag: parsed.tag, entries } : { entries });
        break;
      }
      case "tag": {
        if (parsed.tag) {
          const entries = yield* getEntries(parsed.tag);
          yield* outputJson({ tag: parsed.tag, entries });
        } else {
          const tags = yield* listTags();
          yield* outputJson({ tags });
        }
        break;
      }
      case "note": {
        if (parsed.noteSlug) {
          const path = paths.path.join(paths.notesDir, `${parsed.noteSlug}.md`);
          yield* outputJson({ slug: parsed.noteSlug, path });
        } else {
          const notes = yield* getNotes();
          yield* outputJson({ notes });
        }
        break;
      }
      case "continue": {
        const path = yield* getMostRecentPath();
        if (!path) {
          return yield* Effect.fail(new Error("No entries found."));
        }
        yield* outputJson({ path });
        break;
      }
      case "extract": {
        if (!parsed.extractSource || !parsed.extractSlug) {
          return;
        }
        if (parsed.extractSections && parsed.extractSections.length > 0) {
          yield* extractSectionsToNote({
            source: parsed.extractSource,
            sections: parsed.extractSections,
            slug: parsed.extractSlug,
          });
        } else if (
          parsed.extractStart !== undefined &&
          parsed.extractEnd !== undefined
        ) {
          yield* extractToNote({
            source: parsed.extractSource,
            startLine: parsed.extractStart,
            endLine: parsed.extractEnd,
            slug: parsed.extractSlug,
          });
        } else {
          return yield* Effect.fail(new Error("Missing extract sections."));
        }
        yield* outputJson({
          status: "ok",
          source: parsed.extractSource,
          sections: parsed.extractSections,
          startLine: parsed.extractStart,
          endLine: parsed.extractEnd,
          slug: parsed.extractSlug,
        });
        break;
      }
      case "sections": {
        if (!parsed.sectionsSource) {
          return;
        }
        const sections = yield* listSections(parsed.sectionsSource);
        yield* outputJson({ source: parsed.sectionsSource, sections });
        break;
      }
      default:
        yield* Effect.fail(new Error(`Unknown mode: ${parsed.mode}`));
    }
    return;
  }

  switch (parsed.mode) {
    case "today":
      yield* openEntry(formatDate(new Date()));
      break;
    case "offset":
      if (parsed.daysAgo === undefined) {
        return;
      }
      yield* openEntry(dateDaysAgo(parsed.daysAgo));
      break;
    case "date":
      yield* searchByDate(parsed.tag);
      break;
    case "search":
      yield* searchByContent();
      break;
    case "timeline":
      yield* timelineView(parsed.tag);
      break;
    case "tag":
      yield* tagBrowse(parsed.tag);
      break;
    case "note":
      yield* noteBrowse(parsed.noteSlug);
      break;
    case "continue":
      yield* openMostRecent();
      break;
    case "extract":
      if (!parsed.extractSource || !parsed.extractSlug) {
        return;
      }
      if (parsed.extractSections && parsed.extractSections.length > 0) {
        yield* extractSectionsToNote({
          source: parsed.extractSource,
          sections: parsed.extractSections,
          slug: parsed.extractSlug,
        });
      } else if (
        parsed.extractStart !== undefined &&
        parsed.extractEnd !== undefined
      ) {
        yield* extractToNote({
          source: parsed.extractSource,
          startLine: parsed.extractStart,
          endLine: parsed.extractEnd,
          slug: parsed.extractSlug,
        });
      } else {
        return yield* Effect.fail(new Error("Missing extract sections."));
      }
      break;
    case "sections": {
      if (!parsed.sectionsSource) {
        return;
      }
      const sections = yield* listSections(parsed.sectionsSource);
      for (const section of sections) {
        console.log(
          `${section.index}\t${section.startLine}-${section.endLine}\t${section.title}`
        );
      }
      break;
    }
    default:
      yield* Effect.fail(new Error(`Unknown mode: ${parsed.mode}`));
  }
});
