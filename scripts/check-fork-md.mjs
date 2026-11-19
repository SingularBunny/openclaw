#!/usr/bin/env node
// Fork: every path FORK.md names under **Where:** must exist in the tree. Paths there are often
// shortened to their tail (`chat-handoff.ts`, `components/chat-handoff-view.tsx`), so a path
// passes when some tracked file or folder ends with it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FILE_EXT = /\.(?:ts|tsx|mts|mjs|cjs|js|json|jsonc|md|css|yml|yaml|sh|swift|kt|py)$/;

const tracked = execFileSync("git", ["ls-files", "-z"], {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean);
const files = new Set(tracked);
const folders = new Set();
for (const file of tracked) {
  const parts = file.split("/");
  for (let i = 1; i < parts.length; i++) {
    folders.add(parts.slice(0, i).join("/"));
  }
}

const matchesTail = (set, tail) => {
  if (set.has(tail)) {
    return true;
  }
  const suffix = `/${tail}`;
  for (const entry of set) {
    if (entry.endsWith(suffix)) {
      return true;
    }
  }
  return false;
};

/** A backticked token that names a file or a folder, not a method, setting or glob. */
function pathCandidate(token) {
  if (/[\s*<>{}()=:,]/.test(token) || token.startsWith("-") || token.startsWith(".")) {
    return undefined;
  }
  if (FILE_EXT.test(token)) {
    return { kind: "file", path: token.replace(/^\.\//, "") };
  }
  if (token.includes("/") && /^[\w@.-]+(?:\/[\w@.-]+)+\/?$/.test(token)) {
    return { kind: "folder", path: token.replace(/\/$/, "") };
  }
  return undefined;
}

const missing = [];
let checked = 0;
const lines = readFileSync("FORK.md", "utf8").split("\n");
lines.forEach((line, index) => {
  const at = line.indexOf("**Where:**");
  if (at < 0) {
    return;
  }
  const docsAt = line.indexOf("**Docs:**", at);
  const where = line.slice(at, docsAt < 0 ? undefined : docsAt);
  for (const [, token] of where.matchAll(/`([^`]+)`/g)) {
    const candidate = pathCandidate(token);
    if (!candidate) {
      continue;
    }
    checked += 1;
    const found =
      candidate.kind === "file"
        ? matchesTail(files, candidate.path)
        : matchesTail(folders, candidate.path);
    if (!found) {
      missing.push(`FORK.md:${index + 1}: ${candidate.kind} not found: ${token}`);
    }
  }
});

if (checked === 0) {
  console.error("FORK.md: no paths found under **Where:**; the entry format changed?");
  process.exit(1);
}
if (missing.length > 0) {
  console.error(missing.join("\n"));
  console.error(`${missing.length} path(s) under Where do not exist.`);
  process.exit(1);
}
console.log(`FORK.md: all ${checked} paths under Where exist.`);
