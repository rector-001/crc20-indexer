#!/usr/bin/env node
// Entry point. Node prints an "ExperimentalWarning" the first time node:sqlite loads; the ledger relies on it on purpose
// (Node >= 22.5), so that one warning is dropped before anything is imported. Every other warning still prints.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  const msg = typeof w === "string" ? w : w?.message;
  if (/SQLite is an experimental feature/.test(msg ?? "")) return;
  return (emit as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;
const { run } = await import("./cli.js");
await run();
