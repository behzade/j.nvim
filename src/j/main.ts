import { FileSystem, Path } from "@effect/platform";
import { CommandDescriptor, Options, HelpDoc, Span } from "@effect/cli";
import type { CliConfig } from "@effect/cli/CliConfig";
import type * as ValidationError from "@effect/cli/ValidationError";
import type * as Terminal from "@effect/platform/Terminal";
import { Effect } from "effect";
import * as Option from "effect/Option";
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

const primitiveHelpText = new Set([
  "A true or false value.",
  "A user-defined piece of text.",
  "A user-defined piece of text that is confidential.",
  "A floating point number.",
  "An integer.",
  "A date without a time-zone in the ISO-8601 format, such as 2007-12-03T10:15:30.",
  "An existing file or directory.",
  "An existing file.",
  "An existing directory.",
  "A file or directory that must not exist.",
  "A file that must not exist.",
  "A directory that must not exist.",
  "A file or directory.",
  "A file.",
  "A directory.",
]);

const spanToText = (span: Span.Span): string => {
  switch (span._tag) {
    case "Text":
    case "URI":
      return span.value;
    case "Highlight":
    case "Strong":
    case "Weak":
      return spanToText(span.value);
    case "Sequence":
      return spanToText(span.left) + spanToText(span.right);
  }
};

const normalizeHelpText = (text: string) => text.replace(/\s+/g, " ").trim();

const isFillerParagraph = (paragraph: HelpDoc.Paragraph): boolean => {
  const text = normalizeHelpText(spanToText(paragraph.value));
  if (text.startsWith("This setting is optional.")) {
    return true;
  }
  if (text.startsWith("This option is optional")) {
    return true;
  }
  return primitiveHelpText.has(text);
};

const collectParagraphs = (doc: HelpDoc.HelpDoc): Array<HelpDoc.Paragraph> => {
  switch (doc._tag) {
    case "Paragraph":
      return [doc];
    case "Sequence":
      return [...collectParagraphs(doc.left), ...collectParagraphs(doc.right)];
    case "Enumeration":
      return doc.elements.flatMap(collectParagraphs);
    case "DescriptionList":
      return doc.definitions.flatMap(([, child]) => collectParagraphs(child));
    case "Header":
    case "Empty":
      return [];
  }
};

const compactBlocks = (docs: Array<HelpDoc.HelpDoc>): HelpDoc.HelpDoc => {
  const filtered = docs.filter((doc) => !HelpDoc.isEmpty(doc));
  return filtered.length > 0 ? HelpDoc.blocks(filtered) : HelpDoc.empty;
};

const compactHelpDoc = (doc: HelpDoc.HelpDoc): HelpDoc.HelpDoc => {
  switch (doc._tag) {
    case "Empty":
    case "Header":
      return doc;
    case "Paragraph":
      return isFillerParagraph(doc) ? HelpDoc.empty : doc;
    case "Sequence":
      return compactBlocks([compactHelpDoc(doc.left), compactHelpDoc(doc.right)]);
    case "DescriptionList": {
      const mapped = doc.definitions.map(([span, child]) => {
        const paragraphs = collectParagraphs(child);
        const hasNonFiller = paragraphs.some((paragraph) => !isFillerParagraph(paragraph));
        const cleaned = hasNonFiller ? compactHelpDoc(child) : child;
        return [span, cleaned] as [Span.Span, HelpDoc.HelpDoc];
      });
      const [first, ...rest] = mapped;
      if (!first) {
        return HelpDoc.empty;
      }
      return HelpDoc.descriptionList([first, ...rest]);
    }
    case "Enumeration": {
      const elements = doc.elements
        .map(compactHelpDoc)
        .filter((element) => !HelpDoc.isEmpty(element));
      if (elements.length === 0) {
        return HelpDoc.empty;
      }
      const [first, ...rest] = elements;
      if (!first) {
        return HelpDoc.empty;
      }
      return HelpDoc.enumeration([first, ...rest]);
    }
  }
};

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
  Options.withAlias("t"),
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

type ParsedOptionValues = {
  json: Option.Option<boolean>;
  date: Option.Option<boolean>;
  search: Option.Option<boolean>;
  timeline: Option.Option<boolean>;
  continue: Option.Option<boolean>;
  tag: Option.Option<string>;
  note: Option.Option<string>;
  extract: Option.Option<string>;
  sections: Option.Option<string>;
  slug: Option.Option<string>;
};

const isTagRequested = (args: string[]) =>
  args.some((arg) => arg === "-t" || arg === "--tag" || arg.startsWith("--tag="));

const parseArgs = (
  args: string[]
): Effect.Effect<
  (ParsedOptions & { tagRequested: boolean }) | null,
  ValidationError.ValidationError,
  FileSystem.FileSystem | Path.Path | Terminal.Terminal
> =>
  Effect.gen(function* () {
    const optionsDef: Options.Options<ParsedOptionValues> = Options.all({
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

    const parseResult = yield* CommandDescriptor.parse(["j", ...args], cliConfig)(command);

    if (parseResult._tag === "BuiltIn") {
      if (parseResult.option._tag === "ShowHelp") {
        const helpDoc = compactHelpDoc(CommandDescriptor.getHelp(command, cliConfig));
        const helpText = HelpDoc.toAnsiText(helpDoc);
        yield* Effect.sync(() => console.log(helpText));
        return null;
      }
      return null;
    }

    const { options: parsed } = parseResult.value;

    const getOpt = <A>(opt: Option.Option<A>): A | undefined =>
      Option.isSome(opt) ? opt.value : undefined;

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
      tagRequested: isTagRequested(args),
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
              : parsed.tagRequested
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
