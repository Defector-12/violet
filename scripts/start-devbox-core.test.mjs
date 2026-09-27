import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe.each(["direct", "sudo"])("Devbox startup via %s", (route) => {
  it.each([
    { name: "defaults", memory: undefined, checkpoint: undefined },
    { name: "both disabled", memory: "false", checkpoint: "false" },
    { name: "memory disabled", memory: "false", checkpoint: "true" },
    { name: "checkpoint disabled", memory: "true", checkpoint: "false" },
  ])("passes $name to every Compose invocation", ({ memory, checkpoint }) => {
    const directory = mkdtempSync(join(tmpdir(), "violet-start-script-"));
    directories.push(directory);
    const bin = join(directory, "bin");
    const log = join(directory, "compose.log");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
set -eu
if [ "$1" = info ]; then
  [ "$TEST_ROUTE" = direct ] || [ "\${TEST_SUDO:-false}" = true ]
  exit $?
fi
[ "$1" = compose ] || exit 1
printf '%s|%s|%s\\n' "\${VIOLET_MEMORY_INJECTION_ENABLED:-unset}" \
"\${VIOLET_CONTEXT_CHECKPOINT_ENABLED:-unset}" "$*" >>"$TEST_LOG"
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(bin, "sudo"),
      `#!/bin/sh
set -eu
[ "$1" = -n ] || exit 1
shift
exec /usr/bin/env -i PATH="$PATH" TEST_LOG="$TEST_LOG" TEST_ROUTE="$TEST_ROUTE" \
TEST_SUDO=true "$@"
`,
      { mode: 0o700 },
    );
    const env = {
      PATH: `${bin}:/usr/bin:/bin`,
      TEST_LOG: log,
      TEST_ROUTE: route,
    };
    if (memory !== undefined) env.VIOLET_MEMORY_INJECTION_ENABLED = memory;
    if (checkpoint !== undefined) env.VIOLET_CONTEXT_CHECKPOINT_ENABLED = checkpoint;

    const result = spawnSync("sh", ["scripts/start-devbox-core.sh", "sealed"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });

    expect(result.status, result.stderr).toBe(0);
    const commands = readFileSync(log, "utf8").trim().split("\n");
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command.split("|").slice(0, 2)).toEqual([memory ?? "true", checkpoint ?? "true"]);
    }
    expect(commands[0]).toContain("stop core");
    expect(commands[1]).toContain("--profile sealed up -d --no-deps core-sealed");
  });
});
