#!/usr/bin/env bun
import { BunContext } from "@effect/platform-bun";
import { Effect } from "effect";
import { main } from "./main";

const program = main.pipe(
  Effect.provide(BunContext.layer),
  Effect.catchAll((error: unknown) =>
    Effect.sync(() => {
      if (error instanceof Error && error.message) {
        console.error(error.message);
      }
      process.exitCode = 1;
    })
  )
);

Effect.runPromise(program);
