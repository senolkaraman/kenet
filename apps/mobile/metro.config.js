// Standalone Metro config. `apps/mobile` is self-contained (no workspace imports) so it
// builds on its own — but when checked out inside the Kenet monorepo we still let Metro
// see the repo root so a hoisted dependency resolves during local dev.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");
const fs = require("fs");

const projectRoot = __dirname;
const config = getDefaultConfig(projectRoot);

const monorepoRoot = path.resolve(projectRoot, "../..");
if (fs.existsSync(path.join(monorepoRoot, "package.json"))) {
  config.watchFolders = [monorepoRoot];
  config.resolver.nodeModulesPaths = [
    path.resolve(projectRoot, "node_modules"),
    path.resolve(monorepoRoot, "node_modules")
  ];
}

module.exports = config;
