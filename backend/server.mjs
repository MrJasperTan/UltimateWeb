#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startBuilderServer } from "../shared/builder-server.mjs";

const appDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(appDir, "..");

startBuilderServer({
  appDir,
  publicDir: join(rootDir, "frontend"),
});
