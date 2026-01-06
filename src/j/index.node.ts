#!/usr/bin/env node
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { main } from "./main";

Effect.runPromise(main.pipe(Effect.provide(NodeContext.layer))).catch((error) => {
  if (error instanceof Error && error.message) {
    console.error(error.message);
  }
  process.exitCode = 1;
});
