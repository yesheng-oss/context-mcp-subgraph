"""
graph/builder.py — build a NetworkX directed graph from extracted nodes.

Node attributes: id, name, type, file, line, community
Edge attributes: relation, confidence (EXTRACTED | INFERRED | AMBIGUOUS)
"""

import json
from pathlib import Path

try:
    import networkx as nx
    _HAS_NX = True
except ImportError:
    _HAS_NX = False


def build(all_nodes: list[dict]) -> "nx.DiGraph | dict":
    """
    Build graph from flat node list. Returns nx.DiGraph or plain dict fallback.
    Edges are created from node.imports[] and node.calls[] fields.
    """
    if not _HAS_NX:
        return _dict_graph(all_nodes)

    G = nx.DiGraph()

    _name_to_ids: dict[str, list[str]] = {}  # name -> [ids] (may be multiple)
    file_rep: dict[str, str] = {}            # rel_path -> representative node id (module > file > first)
    file_imports: dict[str, list[str]] = {}  # rel_path -> aggregated import names

    for node in all_nodes:
        nid = node.get("id", "")
        if not nid:
            continue
        G.add_node(nid, **{k: v for k, v in node.items() if k not in ("imports", "calls", "relations")})
        name = node.get("name", "")
        if name:
            _name_to_ids.setdefault(name, []).append(nid)
        # Track a representative node per file (prefer module, then file, then first seen)
        frel = node.get("file", "")
        ntype = node.get("type", "")
        if frel and (frel not in file_rep or ntype in ("module", "file")):
            file_rep[frel] = nid
        # Aggregate imports per file from any node type
        for imp in node.get("imports", []):
            lst = file_imports.setdefault(frel, [])
            if imp not in lst:
                lst.append(imp)

    # Unambiguous name→id map: only include names that resolve to exactly one node
    node_by_name: dict[str, str] = {n: ids[0] for n, ids in _name_to_ids.items() if len(ids) == 1}

    # Build file-path lookup from all file/module representative nodes
    file_node: dict[str, str] = {}
    for rel_path, rep_id in file_rep.items():
        p = rel_path.replace("\\", "/")
        stem = p.split("/")[-1].split(".")[0]
        base = p.split("/")[-1]
        for key in (stem, base, p):
            file_node.setdefault(key, rep_id)

    # Import edges: file → file (aggregated from all node types per file)
    seen_edges: set[tuple] = set()
    for frel, imports in file_imports.items():
        src_id = file_rep.get(frel)
        if not src_id:
            continue
        for imp in imports:
            clean = imp.lstrip(".")
            parts = clean.replace("\\", "/").split("/")
            last  = parts[-1]
            stem  = last.split(".")[0]
            for c in (clean, last, stem):
                if not c:
                    continue
                target = file_node.get(c) or node_by_name.get(c)
                if target and target != src_id:
                    key = (src_id, target)
                    if key not in seen_edges:
                        seen_edges.add(key)
                        G.add_edge(src_id, target, relation="imports", confidence="EXTRACTED")
                    break

    # Edges from explicit relations (concept nodes from LLM)
    for node in all_nodes:
        nid = node.get("id", "")
        for rel in node.get("relations", []):
            target_id = rel.get("id") or node_by_name.get(rel.get("name", ""))
            if target_id and target_id != nid:
                G.add_edge(nid, target_id,
                           relation=rel.get("relation", "relates-to"),
                           confidence=rel.get("confidence", "INFERRED"))

    # Resolve unresolved call targets from node['calls'] lists
    try:
        from codegraph.graph.symbol_resolution import resolve_calls
        existing_keys = {(u, v) for u, v in G.edges()}
        new_edges = resolve_calls(all_nodes, existing_keys)
        for e in new_edges:
            G.add_edge(e["from"], e["to"], relation=e["relation"], confidence=e["confidence"])
    except Exception:
        pass

    # Inheritance and implements edges (from enriched nodes)
    for node in all_nodes:
        nid = node.get("id", "")
        if not nid:
            continue
        for parent_name in node.get("inherits", []):
            target = node_by_name.get(parent_name)
            if target and target != nid:
                key = (nid, target)
                if key not in seen_edges:
                    seen_edges.add(key)
                    G.add_edge(nid, target, relation="inherits", confidence="EXTRACTED")
        for iface_name in node.get("implements", []):
            target = node_by_name.get(iface_name)
            if target and target != nid:
                key = (nid, target)
                if key not in seen_edges:
                    seen_edges.add(key)
                    G.add_edge(nid, target, relation="implements", confidence="EXTRACTED")

    return G


def _dict_graph(all_nodes: list[dict]) -> dict:
    """Fallback when networkx not installed."""
    nodes = []
    edges = []
    seen = set()
    for node in all_nodes:
        nid = node.get("id", "")
        if nid in seen:
            continue
        seen.add(nid)
        nodes.append({k: v for k, v in node.items() if k not in ("imports", "calls", "relations")})
        for imp in node.get("imports", []):
            edges.append({"from": nid, "to": imp, "relation": "imports", "confidence": "EXTRACTED"})
    return {"nodes": nodes, "edges": edges, "communities": [], "god_nodes": []}


def to_json_dict(G) -> dict:
    """Serialize graph to the graph.json schema."""
    if isinstance(G, dict):
        return G  # fallback path

    nodes = [{"id": nid, **data} for nid, data in G.nodes(data=True)]
    edges = [{"from": u, "to": v, **data} for u, v, data in G.edges(data=True)]

    # God nodes = highest degree
    degrees = sorted(G.degree(), key=lambda x: x[1], reverse=True)
    god_nodes = [n for n, d in degrees[:5] if d > 2]

    return {
        "nodes": nodes,
        "edges": edges,
        "communities": G.graph.get("communities", []),
        "god_nodes": god_nodes,
        "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }


def save_graph(project_root: str, graph_dict: dict) -> str:
    out = Path(project_root) / "codegraph-cache" / "graph.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(graph_dict, indent=2), encoding="utf-8")
    return str(out)


def load_graph(project_root: str) -> dict | None:
    p = Path(project_root) / "codegraph-cache" / "graph.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
