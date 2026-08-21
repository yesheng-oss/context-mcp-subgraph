"""
cache.py — SHA-256 file hash cache for codegraph.

Two separate caches:
  codegraph-cache/ast.json      — AST-extracted nodes (overwritten on rebuild)
  codegraph-cache/semantic.json — AI-written descriptions (never overwritten by rebuild)

Format: { "rel/path": { "hash": "...", "nodes": [...], "extracted_at": "..." } }
"""

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path


def _ast_path(project_root: str) -> Path:
    return Path(project_root) / "codegraph-cache" / "ast.json"


def _semantic_path(project_root: str) -> Path:
    return Path(project_root) / "codegraph-cache" / "semantic.json"


def _read(p: Path) -> dict:
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write(p: Path, data: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(p)


def load_cache(project_root: str) -> dict:
    """Load merged view: AST base + semantic descriptions overlaid."""
    ast = _read(_ast_path(project_root))
    sem = _read(_semantic_path(project_root))

    merged = {}
    all_keys = set(ast) | set(sem)
    for key in all_keys:
        ast_entry = ast.get(key, {})
        sem_entry = sem.get(key, {})

        # Use AST hash for change detection (source of truth)
        merged[key] = {
            "hash":         ast_entry.get("hash", sem_entry.get("hash", "")),
            "nodes":        _merge_nodes(ast_entry.get("nodes", []), sem_entry.get("nodes", [])),
            "extracted_at": ast_entry.get("extracted_at", sem_entry.get("extracted_at", "")),
        }
    return merged


def _merge_nodes(ast_nodes: list, sem_nodes: list) -> list:
    """Overlay semantic descriptions onto AST nodes by name."""
    sem_by_name = {n.get("name"): n for n in sem_nodes if n.get("name")}
    result = []
    for n in ast_nodes:
        name = n.get("name")
        if name and name in sem_by_name:
            merged = dict(n)
            sem_desc = sem_by_name[name].get("description", "")
            if sem_desc:
                merged["description"] = sem_desc
            result.append(merged)
        else:
            result.append(n)
    # Append semantic-only nodes (from doc files) not in AST
    ast_names = {n.get("name") for n in ast_nodes}
    for n in sem_nodes:
        if n.get("name") not in ast_names:
            result.append(n)
    return result


def save_cache(project_root: str, cache: dict) -> None:
    """Write back to AST cache only (used by build pipeline)."""
    _write(_ast_path(project_root), cache)


def save_semantic_cache(project_root: str, updates: dict[str, list]) -> None:
    """
    Persist AI-written descriptions into semantic cache.
    updates: { rel_path: [nodes_with_descriptions] }
    Never touched by rebuild — descriptions survive file changes.
    """
    sem = _read(_semantic_path(project_root))
    for rel_path, nodes in updates.items():
        existing = {n.get("name"): n for n in sem.get(rel_path, {}).get("nodes", [])}
        for n in nodes:
            name = n.get("name")
            if name:
                existing[name] = {**existing.get(name, {}), **{k: v for k, v in n.items() if v}}
        sem[rel_path] = {
            "nodes":        list(existing.values()),
            "extracted_at": datetime.now(timezone.utc).isoformat(),
        }
    _write(_semantic_path(project_root), sem)


def file_hash(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def stat_hit(path: str, cache_entry: dict) -> bool:
    """Return True if (size, mtime_ns) matches the cached stat — skips SHA-256."""
    cached_stat = cache_entry.get("stat")
    if not cached_stat:
        return False
    try:
        s = os.stat(path)
        return cached_stat == [s.st_size, s.st_mtime_ns]
    except OSError:
        return False


def get_cached_nodes(cache: dict, rel_path: str, current_hash: str) -> list | None:
    """Return cached nodes if hash matches, else None."""
    entry = cache.get(rel_path)
    if entry and entry.get("hash") == current_hash:
        return entry.get("nodes", [])
    return None


def get_cached_nodes_fast(cache: dict, rel_path: str, abs_path: str) -> list | None:
    """Return cached nodes using stat fastpath, falling back to SHA-256 check.

    Avoids reading and hashing large files on incremental rebuilds where
    the file hasn't changed — (size, mtime_ns) is checked first.
    Returns None if the file is new or has changed.
    """
    entry = cache.get(rel_path)
    if not entry:
        return None
    # Fast path: stat match skips SHA-256
    if stat_hit(abs_path, entry):
        return entry.get("nodes", [])
    # Slow path: full hash check
    try:
        h = file_hash(abs_path)
    except OSError:
        return None
    if entry.get("hash") == h:
        # Update stat so next call is fast
        try:
            s = os.stat(abs_path)
            entry["stat"] = [s.st_size, s.st_mtime_ns]
        except OSError:
            pass
        return entry.get("nodes", [])
    return None


def set_cached_nodes(cache: dict, rel_path: str, file_hash_val: str, nodes: list, abs_path: str | None = None) -> None:
    entry: dict = {
        "hash":         file_hash_val,
        "nodes":        nodes,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
    }
    if abs_path:
        try:
            s = os.stat(abs_path)
            entry["stat"] = [s.st_size, s.st_mtime_ns]
        except OSError:
            pass
    cache[rel_path] = entry


def remove_deleted(cache: dict, existing_rel_paths: set) -> list:
    """Remove cache entries for files that no longer exist. Returns removed keys."""
    removed = [k for k in list(cache.keys()) if k not in existing_rel_paths]
    for k in removed:
        del cache[k]
    return removed
