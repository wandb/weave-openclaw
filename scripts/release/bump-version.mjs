#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const nextVersion = process.argv[2];
const semverPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!nextVersion || !semverPattern.test(nextVersion)) {
  console.error("Usage: node scripts/release/bump-version.mjs <semver>");
  process.exit(1);
}

// Use regex replacement (not JSON.parse/stringify) so we preserve the
// original formatting of these files — JSON.stringify would reformat
// compact arrays and re-key the object.
replaceFirstMatch(
  "package.json",
  /("version"\s*:\s*")[^"]+(")/,
  `$1${nextVersion}$2`,
);

replaceFirstMatch(
  "openclaw.plugin.json",
  /("version"\s*:\s*")[^"]+(")/,
  `$1${nextVersion}$2`,
);

replaceFirstMatch(
  "src/version.ts",
  /(export const PACKAGE_VERSION\s*=\s*")[^"]+(")/,
  `$1${nextVersion}$2`,
);

console.log(`Bumped version to ${nextVersion}`);

function replaceFirstMatch(relativePath, pattern, replacement) {
  const filePath = path.join(repoRoot, relativePath);
  const original = fs.readFileSync(filePath, "utf8");

  if (!pattern.test(original)) {
    throw new Error(`Could not locate version field in ${relativePath}`);
  }

  // Re-test after .test() resets lastIndex; .replace with a non-global
  // regex naturally replaces only the first match.
  const updated = original.replace(pattern, replacement);
  fs.writeFileSync(filePath, updated);
}
