import { FileSystem, Path } from "@effect/platform";
import { CommandDescriptor, Options, HelpDoc } from "@effect/cli";
import type { CliConfig } from "@effect/cli/CliConfig";
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

const jsonArg = Options.boolean("json").pipe(
  Options.optional,
  Options.withDescription("Output JSON results (no fzf/nvim)")
);
const dateArg = Options.boolean("date", { aliases: ["d"] }).pipe(
  Options.optional,
  Options.withDescription("Select entry by date (fzf + fd)")
);
const searchArg = Options.boolean("search", { aliases: ["s"] }).pipe(
  Options.optional,
  Options.withDescription("Search entries by content (fzf + rg) [full scan]")
);
const timelineArg = Options.boolean("timeline", { aliases: ["l"] }).pipe(
  Options.optional,
  Options.withDescription("Browse entries chronologically with preview")
);
const continueArg = Options.boolean("continue", { aliases: ["c"] }).pipe(
  Options.optional,
  Options.withDescription("Open most recently opened entry (daily or note)")
);
const tagArg = Options.text("tag").pipe(
  Options.optional,
  Options.withDescription("Browse entries that contain TAG on line 2")
);
const noteArg = Options.text("note").pipe(
  Options.optional,
  Options.withDescription("Open note (if SLUG omitted, pick from list)")
);
const extractArg = Options.text("extract").pipe(
  Options.optional,
  Options.withDescription("Source file for extraction")
);
const sectionsArg = Options.text("sections").pipe(
  Options.optional,
  Options.withDescription("Sections to extract or source for listing")
);
const slugArg = Options.text("slug").pipe(
  Options.optional,
  Options.withDescription("Target slug for extracted note")
);

type ParsedOptions = {
  json: boolean | undefined;
  date: boolean | undefined;
  search: boolean | undefined;
  timeline: boolean | undefined;
  continue: boolean | undefined;
  tag: string | undefined;
  note: string | undefined;
  extract: string | undefined;
  sections: string | undefined;
  slug: string | undefined;
};

const parseArgs = (args: string[]): Effect.Effect<ParsedOptions | null> =>
  Effect.gen(function* () {
    const optionsDef = Options.all({
      json: jsonArg,
      date: dateArg,
      search: searchArg,
      timeline: timelineArg,
      continue: continueArg,
      tag: tagArg,
      note: noteArg,
      extract: extractArg,
      sections: sectionsArg,
      slug: slugArg,
    });

    const command = CommandDescriptor.make("j", optionsDef);

    const cliConfig: CliConfig = {
      isCaseSensitive: false,
      autoCorrectLimit: 2,
      finalCheckBuiltIn: false,
      showAllNames: true,
      showBuiltIns: false,
      showTypes: false,
    };

    const parseResult = yield* CommandDescriptor.parse(["j", ...args], cliConfig)(command).pipe(
      Effect.catchAll((error) => {
        return Effect.fail(error);
      })
    );

    if (parseResult._tag === "BuiltIn") {
      if (parseResult.option._tag === "ShowHelp") {
        const helpDoc = CommandDescriptor.getHelp(command, cliConfig);
        const helpText = HelpDoc.toAnsiText(helpDoc);
        yield* Effect.sync(() => console.log(helpText));
        return null;
      }
      return null;
    }

    const { options: parsed } = parseResult.value;

    const getOpt = <A>(opt: any): A | undefined => {
      if (opt && opt._tag === "Some") {
        return opt.value;
      }
      return undefined;
    };

    return {
      json: getOpt(parsed.json),
      date: getOpt(parsed.date),
      search: getOpt(parsed.search),
      timeline: getOpt(parsed.timeline),
      continue: getOpt(parsed.continue),
      tag: getOpt(parsed.tag),
      note: getOpt(parsed.note),
      extract: getOpt(parsed.extract),
      sections: getOpt(parsed.sections),
      slug: getOpt(parsed.slug),
    };
  });

export const main = Effect.gen(function* () {
  const rawArgs = process.argv.slice(2);

  let offset: number | undefined;
  const filteredArgs: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (/^-\d+$/.test(arg)) {
      offset = Number(arg.slice(1));
    } else if (arg.startsWith("--offset=")) {
      offset = Number(arg.slice("--offset=".length));
    } else {
      filteredArgs.push(arg);
    }
  }

  const parsed = yield* parseArgs(filteredArgs);
  if (!parsed) {
    return;
  }

  const fs = yield* FileSystem.FileSystem;
  const paths = yield* getJournalPaths;
  const { journalDir } = paths;
  yield* fs.makeDirectory(journalDir, { recursive: true });

  const mode = parsed.date
    ? "date"
    : parsed.search
      ? "search"
      : parsed.timeline
        ? "timeline"
        : parsed.continue
          ? "continue"
          : parsed.extract
            ? "extract"
            : parsed.sections
              ? "sections"
              : parsed.tag
                ? "tag"
                : parsed.note
                  ? "note"
                  : "today";

  if (parsed.json) {
    switch (mode) {
      case "today": {
        const date = offset !== undefined ? dateDaysAgo(offset) : formatDate(new Date());
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
        if (parsed.note) {
          const path = paths.path.join(paths.notesDir, `${parsed.note}.md`);
          yield* outputJson({ slug: parsed.note, path });
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
        if (!parsed.extract || !parsed.slug) {
          return;
        }
        const extractSections = parsed.sections ? parseSectionListArg(parsed.sections) : undefined;
        if (extractSections && extractSections.length > 0) {
          yield* extractSectionsToNote({
            source: parsed.extract,
            sections: extractSections,
            slug: parsed.slug,
          });
        } else {
          return yield* Effect.fail(new Error("Missing extract sections."));
        }
        yield* outputJson({
          status: "ok",
          source: parsed.extract,
          sections: extractSections,
          slug: parsed.slug,
        });
        break;
      }
      case "sections": {
        if (!parsed.sections) {
          return;
        }
        const sections = yield* listSections(parsed.sections);
        yield* outputJson({ source: parsed.sections, sections });
        break;
      }
    }
    return;
  }

  switch (mode) {
    case "today":
      if (offset !== undefined) {
        yield* openEntry(dateDaysAgo(offset));
      } else {
        yield* openEntry(formatDate(new Date()));
      }
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
      yield* noteBrowse(parsed.note);
      break;
    case "continue":
      yield* openMostRecent();
      break;
    case "extract": {
      if (!parsed.extract || !parsed.slug) {
        return;
      }
      const extractSections = parsed.sections ? parseSectionListArg(parsed.sections) : undefined;
      if (extractSections && extractSections.length > 0) {
        yield* extractSectionsToNote({
          source: parsed.extract,
          sections: extractSections,
          slug: parsed.slug,
        });
      } else {
        return yield* Effect.fail(new Error("Missing extract sections."));
      }
      break;
    }
    case "sections": {
      if (!parsed.sections) {
        return;
      }
      const sections = yield* listSections(parsed.sections);
      for (const section of sections) {
        console.log(
          `${section.index}\t${section.startLine}-${section.endLine}\t${section.title}`
        );
      }
      break;
    }
  }
});
