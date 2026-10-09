#!/usr/bin/env node
// yaffle CLI: check, build, ir, fmt. The logic lives in cli.ts.
import { defaultIo, runCli } from "./cli.ts";

process.exitCode = runCli(process.argv.slice(2), defaultIo());
