#!/usr/bin/env python3
"""
Extract `client.chat.completions.create(...)` parameter metadata from openai-python.

This script is intended to generate a JSON metadata file for a specific openai-python
version (e.g., 1.99.9) by parsing the generated TypedDict source that contains
per-field docstrings.

Compared to "raw" TypedDict annotations, the output `type` field is intentionally
"simplified" to reflect how users actually pass values into the Python SDK:

- Expand local `TypeAlias` / `NAME = ...` aliases (e.g. `ReasoningEffort`).
- Drop `Required[...]` / `NotRequired[...]` wrappers (requiredness is surfaced separately).
- Reduce enum-like `Literal[...]` aliases to their primitive base types (usually `str`).
- Convert unknown SDK TypedDict-ish names to JSON-ish containers:
  - objects: `Dict[str, Any]`
  - arrays: `List[...]`

Usage (example):
  PYTHONPATH=.tmp/openai_1_99_9 python3 scripts/extract_openai_chat_create_params.py \
    --out assets/data/openai-1.99.9-chat-completions-create.json \
    --sdk-version 1.99.9
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence


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


def _collect_type_aliases(source: str) -> dict[str, str]:
    """
    Collect top-level type alias definitions from a generated SDK types module.

    Supports patterns like:
    - `Name = ...`
    - `Name: TypeAlias = ...`

    Returns a mapping of alias name to the RHS type expression string.
    """

    # NOTE: openai-python's generated files are fairly regular; we keep parsing permissive.
    assign_re = re.compile(
        r"^(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*TypeAlias\s*)?=\s*(?P<rhs>.+?)\s*$"
    )

    aliases: dict[str, str] = {}
    lines = source.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line or line.startswith((" ", "\t", "#")):
            i += 1
            continue

        m = assign_re.match(line)
        if not m:
            i += 1
            continue

        name = m.group("name")
        rhs = m.group("rhs").strip()

        # Accumulate multiline RHS when brackets are unbalanced.
        # This is a best-effort heuristic and works for typical generated aliases.
        depth = 0
        in_str = False
        str_char: str | None = None

        def _scan(s: str) -> None:
            nonlocal depth, in_str, str_char
            j = 0
            while j < len(s):
                ch = s[j]
                if in_str:
                    if ch == "\\":
                        j += 2
                        continue
                    if ch == str_char:
                        in_str = False
                        str_char = None
                    j += 1
                    continue
                if ch in ("'", '"'):
                    in_str = True
                    str_char = ch
                    j += 1
                    continue
                if ch in "([{":
                    depth += 1
                elif ch in ")]}":
                    depth = max(0, depth - 1)
                j += 1

        _scan(rhs)
        j = i
        while depth > 0 and j + 1 < len(lines):
            j += 1
            cont = lines[j].strip()
            if not cont:
                continue
            rhs += " " + cont
            _scan(cont)

        # Filter out non-type runtime values (rare, but keep conservative).
        if name not in aliases:
            aliases[name] = rhs
        i = j + 1

    return aliases


def _collect_all_type_aliases(openai_pkg_dir: Path) -> dict[str, str]:
    """
    Collect type aliases from the entire `openai/types/` tree.

    Rationale: many SDK "simple" params (e.g. ReasoningEffort) are imported from
    other modules, not defined in `completion_create_params.py` directly.
    """

    types_dir = openai_pkg_dir / "types"
    if not types_dir.exists():
        return {}

    aliases: dict[str, str] = {}
    for p in sorted(types_dir.rglob("*.py")):
        try:
            src = _read_text(p)
        except OSError:
            continue
        for k, v in _collect_type_aliases(src).items():
            # Keep first occurrence to avoid noisy shadowing.
            if k not in aliases:
                aliases[k] = v
    return aliases


class _TypeSimplifier:
    """Simplify SDK type-annotation strings into user-friendly Python types."""

    _PRIMITIVES: set[str] = {"str", "int", "float", "bool", "Any", "None"}
    _CONTAINERS: set[str] = {
        "Optional",
        "Union",
        "List",
        "Dict",
        "Iterable",
        "Sequence",
        "Literal",
        "Required",
        "NotRequired",
    }

    def __init__(self, aliases: dict[str, str]) -> None:
        self._aliases = aliases
        self._alias_cache: dict[str, str] = {}

    def simplify(self, type_str: str) -> str:
        """
        Simplify a type annotation string.

        This function never evaluates code; it parses the type expression as AST.
        """

        s = type_str.strip()
        # Normalize common prefixes (best-effort).
        s = s.replace("typing_extensions.", "").replace("typing.", "")

        try:
            node = ast.parse(s, mode="eval").body
        except SyntaxError:
            # Fallback: unknown/complex shapes become "Any" to avoid breaking downstream.
            return "Any"

        return self._to_str(self._simplify_node(node, stack=()))

    def _simplify_alias(self, name: str, stack: tuple[str, ...]) -> ast.AST:
        if name in self._alias_cache:
            return ast.parse(self._alias_cache[name], mode="eval").body
        if name in stack:
            return ast.Name(id="Any")
        rhs = self._aliases.get(name)
        if not rhs:
            return ast.Name(id="Any")
        expr = rhs.strip().replace("typing_extensions.", "").replace("typing.", "")
        try:
            node = ast.parse(expr, mode="eval").body
        except SyntaxError:
            return ast.Name(id="Any")
        simplified = self._simplify_node(node, stack=stack + (name,))
        s = self._to_str(simplified)
        self._alias_cache[name] = s
        return ast.parse(s, mode="eval").body

    def _name_of(self, node: ast.AST) -> str | None:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return node.attr
        return None

    def _slice_elts(self, node: ast.AST) -> list[ast.AST]:
        # Python 3.9+: Subscript.slice is an AST node (Tuple/Name/etc).
        if isinstance(node, ast.Tuple):
            return list(node.elts)
        return [node]

    def _literal_base_type(self, elts: list[ast.AST]) -> ast.AST:
        # Reduce Literal[...] to its primitive base type, preferring str for enums.
        # Supported: string/int/float/bool; otherwise Any.
        has_str = False
        has_float = False
        has_int = False
        has_bool = False
        for e in elts:
            if isinstance(e, ast.Constant):
                if isinstance(e.value, str):
                    has_str = True
                elif isinstance(e.value, bool):
                    has_bool = True
                elif isinstance(e.value, int):
                    has_int = True
                elif isinstance(e.value, float):
                    has_float = True
        if has_str:
            return ast.Name(id="str")
        if has_float:
            return ast.Name(id="float")
        if has_int:
            return ast.Name(id="int")
        if has_bool:
            return ast.Name(id="bool")
        return ast.Name(id="Any")

    def _simplify_node(self, node: ast.AST, stack: tuple[str, ...]) -> ast.AST:
        # Support PEP 604 `A | B` as Union[A, B]
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            left = self._simplify_node(node.left, stack=stack)
            right = self._simplify_node(node.right, stack=stack)
            return ast.Subscript(
                value=ast.Name(id="Union"),
                slice=ast.Tuple(elts=[left, right]),
            )

        if isinstance(node, ast.Name):
            if node.id in self._PRIMITIVES or node.id in self._CONTAINERS:
                return node
            if node.id in self._aliases:
                return self._simplify_alias(node.id, stack=stack)
            # Unknown SDK names (TypedDict-like) -> JSON object
            return ast.parse("Dict[str, Any]", mode="eval").body

        if isinstance(node, ast.Attribute):
            # Use the attribute name and re-run (handles typing.Literal, etc.)
            return self._simplify_node(ast.Name(id=node.attr), stack=stack)

        if isinstance(node, ast.Subscript):
            head = self._name_of(node.value) or ""
            # Normalize container heads like Iterable/Sequence -> List
            if head in {"Iterable", "Sequence"}:
                head = "List"

            slice_node = node.slice
            args = self._slice_elts(slice_node)

            if head in {"Required", "NotRequired"}:
                # wrappers: drop them (requiredness is tracked separately)
                inner = args[0] if args else ast.Name(id="Any")
                return self._simplify_node(inner, stack=stack)

            if head == "Optional":
                inner = self._simplify_node(args[0], stack=stack) if args else ast.Name(id="Any")
                return ast.Subscript(value=ast.Name(id="Optional"), slice=inner)

            if head == "Union":
                simplified_args = [self._simplify_node(a, stack=stack) for a in args]
                # Flatten Union[Union[...], ...]
                flat: list[ast.AST] = []
                for a in simplified_args:
                    if isinstance(a, ast.Subscript) and self._name_of(a.value) == "Union":
                        flat.extend(self._slice_elts(a.slice))
                    else:
                        flat.append(a)
                # Reduce Literal[...] members to base primitive
                reduced: list[ast.AST] = []
                for a in flat:
                    if isinstance(a, ast.Subscript) and self._name_of(a.value) == "Literal":
                        reduced.append(self._literal_base_type(self._slice_elts(a.slice)))
                    else:
                        reduced.append(a)
                # De-dup by rendered string
                uniq: dict[str, ast.AST] = {}
                for a in reduced:
                    uniq[self._to_str(a)] = a
                final = list(uniq.values())
                if len(final) == 1:
                    return final[0]
                return ast.Subscript(value=ast.Name(id="Union"), slice=ast.Tuple(elts=final))

            if head == "Literal":
                # Direct literal: reduce to primitive base
                return self._literal_base_type(args)

            if head == "List":
                inner = self._simplify_node(args[0], stack=stack) if args else ast.Name(id="Any")
                return ast.Subscript(value=ast.Name(id="List"), slice=inner)

            if head == "Dict":
                # Prefer Dict[str, Any] for unknown shapes; preserve simple Dict[str, int] etc.
                if len(args) == 2:
                    k = self._simplify_node(args[0], stack=stack)
                    v = self._simplify_node(args[1], stack=stack)
                    return ast.Subscript(value=ast.Name(id="Dict"), slice=ast.Tuple(elts=[k, v]))
                return ast.parse("Dict[str, Any]", mode="eval").body

            # Unknown generic container -> Any
            return ast.Name(id="Any")

        # Fallback
        return ast.Name(id="Any")

    def _to_str(self, node: ast.AST) -> str:
        """Render a simplified AST node back into a type string."""

        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Constant):
            return repr(node.value)
        if isinstance(node, ast.Tuple):
            return ", ".join(self._to_str(e) for e in node.elts)
        if isinstance(node, ast.Subscript):
            head = self._to_str(node.value)
            if isinstance(node.slice, ast.Tuple):
                inner = ", ".join(self._to_str(e) for e in node.slice.elts)
            else:
                inner = self._to_str(node.slice)
            return f"{head}[{inner}]"
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            return f"{self._to_str(node.left)} | {self._to_str(node.right)}"
        return "Any"


def _is_optional_type(type_str: str) -> bool:
    """Best-effort check whether a type string already includes optionality."""

    s = type_str.replace(" ", "")
    return s.startswith("Optional[") or "None" in s and s.startswith("Union[")


def _strip_required_wrappers(type_str: str) -> str:
    """Drop `Required[...]` / `NotRequired[...]` wrappers from a type string."""

    s = type_str.strip()
    for _ in range(6):
        m = re.fullmatch(r"(?:Required|NotRequired)\[(.+)\]", s)
        if not m:
            break
        s = m.group(1).strip()
    return s


def _collapse_nested_optional(type_str: str) -> str:
    """
    Collapse nested Optional wrappers, e.g. `Optional[Optional[str]]` -> `Optional[str]`.
    """

    s = type_str.replace(" ", "").strip()
    for _ in range(8):
        m = re.fullmatch(r"Optional\[Optional\[(.+)\]\]", s)
        if not m:
            break
        s = f"Optional[{m.group(1)}]"
    return s


def _simplify_field_type(type_str: str, required: bool, simplifier: _TypeSimplifier) -> str:
    """
    Simplify a raw field type string into a "user-facing" Python type annotation.

    - Removes Required/NotRequired wrappers
    - Expands aliases (TypeAlias / NAME = ...)
    - Reduces Literal enums to primitives (usually str)
    - Wraps non-required fields with Optional[...] when not already optional
    """

    raw = _strip_required_wrappers(type_str)
    simplified = simplifier.simplify(raw)
    if not required and not _is_optional_type(simplified):
        simplified = f"Optional[{simplified}]"
    return _collapse_nested_optional(simplified)


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


def _iter_top_level_class_blocks(source: str) -> list[tuple[str, str]]:
    """
    Return a list of (class_name, class_body_source) for top-level classes.

    Notes:
    - We only consider top-level `class ...:` definitions (no leading indentation).
    - The returned body source contains the indented lines under that class, excluding the `class` line.
    """

    lines: list[str] = source.splitlines()
    class_re = re.compile(r"^class\s+([A-Za-z_][A-Za-z0-9_]*)\b.*:\s*$")

    blocks: list[tuple[str, str]] = []
    i = 0
    while i < len(lines):
        m = class_re.match(lines[i])
        if not m:
            i += 1
            continue

        class_name = m.group(1)
        i += 1
        body_lines: list[str] = []
        # Capture until next top-level statement (indent 0) or EOF
        while i < len(lines):
            line = lines[i]
            if line and not line.startswith((" ", "\t")):
                break
            body_lines.append(line)
            i += 1

        blocks.append((class_name, "\n".join(body_lines)))

    return blocks


def _pick_chat_create_params_block(source: str) -> str:
    """
    Pick the most likely TypedDict block for `chat.completions.create` request body.

    Heuristic:
    - Among top-level classes, select the one whose extracted fields contain BOTH
      `model` and `messages` (these are always present in the chat create body).
    - If multiple match, prefer the one with the largest number of extracted fields.
    """

    best_body: str | None = None
    best_count = -1
    for _class_name, body in _iter_top_level_class_blocks(source):
        fields = _extract_fields(body)
        names = {f.name for f in fields}
        if "model" not in names or "messages" not in names:
            continue
        if len(fields) > best_count:
            best_count = len(fields)
            best_body = body

    if best_body is None:
        raise RuntimeError(
            "Could not locate the chat create params TypedDict block (expected fields: model, messages)."
        )
    return best_body


def _default_request_options() -> list[FieldMeta]:
    """
    Return common openai-python per-request options accepted by resource methods.

    These are not part of the JSON request body; they are passed as keyword args
    to the SDK method (e.g. extra_headers=..., timeout=...).
    """

    return [
        FieldMeta(
            name="extra_headers",
            type_str="Optional[Dict[str, str]]",
            required=False,
            description="请求级额外 HTTP headers（不属于请求体 JSON）。例如：{\"x-trace-id\": \"abc\"}。",
        ),
        FieldMeta(
            name="extra_query",
            type_str="Optional[Dict[str, str]]",
            required=False,
            description="请求级额外 URL query 参数（不属于请求体 JSON）。例如：{\"foo\": \"bar\"}。",
        ),
        FieldMeta(
            name="extra_body",
            type_str="Optional[Dict[str, Any]]",
            required=False,
            description="请求级额外 body 合并字段（不属于标准请求体 TypedDict）。通常用于 forward-compat。",
        ),
        FieldMeta(
            name="timeout",
            type_str="Optional[float]",
            required=False,
            description="请求超时时间（秒）。不属于请求体 JSON。",
        ),
    ]


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


def _build_payload(
    fields: Iterable[FieldMeta],
    sdk_version: str,
    simplifier: _TypeSimplifier,
) -> dict[str, Any]:
    """Build JSON-serializable payload."""

    request_options = _default_request_options()

    return {
        "sdk": {"name": "openai-python", "version": sdk_version},
        "endpoint": "client.chat.completions.create",
        "body_fields": [
            {
                "name": f.name,
                "type": _simplify_field_type(f.type_str, required=f.required, simplifier=simplifier),
                "sdk_type": _strip_required_wrappers(f.type_str),
                "required": f.required,
                "description": f.description,
            }
            for f in fields
        ],
        "request_options": [
            {
                "name": f.name,
                "type": _simplify_field_type(f.type_str, required=f.required, simplifier=simplifier),
                "sdk_type": _strip_required_wrappers(f.type_str),
                "required": f.required,
                "description": f.description,
            }
            for f in request_options
        ],
    }


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    """Parse CLI args."""

    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", required=True, help="Output JSON path (relative to repo root).")
    p.add_argument("--sdk-version", required=True, help="SDK version string, e.g., 1.99.9")
    p.add_argument(
        "--reuse-desc-from",
        default=None,
        help=(
            "Optional path to an existing JSON metadata file whose `description` fields should be reused "
            "by matching parameter name. Useful for keeping Chinese descriptions when SDK source updates."
        ),
    )
    return p.parse_args(argv)


def _load_description_map(path: Path) -> dict[str, str]:
    """
    Load a mapping of field name -> description from a prior metadata JSON file.

    Supports legacy payloads that used `fields` instead of `body_fields`.
    """

    try:
        obj = json.loads(_read_text(path))
    except Exception:
        return {}

    out: dict[str, str] = {}
    for key in ("body_fields", "fields", "request_options"):
        items = obj.get(key)
        if not isinstance(items, list):
            continue
        for it in items:
            if not isinstance(it, dict):
                continue
            name = it.get("name")
            desc = it.get("description")
            if isinstance(name, str) and isinstance(desc, str) and desc.strip():
                out.setdefault(name, desc)
    return out


def main(argv: Optional[list[str]] = None) -> int:
    """Program entrypoint."""

    args = _parse_args(argv)
    openai_pkg_dir = _load_openai_pkg_dir()
    types_file = _find_types_file(openai_pkg_dir)
    src = _read_text(types_file)
    aliases = _collect_all_type_aliases(openai_pkg_dir)
    simplifier = _TypeSimplifier(aliases)
    params_block = _pick_chat_create_params_block(src)
    fields = _extract_fields(params_block)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = _build_payload(fields, sdk_version=args.sdk_version, simplifier=simplifier)

    # Optionally reuse descriptions from a prior metadata file (e.g., a Chinese-translated version).
    if args.reuse_desc_from:
        reuse_map = _load_description_map(Path(args.reuse_desc_from))
        if reuse_map:
            for sec in ("body_fields", "request_options"):
                for f in payload.get(sec, []):
                    if not isinstance(f, dict):
                        continue
                    name = f.get("name")
                    if isinstance(name, str) and name in reuse_map:
                        f["description"] = reuse_map[name]

    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(
        f"Wrote {len(payload['body_fields'])} body fields + {len(payload['request_options'])} request options "
        f"to {out_path} (from {types_file})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


