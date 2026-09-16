#!/usr/bin/env python3
"""Clear stale SQLite journals and generation locks before OpenClaw starts.

A storage fault, an OOM kill, or a SIGKILLed gateway can leave a rollback
journal (``<db>-journal``) or a leftover generation/reindex lock on the
persistent volume. OpenClaw's SQLite open path treats a sidecar journal as
evidence another process owns the database and falls back to a read-only
connection; the auth-store materializer then fails with
``attempt to write a readonly database`` and the entrypoint exits 1, wedging
the tenant in CrashLoopBackOff until an operator clears the volume by hand.

Recovery:

1. Open each real database once so SQLite performs hot-journal rollback itself.
2. Delete any remaining sidecar files and generation/reindex lock files.

Only files that are SQLite sidecars of a database, or one of the known lock
file names, are ever removed. User data files are never touched.

Run as root, before the gateway starts, so this is the only writer.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path

# A sidecar belongs to the database whose name it extends.
SIDECAR_SUFFIXES = ("-journal", "-wal", "-shm")

# OpenClaw writer lock databases are themselves ``.sqlite`` files; they are
# recreated on demand and must never be treated as user databases.
LOCK_SUFFIXES = (
    ".generation-lock.sqlite",
    ".generation-writer.sqlite",
    ".reindex-lock.sqlite",
)


def state_dir() -> Path:
    explicit = os.environ.get("OPENCLAW_STATE_DIR", "").strip()
    if explicit:
        return Path(explicit)
    home = os.environ.get("PERSISTENT_HOME", "").strip() or os.environ.get("HOME", "")
    if not home:
        raise SystemExit("OPENCLAW_STATE_DIR and HOME are both unset")
    return Path(home) / ".openclaw"


def is_lock_file(path: Path) -> bool:
    return any(path.name.endswith(suffix) for suffix in LOCK_SUFFIXES)


def database_bases(root: Path):
    """Directories that hold OpenClaw databases.

    Deliberately narrow. A blanket walk of the state directory descends into
    the agent workspace (node_modules, git checkouts) and exhausts the process
    file-descriptor budget with EMFILE, which is worse than the bug being fixed.
    """
    yield root / "state"
    agents = root / "agents"
    if agents.is_dir():
        # agents/<agentId>/agent/openclaw-agent.sqlite
        for agent_dir in agents.iterdir():
            if agent_dir.is_dir():
                yield agent_dir / "agent"


def iter_databases(root: Path):
    for base in database_bases(root):
        if not base.is_dir():
            continue
        for path in sorted(base.glob("*.sqlite")):
            if is_lock_file(path) or not path.is_file():
                continue
            yield path


def roll_back(database: Path) -> str | None:
    """Open read-write so SQLite rolls a hot journal back. Returns an error."""
    try:
        connection = sqlite3.connect(database, timeout=30)
    except sqlite3.Error as error:
        return f"{database}: {error}"
    try:
        connection.execute("PRAGMA journal_mode=DELETE")
        connection.execute("PRAGMA integrity_check").fetchone()
        connection.commit()
    except sqlite3.Error as error:
        return f"{database}: {error}"
    finally:
        connection.close()
    return None


def remove(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        # Best effort: a racing writer or an already-clean volume is not fatal.
        pass


def main() -> int:
    root = state_dir()

    checked = 0
    failures: list[str] = []
    for database in iter_databases(root):
        checked += 1
        error = roll_back(database)
        if error:
            failures.append(error)

    removed = 0
    for database in iter_databases(root):
        for suffix in SIDECAR_SUFFIXES:
            sidecar = Path(f"{database}{suffix}")
            if sidecar.is_file():
                remove(sidecar)
                removed += 1

    for suffix in LOCK_SUFFIXES:
        for pattern in (f"*{suffix}", f"*{suffix}-journal"):
            for base in database_bases(root):
                if not base.is_dir():
                    continue
                for lock in base.glob(pattern):
                    if lock.is_file():
                        remove(lock)
                        removed += 1

    print(
        json.dumps(
            {
                "state_dir": str(root),
                "checked": checked,
                "removed": removed,
                "failures": failures,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
