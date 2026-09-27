import { spawnSync } from "node:child_process";

// Build workspace dependencies first; do not depend on an optional tsx executable.
const build = spawnSync("pnpm", ["--filter", "@violet/core...", "build"], { stdio: "inherit" });
if (build.status !== 0) {
  process.exitCode = build.status ?? 1;
} else {
  const evaluation = spawnSync(
    process.execPath,
    ["services/core/dist/memory/eval-memory.js", ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exitCode = evaluation.status ?? 1;
}
