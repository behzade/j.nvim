#!/usr/bin/env bun
import { BunContext } from "@effect/platform-bun";
import { Effect } from "effect";
import { main } from "./main";

Effect.runPromise(main.pipe(Effect.provide(BunContext.layer))).catch((error) => {
  if (error instanceof Error && error.message) {
    console.error(error.message);
  }
  process.exitCode = 1;
});
