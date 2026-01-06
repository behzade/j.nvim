import { Command } from "@effect/platform";
import * as Chunk from "effect/Chunk";
import { Effect } from "effect";
import * as Stream from "effect/Stream";

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

export const runCommandInherit = (
  cmd: string,
  args: string[] = [],
  input: CommandInput = {}
) =>
  Effect.gen(function* () {
    let command = buildCommand(cmd, args, input);
    command = Command.stdin(command, "inherit");
    command = Command.stdout(command, "inherit");
    command = Command.stderr(command, "inherit");
    const exitCode = yield* Command.exitCode(command);

    return Number(exitCode);
  });
