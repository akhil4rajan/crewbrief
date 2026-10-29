"""pre-commit guard for environment files.

* Blocks committing ``.env.local`` / ``.env.*.local`` (real secrets live there).
* In committed env files (``.env``, ``.env.example``), every secret-looking variable must be
  empty or contain the word "dummy". This keeps the "dummy values only" contract that lets
  the stack run offline, and that the code relies on (``Settings.is_dummy``).

Usage (pre-commit passes the staged file names): python scripts/check_committed_env.py FILE...
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SECRET_NAME = re.compile(r"(KEY|SECRET|TOKEN|PASSWORD|CONNECTION_STRING|CREDENTIALS?)$", re.IGNORECASE)
LOCAL_FILE = re.compile(r"^\.env(\..+)?\.local$|^\.env\.local$")


def check(path: Path) -> list[str]:
    if LOCAL_FILE.match(path.name):
        return [f"{path}: never commit local env files (they hold real secrets)"]
    errors = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, _, value = stripped.partition("=")
        name = name.strip().removeprefix("export ").strip()
        value = value.strip().strip("'\"")
        if SECRET_NAME.search(name) and value and "dummy" not in value.lower():
            errors.append(f"{path}:{lineno}: {name} looks like a real secret; "
                          "committed env files may only hold dummy values")
    return errors


def main(argv: list[str]) -> int:
    errors = [e for arg in argv for e in check(Path(arg))]
    for e in errors:
        print(e, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
