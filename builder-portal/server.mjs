#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startBuilderServer } from "../shared/builder-server.mjs";

const appDir = dirname(fileURLToPath(import.meta.url));

startBuilderServer({
  appDir,
  publicDir: join(appDir, "public"),
});
