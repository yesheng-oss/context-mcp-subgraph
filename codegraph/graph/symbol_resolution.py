"""
graph/symbol_resolution.py — cross-file call edge resolution.

Resolves unresolved callee names in node['calls'] to actual node IDs,
creating 'calls' edges with INFERRED confidence where a unique match exists.

Our nodes use 'name'/'file' (graphify uses 'label'/'source_file').
"""
from __future__ import annotations

from pathlib import Path


def build_name_index(all_nodes: list[dict]) -> dict[str, list[str]]:
    """Map symbol name → [node_ids] for function/class/struct nodes."""
    index: dict[str, list[str]] = {}
    callable_types = {"function", "method", "class", "struct", "interface", "trait"}
    for node in all_nodes:
        if node.get("type") in callable_types:
            name = node.get("name", "")
            nid = node.get("id", "")
            if name and nid:
                index.setdefault(name, []).append(nid)
    return index


def build_module_name_index(all_nodes: list[dict]) -> dict[tuple[str, str], list[str]]:
    """Map (module_stem, symbol_name) → [node_ids] for scoped resolution."""
    index: dict[tuple[str, str], list[str]] = {}
    callable_types = {"function", "method", "class", "struct", "interface", "trait"}
    for node in all_nodes:
        if node.get("type") in callable_types:
            name = node.get("name", "")
            nid = node.get("id", "")
            file_path = node.get("file", "")
            if name and nid and file_path:
                stem = Path(file_path.replace("\\", "/")).stem
                index.setdefault((stem, name), []).append(nid)
    return index


def resolve_calls(
    all_nodes: list[dict],
    existing_edge_keys: set[tuple[str, str]],
) -> list[dict]:
    """Resolve node['calls'] lists to graph edges.

    For each node that declares `calls: ["FunctionName", ...]`, look up the
    name in the global index. Only emit an edge when the name resolves
    uniquely (avoids false positives for common names like 'get' or 'init').

    Returns a list of new edge dicts {from, to, relation, confidence}.
    """
    name_index = build_name_index(all_nodes)
    module_index = build_module_name_index(all_nodes)

    new_edges: list[dict] = []

    for node in all_nodes:
        caller_id = node.get("id", "")
        if not caller_id:
            continue
        calls = node.get("calls", [])
        if not calls:
            continue

        caller_file = node.get("file", "")
        # Try module-scoped resolution first (same file prefix → higher confidence)
        imports = node.get("imports", [])
        imported_stems = set()
        for imp in imports:
            clean = imp.lstrip(".").replace("\\", "/")
            stem = Path(clean).stem
            if stem:
                imported_stems.add(stem)

        for callee_name in calls:
            if not isinstance(callee_name, str) or not callee_name:
                continue

            target_ids: list[str] = []
            via_import = False

            # 1. Try (imported_module_stem, callee_name) for import-guided resolution
            for stem in imported_stems:
                candidates = module_index.get((stem, callee_name), [])
                target_ids.extend(candidates)
            if target_ids:
                via_import = True

            # 2. Fall back to global unique name match
            if not target_ids:
                target_ids = name_index.get(callee_name, [])

            # Resolve ambiguity: prefer match in same directory as caller
            if len(target_ids) == 0:
                continue
            if len(target_ids) > 1:
                caller_dir = str(Path(caller_file.replace("\\", "/")).parent)
                same_dir = [t for t in target_ids
                            if t.replace("\\", "/").startswith(caller_dir + "/")]
                if len(same_dir) == 1:
                    target_ids = same_dir
                else:
                    continue  # still ambiguous after narrowing

            target_id = target_ids[0]
            if target_id == caller_id:
                continue  # skip self-calls
            key = (caller_id, target_id)
            if key in existing_edge_keys:
                continue

            existing_edge_keys.add(key)
            confidence = "EXTRACTED" if via_import else "INFERRED"
            new_edges.append({
                "from":       caller_id,
                "to":         target_id,
                "relation":   "calls",
                "confidence": confidence,
            })

    return new_edges
