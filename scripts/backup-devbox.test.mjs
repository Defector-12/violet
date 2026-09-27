import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Devbox backup script", () => {
  it("does not publish a backup when pg_dump fails", () => {
    const { result, data } = run({ DUMP_EXIT: "7" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pg_dump=7");
    expect(existsSync(join(data, "uploaded"))).toBe(false);
    expect(readdirSync(join(data, "backups")).filter((name) => name.endsWith(".vltbk"))).toEqual(
      [],
    );
  });

  it("records cleanup failure without marking online deletion undone", () => {
    const { result, data } = run({ PENDING: "t", UPLOAD_EXIT: "9" });
    expect(result.status).toBe(9);
    const commands = readFileSync(join(data, "commands"), "utf8");
    expect(commands).toContain("status = 'running'");
    expect(commands).toContain("status = 'failed'");
    expect(commands).not.toContain("status = 'complete'");
    expect(commands).toContain("--cleanup");
  });

  it("finishes only after successful upload and cleanup and uses the snapshot script", () => {
    const { result, data } = run({ PENDING: "t" });
    expect(result.status).toBe(0);
    const commands = readFileSync(join(data, "commands"), "utf8");
    expect(commands.indexOf("--cleanup")).toBeLessThan(commands.indexOf("status = 'complete'"));
    const snapshot = readFileSync(join(data, "snapshot.sql"), "utf8");
    expect(snapshot).toContain("pg_export_snapshot()");
    expect(snapshot).toContain('--snapshot="$VIOLET_BACKUP_SNAPSHOT"');
  });

  it("does no work for an idle cleanup poll or a busy backup lock", () => {
    const idle = run({}, ["--cleanup-only"]);
    expect(idle.result.status).toBe(0);
    expect(existsSync(join(idle.data, "snapshot.sql"))).toBe(false);
    const busy = run({ LOCK_EXIT: "1" });
    expect(busy.result.status).toBe(0);
    expect(existsSync(join(busy.data, "commands"))).toBe(false);
  });

  it("leaves cleanup failed and retryable when remote upload is disabled", () => {
    const { result, data } = run({ PENDING: "t", VIOLET_BACKUP_UPLOAD: "false" });
    expect(result.status).toBe(1);
    expect(readFileSync(join(data, "commands"), "utf8")).toContain("status = 'failed'");
  });
});

function run(env = {}, args = []) {
  const directory = mkdtempSync(join(tmpdir(), "violet-backup-script-"));
  directories.push(directory);
  const bin = join(directory, "bin");
  const data = join(directory, "data");
  const docker = join(bin, "docker");
  mkdirSync(bin);
  mkdirSync(data);
  writeFileSync(join(bin, "flock"), '#!/bin/sh\nexit "$LOCK_EXIT"\n', { mode: 0o700 });
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
set -eu
if [[ "\${1:-}" == "info" ]]; then exit 0; fi
printf '%s\\n' "$*" >>"$VIOLET_DATA_DIR/commands"
case " $* " in
  *"SELECT EXISTS"*)
    printf '%s\\n' "\${PENDING:-f}"
    ;;
  *" psql "*" --file - "*)
    cat >"$VIOLET_DATA_DIR/snapshot.sql"
    printf 'partial dump'
    exit "\${DUMP_EXIT:-0}"
    ;;
  *" run --rm --no-deps -T backup "*)
    cat >/dev/null
    mkdir -p "$VIOLET_DATA_DIR/backups"
    touch "$VIOLET_DATA_DIR/backups/synthetic.vltbk"
    printf '{"localPath":"/var/lib/violet/backups/synthetic.vltbk"}\\n'
    ;;
  *" backup-upload upload-existing "*)
    touch "$VIOLET_DATA_DIR/uploaded"
    exit "\${UPLOAD_EXIT:-0}"
    ;;
esac
`,
    { mode: 0o700 },
  );
  const result = spawnSync("bash", ["scripts/backup-devbox.sh", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      VIOLET_BACKUP_UPLOAD: "true",
      VIOLET_DATA_DIR: data,
      LOCK_EXIT: "0",
      ...env,
    },
  });

  return { result, data };
}
