#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { runApiExtractor } from "./run-api-extractor-lib.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const local = process.argv.includes("--local");

process.exitCode = runApiExtractor({ local, rootDir });
