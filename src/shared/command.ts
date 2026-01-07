import { Command } from "@effect/platform";
import * as Chunk from "effect/Chunk";
import { Effect } from "effect";
import * as Stream from "effect/Stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CommandInput = {
  stdin?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
};

const collectOutput = (stream: Stream.Stream<Uint8Array, unknown, unknown>) =>
  Effect.map(Stream.runCollect(Stream.decodeText(stream)), (chunks) =>
    Chunk.join(chunks, "")
  );

const buildCommand = (
  cmd: string,
  args: string[],
  input: CommandInput
) => {
  let command = Command.make(cmd, ...args);

  if (input.cwd) {
    command = Command.workingDirectory(command, input.cwd);
  }
  if (input.env && Object.keys(input.env).length > 0) {
    command = Command.env(command, input.env);
  }
  if (input.stdin !== undefined) {
    command = Command.feed(command, input.stdin);
  }

  return command;
};

const escapeShell = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export const commandExists = (name: string) =>
  Command.exitCode(Command.make("which", name)).pipe(
    Effect.map((exitCode) => Number(exitCode) === 0),
    Effect.catchAll(() => Effect.succeed(false))
  );

export const runCommand = (
  cmd: string,
  args: string[] = [],
  input: CommandInput = {}
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const command = buildCommand(cmd, args, input);
      const process = yield* Command.start(command);
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectOutput(process.stdout),
          collectOutput(process.stderr),
          process.exitCode,
        ],
        { concurrency: "unbounded" }
      );

      return {
        stdout,
        stderr,
        exitCode: Number(exitCode),
      } satisfies CommandResult;
    })
  );

export const runCommandInteractive = (
  cmd: string,
  args: string[] = [],
  input: Omit<CommandInput, "stdin"> = {}
) =>
  Effect.gen(function* () {
    let command = Command.make(cmd, ...args);

    if (input.cwd) {
      command = Command.workingDirectory(command, input.cwd);
    }
    if (input.env && Object.keys(input.env).length > 0) {
      command = Command.env(command, input.env);
    }
    command = Command.stdin(command, "inherit");
    command = Command.stdout(command, "inherit");
    command = Command.stderr(command, "inherit");
    const exitCode = yield* Command.exitCode(command);

    return Number(exitCode);
  });

export const runCommandWithInputFile = (
  cmd: string,
  args: string[],
  inputContent: string
) =>
  Effect.gen(function* () {
    const tmpDir = os.tmpdir();
    const inputPath = path.join(
      tmpDir,
      `j-input-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    yield* Effect.promise(() => fs.promises.writeFile(inputPath, inputContent, "utf8"));

    const escapedArgs = args.map(escapeShell).join(" ");
    const shellCmd = `${escapeShell(cmd)} ${escapedArgs} < ${escapeShell(inputPath)}`;

    try {
      yield* runCommandInteractive("sh", ["-c", shellCmd]);
    } finally {
      yield* Effect.promise(() => fs.promises.unlink(inputPath).catch(() => undefined));
    }
  });
