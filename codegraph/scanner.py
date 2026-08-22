"""
scanner.py — walk a project directory, hash every file, detect what changed.
"""

import os
from pathlib import Path
from typing import Iterator

from .cache import get_cached_nodes_fast, remove_deleted, load_cache
from .config import DEFAULT_IGNORE, MAX_FILE_BYTES, SKIP_FILENAMES, SKIP_EXTENSIONS, classify_file


def _should_ignore(name: str, ignore: set) -> bool:
    return name.startswith(".") and name != ".env" or name in ignore


def walk_files(root: str, extra_ignore: set | None = None) -> Iterator[str]:
    """Yield absolute paths to all non-ignored files under root."""
    ignore = DEFAULT_IGNORE | (extra_ignore or set())
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune ignored dirs in-place so os.walk doesn't descend
        dirnames[:] = [d for d in dirnames if not _should_ignore(d, ignore)]
        for fname in filenames:
            ext = Path(fname).suffix.lower()
            if fname in SKIP_FILENAMES or ext in SKIP_EXTENSIONS:
                continue
            abs_path = os.path.join(dirpath, fname)
            try:
                if os.path.getsize(abs_path) > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            yield abs_path


def scan(project_root: str, extra_ignore: set | None = None) -> dict:
    """
    Walk project, diff against cache.

    Returns:
        {
          "cached":  { rel_path: [nodes] },   # unchanged — load from cache
          "changed": { rel_path: abs_path },  # hash changed — need re-extraction
          "deleted": [rel_path],              # in cache but file gone
          "cache":   dict,                    # current cache (mutated in place)
        }
    """
    root = os.path.abspath(project_root)
    cache = load_cache(root)

    cached = {}
    changed = {}
    existing_rel = set()
    scanned_count = 0

    for abs_path in walk_files(root, extra_ignore):
        rel_path = os.path.relpath(abs_path, root).replace("\\", "/")
        existing_rel.add(rel_path)
        category = classify_file(abs_path)
        if category in ("unknown", "skip"):
            continue
        scanned_count += 1
        nodes = get_cached_nodes_fast(cache, rel_path, abs_path)
        if nodes is not None:
            cached[rel_path] = nodes
        else:
            changed[rel_path] = abs_path

    deleted = remove_deleted(cache, existing_rel)

    return {
        "cached":  cached,
        "changed": changed,
        "deleted": deleted,
        "cache":   cache,
        "root":    root,
        "scanned": scanned_count,
        "cache_hit_rate": (len(cached) / scanned_count if scanned_count else 1.0),
    }
