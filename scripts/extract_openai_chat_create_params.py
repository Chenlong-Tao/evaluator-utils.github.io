#!/usr/bin/env python3
"""
Extract `client.chat.completions.create(...)` parameter metadata from openai-python.

This script is intended to generate a JSON metadata file for a specific openai-python
version (e.g., 1.99.9) by parsing the generated TypedDict source that contains
per-field docstrings.

Usage (example):
  PYTHONPATH=.tmp/openai_1_99_9 python3 scripts/extract_openai_chat_create_params.py \
    --out assets/data/openai-1.99.9-chat-completions-create.json \
    --sdk-version 1.99.9
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional


@dataclass(frozen=True)
class FieldMeta:
    """Metadata for a single request parameter."""

    name: str
    type_str: str
    description: str
    required: bool


def _read_text(path: Path) -> str:
    """Read a UTF-8 text file."""

    return path.read_text(encoding="utf-8")


def _find_types_file(openai_pkg_dir: Path) -> Path:
    """Locate the SDK types file that defines chat completion create params."""

    candidates: list[Path] = [
        openai_pkg_dir / "types" / "chat" / "completion_create_params.py",
        openai_pkg_dir / "types" / "chat" / "chat_completion_create_params.py",
    ]
    for c in candidates:
        if c.exists():
            return c
    raise FileNotFoundError(
        "Could not find completion create params file. Tried: "
        + ", ".join(str(p) for p in candidates)
    )


def _extract_fields(source: str) -> list[FieldMeta]:
    """
    Extract fields by scanning for TypedDict-style `name: Type` lines
    followed by an indented triple-quoted docstring literal.
    """

    # Field line: 4 spaces + name + ":" + type
    field_re = re.compile(r"^\s{4}([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+?)\s*$")

    lines: list[str] = source.splitlines()
    out: list[FieldMeta] = []

    i = 0
    while i < len(lines):
        m = field_re.match(lines[i])
        if not m:
            i += 1
            continue

        name = m.group(1)
        type_str = m.group(2).strip()

        # Required detection heuristic (generated types often use Required[...] / NotRequired[...])
        required = "Required[" in type_str and "NotRequired[" not in type_str

        # Look ahead for docstring literal on following lines (skipping blank lines)
        j = i + 1
        while j < len(lines) and lines[j].strip() == "":
            j += 1

        description = ""
        if j < len(lines):
            s = lines[j].lstrip()
            if s.startswith('"""') or s.startswith("'''"):
                quote = s[:3]
                # Single-line docstring: """text"""
                if s.count(quote) >= 2 and len(s) > 6:
                    description = s.strip()[3:-3].strip()
                    i = j + 1
                    out.append(FieldMeta(name=name, type_str=type_str, description=description, required=required))
                    continue

                # Multi-line docstring
                parts: list[str] = []
                # Remove opening quotes
                first = s[3:]
                if first:
                    parts.append(first)
                k = j + 1
                while k < len(lines):
                    t = lines[k]
                    if quote in t:
                        before, _sep, _after = t.partition(quote)
                        parts.append(before)
                        break
                    parts.append(t)
                    k += 1
                description = "\n".join(p.rstrip() for p in parts).strip()
                i = k + 1
                out.append(FieldMeta(name=name, type_str=type_str, description=description, required=required))
                continue

        # No docstring found; still include.
        out.append(FieldMeta(name=name, type_str=type_str, description=description, required=required))
        i += 1

    # Deduplicate by name while preserving first occurrence
    seen: set[str] = set()
    uniq: list[FieldMeta] = []
    for f in out:
        if f.name in seen:
            continue
        seen.add(f.name)
        uniq.append(f)
    return uniq


def _load_openai_pkg_dir() -> Path:
    """Import openai and return its package directory."""

    try:
        import openai  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError(
            "Failed to import openai. Make sure PYTHONPATH points to the installed SDK target dir."
        ) from exc

    pkg_file = Path(getattr(openai, "__file__", ""))
    if not pkg_file.exists():
        raise RuntimeError("Could not resolve openai.__file__")
    return pkg_file.parent


def _build_payload(fields: Iterable[FieldMeta], sdk_version: str) -> dict[str, Any]:
    """Build JSON-serializable payload."""

    return {
        "sdk": {"name": "openai-python", "version": sdk_version},
        "endpoint": "client.chat.completions.create",
        "fields": [
            {
                "name": f.name,
                "type": f.type_str,
                "required": f.required,
                "description": f.description,
            }
            for f in fields
        ],
    }


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    """Parse CLI args."""

    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", required=True, help="Output JSON path (relative to repo root).")
    p.add_argument("--sdk-version", required=True, help="SDK version string, e.g., 1.99.9")
    return p.parse_args(argv)


def main(argv: Optional[list[str]] = None) -> int:
    """Program entrypoint."""

    args = _parse_args(argv)
    openai_pkg_dir = _load_openai_pkg_dir()
    types_file = _find_types_file(openai_pkg_dir)
    src = _read_text(types_file)
    fields = _extract_fields(src)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = _build_payload(fields, sdk_version=args.sdk_version)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"Wrote {len(payload['fields'])} fields to {out_path} (from {types_file})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


