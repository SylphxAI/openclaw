#!/usr/bin/env python3
"""Regression tests for recover-sqlite-state.py.

The failure this guards: a storage fault or a SIGKILLed gateway leaves a hot
rollback journal (or a stale generation/reindex lock) on the PVC. OpenClaw's
SQLite open path then refuses a writable connection, the auth-store
materializer exits 1, and the tenant wedges in CrashLoopBackOff.

Run with: python3 sylphx/scripts/recover-sqlite-state.test.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "recover-sqlite-state.py"


def load_module():
    spec = importlib.util.spec_from_file_location("recover_sqlite_state", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def make_database(path: Path, rows: int = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=delete")
    connection.execute("CREATE TABLE IF NOT EXISTS t(x)")
    connection.executemany("INSERT INTO t VALUES (?)", ((value,) for value in range(rows)))
    connection.commit()
    connection.close()


def leave_hot_journal(path: Path) -> None:
    """SIGKILL a writer mid-transaction so a real hot journal is left behind."""
    program = (
        "import os, signal, sqlite3\n"
        f"c = sqlite3.connect({str(path)!r})\n"
        "c.execute('PRAGMA journal_mode=delete')\n"
        "c.execute('BEGIN IMMEDIATE')\n"
        "c.execute('INSERT INTO t VALUES (999)')\n"
        "os.kill(os.getpid(), signal.SIGKILL)\n"
    )
    subprocess.run([sys.executable, "-c", program], check=False)


def run_recovery(state_dir: Path) -> dict:
    environment = dict(os.environ)
    environment["OPENCLAW_STATE_DIR"] = str(state_dir)
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        capture_output=True,
        text=True,
        env=environment,
        check=True,
    )
    return json.loads(result.stdout)


def test_rolls_back_hot_journal() -> None:
    """A hot journal must roll back, and the database must become writable."""
    with tempfile.TemporaryDirectory() as tmp:
        state_dir = Path(tmp) / ".openclaw"
        database = state_dir / "agents/main/agent/openclaw-agent.sqlite"
        make_database(database)
        leave_hot_journal(database)
        journal = Path(f"{database}-journal")
        assert journal.exists(), "test setup failed to leave a hot journal"

        report = run_recovery(state_dir)
        assert report["failures"] == [], report
        assert not journal.exists(), "recovery left the hot journal in place"

        connection = sqlite3.connect(database)
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        # The uncommitted row must be gone; the committed row must survive.
        assert connection.execute("SELECT * FROM t").fetchall() == [(0,)]
        connection.execute("INSERT INTO t VALUES (7)")
        connection.commit()
        connection.close()


def test_removes_stale_locks_and_sidecars_only() -> None:
    """Only SQLite sidecars and known lock files may be removed."""
    with tempfile.TemporaryDirectory() as tmp:
        state_dir = Path(tmp) / ".openclaw"
        database = state_dir / "agents/main/agent/openclaw-agent.sqlite"
        make_database(database)

        removable = [
            Path(f"{database}-journal"),
            Path(f"{database}-shm"),
            Path(f"{database}.generation-lock.sqlite"),
            Path(f"{database}.generation-writer.sqlite-journal"),
            Path(f"{database}.reindex-lock.sqlite"),
        ]
        for path in removable:
            path.write_bytes(b"stale")

        keep = [
            database,
            Path(f"{database}.memory-reindex-abc123"),
            state_dir / "agents/main/agent/MEMORY.md",
        ]
        keep[1].write_bytes(b"keep")
        keep[2].write_text("keep")

        report = run_recovery(state_dir)
        assert report["failures"] == [], report
        for path in removable:
            assert not path.exists(), f"stale file survived: {path.name}"
        for path in keep:
            assert path.exists(), f"user data was deleted: {path.name}"


def test_noop_when_state_dir_clean() -> None:
    """A healthy volume must be reported clean with nothing removed."""
    with tempfile.TemporaryDirectory() as tmp:
        state_dir = Path(tmp) / ".openclaw"
        make_database(state_dir / "state/openclaw.sqlite")
        report = run_recovery(state_dir)
        assert report["checked"] == 1, report
        assert report["removed"] == 0, report
        assert report["failures"] == [], report


def test_missing_state_dir_is_not_fatal() -> None:
    """A missing volume must not make boot fail."""
    with tempfile.TemporaryDirectory() as tmp:
        report = run_recovery(Path(tmp) / "does-not-exist")
        assert report["failures"] == [], report


def test_ignores_workspace_tree_and_avoids_emfile() -> None:
    """A deep workspace tree must not be walked.

    Real volumes carry node_modules and git checkouts under the agent
    workspace. A recursive walk of the whole state directory exhausts the
    process file-descriptor budget with EMFILE and fails the boot step, so the
    scan must only look at the known database directories.
    """
    with tempfile.TemporaryDirectory() as tmp:
        state_dir = Path(tmp) / ".openclaw"
        make_database(state_dir / "agents/main/agent/openclaw-agent.sqlite")
        make_database(state_dir / "state/openclaw.sqlite")

        # A deep, wide tree that a recursive walk would descend into.
        noise = state_dir / "workspace/tmp/deps/node_modules"
        noise.mkdir(parents=True)
        for index in range(600):
            (noise / f"pkg-{index}").mkdir()
            (noise / f"pkg-{index}/index.js").write_text("x")

        report = run_recovery(state_dir)
        assert report["failures"] == [], report
        assert report["checked"] == 2, report


def test_lock_files_inside_workspace_are_left_alone() -> None:
    """Lock-suffix files outside the database dirs must not be touched."""
    with tempfile.TemporaryDirectory() as tmp:
        state_dir = Path(tmp) / ".openclaw"
        make_database(state_dir / "state/openclaw.sqlite")
        stray = state_dir / "workspace/some.generation-lock.sqlite"
        stray.parent.mkdir(parents=True, exist_ok=True)
        stray.write_bytes(b"not-ours")

        run_recovery(state_dir)
        assert stray.exists(), "recovery reached outside the database directories"


def test_recovery_never_reports_failure_for_a_healthy_rolled_back_database() -> None:
    """After a successful rollback the report must be clean.

    Live context: the boot recovery logged `failures: [... database disk image
    is malformed]` for a tenant whose database was in fact healthy (a full
    `integrity_check` returned ok and the tenant was serving traffic). The
    check now runs on a fresh read-only handle after the rollback commits.
    This test pins the invariant the log must satisfy for a healthy database:
    rolled back, no failure reported, data intact.
    """
    with tempfile.TemporaryDirectory() as tmp:
        state_dir = Path(tmp) / ".openclaw"
        database = state_dir / "agents/main/agent/openclaw-agent.sqlite"
        make_database(database, rows=2000)
        leave_hot_journal(database)
        assert Path(f"{database}-journal").exists()

        report = run_recovery(state_dir)
        assert report["failures"] == [], report
        assert report["checked"] == 1, report

        verify = sqlite3.connect(database)
        assert verify.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert verify.execute("SELECT count(*) FROM t").fetchone() == (2000,)
        verify.close()


def main() -> int:
    module = load_module()
    assert module.SIDECAR_SUFFIXES[0] == "-journal"
    tests = [
        test_rolls_back_hot_journal,
        test_removes_stale_locks_and_sidecars_only,
        test_noop_when_state_dir_clean,
        test_missing_state_dir_is_not_fatal,
        test_ignores_workspace_tree_and_avoids_emfile,
        test_lock_files_inside_workspace_are_left_alone,
        test_recovery_never_reports_failure_for_a_healthy_rolled_back_database,
    ]
    for test in tests:
        test()
        print(f"  ok  {test.__name__}")
    print("recover-sqlite-state.test.py: all passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
