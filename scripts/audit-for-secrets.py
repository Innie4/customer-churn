"""Fail if anything that would be committed looks like a real credential.

Run as part of `npm run verify`. The point is to catch the one mistake that
cannot be undone by amending a commit: a live key, token or connection string
pushed to a public repository.

Deliberately narrow. A broad "does this look secret-shaped" rule produces so many
false positives — user-facing error messages, test fixtures, documentation
examples — that it gets ignored, which is worse than not having it. So this only
reports values that are either a recognised credential format or high-entropy
enough that no placeholder would match.
"""

from __future__ import annotations

import math
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Formats that identify a credential regardless of entropy.
CREDENTIAL_FORMATS: list[tuple[str, re.Pattern[str]]] = [
    ("private key", re.compile(r"BEGIN (?:RSA |OPENSSH |EC |PGP )?PRIVATE KEY")),
    ("github token", re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}")),
    ("github fine-grained token", re.compile(r"github_pat_[A-Za-z0-9_]{20,}")),
    ("aws access key id", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("openai-style key", re.compile(r"\bsk-[A-Za-z0-9]{20,}")),
    ("slack token", re.compile(r"xox[abprs]-[A-Za-z0-9-]{10,}")),
    ("google api key", re.compile(r"AIza[0-9A-Za-z_-]{35}")),
    (
        "jwt",
        re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
    ),
    (
        "connection string with a password",
        re.compile(r"postgres(?:ql)?://[^\s:/'\"]+:[^\s@'\"]+@", re.IGNORECASE),
    ),
    (
        "mongodb with a password",
        re.compile(r"mongodb(?:\+srv)?://[^\s:/'\"]+:[^\s@'\"]+@", re.IGNORECASE),
    ),
]

# Assignments worth inspecting: a name that means "this is a credential".
CREDENTIAL_NAME = re.compile(
    r"""(?:secret|passwd|password|api[_-]?key|access[_-]?key|auth[_-]?token)"""
    r"""\s*[:=]\s*["']([^"'\n]{8,})["']""",
    re.IGNORECASE,
)

# Words that make a value a message or an example rather than a credential.
NOT_A_CREDENTIAL = re.compile(
    r"\b(?:enter|choose|request|does not|not a|your|the two|is not|"
    r"https?://|\.\.\.|example|placeholder|<|\{)",
    re.IGNORECASE,
)

# A literal that is obviously a placeholder. Kept explicit rather than inferred
# from entropy alone, so a genuine weak-looking key is still reported.
ALLOWED_LITERALS = {
    "test-only-session-secret-do-not-use-anywhere-0123456789",
    "your-key",
    "a-known-key",
    "test-key-abc123",
    "change-me",
    "changeme",
    "not-a-cookie",
    "choose-a-strong-one",
    "Correct-Horse-Battery-9",
    "Wrong-Password-123",
    "Brand-New-Password-7",
    "Another-Password-8",
    "openssl rand -base64 32",
    "openssl rand -base64 18",
    "no-churn-together",
}

SKIP_DIRECTORIES = {
    ".git", "node_modules", ".next", ".data", "storage", ".pytest_cache",
    ".pytest-artifacts", "__pycache__", "coverage", "out", "build",
}
BINARY_SUFFIXES = {
    ".csv", ".tsv", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
    ".joblib", ".pkl", ".zip", ".gz", ".pyc", ".so", ".dll", ".exe", ".woff",
    ".woff2", ".bin",
}


def target_files() -> list[Path]:
    """Every file that could be committed: tracked, plus anything untracked.

    Tracked files are included deliberately. Scanning only what is pending would
    make the guard useless the moment a commit is made, which is exactly when a
    reviewer stops looking.
    """
    files: dict[str, Path] = {}

    tracked = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    for entry in tracked.stdout.split("\0"):
        if entry:
            path = ROOT / entry
            if path.is_file():
                files[entry] = path

    untracked = subprocess.run(
        ["git", "status", "--porcelain", "-uall"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    for line in untracked.stdout.splitlines():
        raw = line[3:].strip()
        if " -> " in raw:  # a rename: the new name is what matters
            raw = raw.split(" -> ", 1)[1]
        path = ROOT / raw.strip('"')
        if path.is_file():
            files[raw] = path

    return list(files.values())


def shannon_entropy(value: str) -> float:
    if not value:
        return 0.0
    counts: dict[str, int] = {}
    for character in value:
        counts[character] = counts.get(character, 0) + 1
    length = len(value)
    return -sum(
        (count / length) * math.log2(count / length) for count in counts.values()
    )


def looks_random(value: str) -> bool:
    """Whether a value is unlikely to be a word a person chose.

    Prose and identifiers sit well below this. A generated secret sits well
    above it. The gap is wide because the two are easy to tell apart.
    """
    return len(value) >= 20 and shannon_entropy(value) >= 3.5


def main() -> int:
    files = target_files()
    if not files:
        print("Nothing to scan.")
        return 0

    findings: list[tuple[str, str, str]] = []
    checked = 0

    for path in files:
        if any(part in SKIP_DIRECTORIES for part in path.parts):
            continue
        if path.suffix.lower() in BINARY_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        checked += 1
        relative = path.relative_to(ROOT)

        for label, pattern in CREDENTIAL_FORMATS:
            for match in pattern.finditer(text):
                findings.append((label, str(relative), match.group(0)[:70]))

        for match in CREDENTIAL_NAME.finditer(text):
            value = match.group(1).strip()
            if value in ALLOWED_LITERALS:
                continue
            if NOT_A_CREDENTIAL.search(value):
                continue
            if looks_random(value):
                findings.append(
                    ("high-entropy credential", str(relative), value[:60])
                )

    if not findings:
        print(
            f"Credential scan clean across {checked} text file(s) "
            "(every tracked and untracked file, not just what is pending)."
        )
        return 0

    print(f"{len(findings)} value(s) that look like a real credential:\n")
    for label, path, value in findings:
        print(f"  [{label}] {path}")
        print(f"      {value}")
    print(
        "\nIf any of these is a live credential, rotate it before pushing. "
        "Removing it from a later commit does not remove it from history."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
