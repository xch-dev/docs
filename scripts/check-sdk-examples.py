#!/usr/bin/env python3
"""Compile and run the Rust examples in the Wallet SDK docs.

Every ```rust block in docs/sdk becomes its own module in the sdk-examples crate (so each block needs
its own `use` lines), and `cargo test` runs them. Blocks marked ```rust ignore are skipped.

Usage:
  scripts/check-sdk-examples.py [PAGE.md ...] [--sdk PATH] [-- CARGO_TEST_ARGS ...]

  PAGE.md     Only check these pages (default: every page in docs/sdk).
  --sdk PATH  Build against a local chia-wallet-sdk checkout instead of the `rev` in
              sdk-examples/Cargo.toml, for example to check the docs against an unreleased change.

Compiler errors point at sdk-examples/src/docs/<page>_<n>.rs, whose first line names the markdown
file and line the block came from.
"""

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs" / "sdk"
CRATE = ROOT / "sdk-examples"
OUT = CRATE / "src" / "docs"
SDK_GIT = "https://github.com/xch-dev/chia-wallet-sdk"
FENCE = re.compile(r"^(\s*)```rust\b(.*)$")


def parse_args(argv):
    pages, sdk, cargo_args = [], None, []
    if "--" in argv:
        index = argv.index("--")
        argv, cargo_args = argv[:index], argv[index + 1 :]
    i = 0
    while i < len(argv):
        if argv[i] == "--sdk":
            sdk = Path(argv[i + 1]).resolve()
            i += 2
        else:
            pages.append(Path(argv[i]).resolve())
            i += 1
    return pages or sorted(DOCS.rglob("*.md")), sdk, cargo_args


def extract(page):
    """Yields (line number, code) for every checked rust block in a page."""
    lines = page.read_text().split("\n")
    i = 0
    while i < len(lines):
        match = FENCE.match(lines[i])
        i += 1
        if not match:
            continue
        indent, info = match.groups()
        start, body = i, []
        while i < len(lines) and not lines[i].strip().startswith("```"):
            line = lines[i]
            body.append(line[len(indent) :] if line.startswith(indent) else line)
            i += 1
        i += 1
        if "ignore" not in info.split():
            yield start, "\n".join(body)


def main():
    pages, sdk, cargo_args = parse_args(sys.argv[1:])

    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)

    modules = []
    for page in pages:
        relative = page.relative_to(DOCS).with_suffix("")
        slug = re.sub(r"[^a-z0-9]+", "_", str(relative).lower()).strip("_")
        for n, (line, code) in enumerate(extract(page), start=1):
            name = f"{slug}_{n}"
            source = f"// {page.relative_to(ROOT)}:{line}\n{code}\n"
            (OUT / f"{name}.rs").write_text(source)
            modules.append(name)

    (OUT / "mod.rs").write_text(
        "".join(f'#[path = "{name}.rs"]\nmod {name};\n' for name in modules)
    )
    print(f"Extracted {len(modules)} examples from {len(pages)} pages")

    command = ["cargo", "test", "--quiet"]
    if sdk:
        for name, path in [
            ("chia-wallet-sdk", sdk),
            ("chia-sdk-test", sdk / "crates" / "chia-sdk-test"),
        ]:
            command += ["--config", f'patch."{SDK_GIT}".{name}.path="{path}"']
    command += cargo_args

    # Patching the SDK rewrites Cargo.lock to point at the local checkout, so put it back afterwards.
    lockfile = CRATE / "Cargo.lock"
    original_lock = lockfile.read_bytes() if sdk and lockfile.exists() else None
    try:
        status = subprocess.call(command, cwd=CRATE)
    finally:
        if original_lock is not None:
            lockfile.write_bytes(original_lock)
    sys.exit(status)


if __name__ == "__main__":
    main()
