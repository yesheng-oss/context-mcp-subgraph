"""
build_extractor.py — extract key metadata from build/config files.
Returns a SINGLE node per file (not decomposed into functions/classes).
"""

import json
import re
from pathlib import Path


def extract(abs_path: str, rel_path: str) -> list[dict]:
    """Return a single node for the build file with key fields in description."""
    p    = Path(abs_path)
    name = p.name
    meta = _read_meta(p)

    node = {
        "id":          f"{rel_path}::file::{name}",
        "name":        name,
        "type":        "file",
        "file":        rel_path,
        "description": _format_meta(meta) if meta else None,
    }
    return [node]


def _read_meta(p: Path) -> dict:
    try:
        if p.name == "package.json":
            data = json.loads(p.read_text(encoding="utf-8", errors="ignore"))
            return {
                "name":    data.get("name"),
                "version": data.get("version"),
                "deps":    list((data.get("dependencies") or {}).keys())[:10],
            }
        if p.suffix == ".toml":
            text    = p.read_text(encoding="utf-8", errors="ignore")
            name    = re.search(r'^name\s*=\s*"([^"]+)"', text, re.M)
            version = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
            return {
                "name":    name.group(1) if name else None,
                "version": version.group(1) if version else None,
            }
        if p.name in {"requirements.txt", "Pipfile"}:
            lines = p.read_text(encoding="utf-8", errors="ignore").splitlines()
            deps  = [l.strip() for l in lines if l.strip() and not l.startswith("#")]
            return {"deps": deps[:10]}
        if p.name == "go.mod":
            text   = p.read_text(encoding="utf-8", errors="ignore")
            module = re.search(r'^module\s+(\S+)', text, re.M)
            go_ver = re.search(r'^go\s+(\S+)', text, re.M)
            return {
                "module": module.group(1) if module else None,
                "go":     go_ver.group(1) if go_ver else None,
            }
    except Exception:
        pass
    return {}


def _format_meta(meta: dict) -> str | None:
    parts = []
    if meta.get("name"):    parts.append(f"name={meta['name']}")
    if meta.get("version"): parts.append(f"version={meta['version']}")
    if meta.get("module"):  parts.append(f"module={meta['module']}")
    if meta.get("go"):      parts.append(f"go={meta['go']}")
    if meta.get("deps"):    parts.append(f"deps=[{', '.join(meta['deps'])}]")
    return ", ".join(parts) if parts else None
