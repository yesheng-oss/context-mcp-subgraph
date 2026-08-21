"""
affected.py — "what breaks if I change X?" BFS over the knowledge graph.

Ported from graphify's affected.py with field name adaptations:
  graphify uses 'label' / 'source_file' / 'source_location'
  context-mcp uses 'name' / 'file' / 'line'
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Iterable

import networkx as nx


DEFAULT_AFFECTED_RELATIONS = (
    "calls",
    "references",
    "imports",
    "imports_from",
    "re_exports",
    "inherits",
    "extends",
    "implements",
    "uses",
    "mixes_in",
    "embeds",
)


@dataclass(frozen=True)
class AffectedHit:
    node_id: str
    depth: int
    via_relation: str


# ── Graph loading ─────────────────────────────────────────────────────────────

def graph_from_dict(graph_dict: dict) -> nx.DiGraph:
    """Reconstruct nx.DiGraph from our graph.json dict format (edges use 'from'/'to')."""
    G = nx.DiGraph()
    for node in graph_dict.get("nodes", []):
        nid = node.get("id", "")
        if nid:
            G.add_node(nid, **{k: v for k, v in node.items() if k != "id"})
    for edge in graph_dict.get("edges", []):
        src = edge.get("from", "")
        tgt = edge.get("to", "")
        if src and tgt:
            G.add_edge(src, tgt, **{k: v for k, v in edge.items() if k not in ("from", "to")})
    return G


# ── Node helpers ──────────────────────────────────────────────────────────────

def _node_label(graph: nx.Graph, node_id: str) -> str:
    data = graph.nodes[node_id]
    return str(data.get("name") or node_id)


def _format_location(data: dict) -> str:
    source_file = data.get("file") or "-"
    line = data.get("line")
    if line:
        return f"{source_file}:{line}"
    return str(source_file)


def _bare_name(label: str) -> str:
    label = label.lower()
    return label[:-2] if label.endswith("()") else label


# ── Seed resolution ───────────────────────────────────────────────────────────

def resolve_seed(graph: nx.Graph, query: str) -> str | None:
    """Find the node ID that best matches the query string.

    Resolution order: exact ID → exact name → bare name (strips "()")
    → exact file path → contains match.
    """
    if query in graph:
        return query
    query_lower = query.lower()
    exact_name_matches = [
        str(node_id)
        for node_id, data in graph.nodes(data=True)
        if str(data.get("name", "")).lower() == query_lower
    ]
    if len(exact_name_matches) == 1:
        return exact_name_matches[0]

    query_bare = _bare_name(query_lower)
    bare_matches = [
        str(node_id)
        for node_id, data in graph.nodes(data=True)
        if _bare_name(str(data.get("name", ""))) == query_bare
    ]
    if len(bare_matches) == 1:
        return bare_matches[0]

    exact_file_matches = [
        str(node_id)
        for node_id, data in graph.nodes(data=True)
        if str(data.get("file", "")).lower() == query_lower
    ]
    if len(exact_file_matches) == 1:
        return exact_file_matches[0]

    contains_matches = [
        str(node_id)
        for node_id, data in graph.nodes(data=True)
        if query_lower in str(data.get("name", "")).lower()
    ]
    if len(contains_matches) == 1:
        return contains_matches[0]
    return None


# ── BFS traversal ─────────────────────────────────────────────────────────────

def affected_nodes(
    graph: nx.Graph,
    seed: str,
    *,
    relations: Iterable[str] = DEFAULT_AFFECTED_RELATIONS,
    depth: int = 2,
) -> list[AffectedHit]:
    """BFS from seed following incoming edges whose relation is in `relations`.

    Returns nodes that would be affected by a change to the seed node.
    """
    relation_set = set(relations)
    seen = {seed}
    queue: deque[tuple[str, int]] = deque([(seed, 0)])
    hits: list[AffectedHit] = []

    while queue:
        current, current_depth = queue.popleft()
        if current_depth >= depth:
            continue
        if hasattr(graph, "in_edges"):
            incoming = graph.in_edges(current, data=True)
        else:
            incoming = (
                (source, target, data)
                for source, target, data in graph.edges(data=True)
                if target == current
            )
        for source, _target, data in incoming:
            relation = str(data.get("relation", ""))
            if relation not in relation_set:
                continue
            source = str(source)
            if source in seen:
                continue
            seen.add(source)
            hits.append(AffectedHit(source, current_depth + 1, relation))
            queue.append((source, current_depth + 1))

    return hits


# ── Formatted output ──────────────────────────────────────────────────────────

def format_affected(
    graph: nx.Graph,
    query: str,
    *,
    relations: Iterable[str] = DEFAULT_AFFECTED_RELATIONS,
    depth: int = 2,
) -> str:
    """Return a human-readable summary of nodes affected by changing `query`."""
    relation_list = tuple(relations)
    seed = resolve_seed(graph, query)
    if seed is None:
        return f"No unique node match for '{query}'"

    hits = affected_nodes(graph, seed, relations=relation_list, depth=depth)
    lines = [
        f"Affected nodes for: {_node_label(graph, seed)}",
        f"Relations tracked: {', '.join(relation_list)}",
        f"Depth: {depth}",
        "",
    ]
    if not hits:
        lines.append("No affected nodes found.")
        return "\n".join(lines)

    for hit in hits:
        data = graph.nodes[hit.node_id]
        lines.append(
            f"  depth={hit.depth}  [{hit.via_relation}]  "
            f"{_node_label(graph, hit.node_id)}  @ {_format_location(data)}"
        )
    return "\n".join(lines)


# ── Convenience entry point ───────────────────────────────────────────────────

def run_affected(graph_dict: dict, query: str, depth: int = 2) -> dict:
    """Run affected analysis from a graph.json dict. Returns structured result."""
    G = graph_from_dict(graph_dict)
    seed = resolve_seed(G, query)
    if seed is None:
        return {"query": query, "seed": None, "hits": [], "text": f"No unique node match for '{query}'"}

    hits = affected_nodes(G, seed, depth=depth)
    seed_data = G.nodes[seed]

    hit_list = []
    for hit in hits:
        data = G.nodes.get(hit.node_id, {})
        hit_list.append({
            "node_id":      hit.node_id,
            "name":         data.get("name", hit.node_id),
            "file":         data.get("file", ""),
            "line":         data.get("line"),
            "depth":        hit.depth,
            "via_relation": hit.via_relation,
        })

    return {
        "query":   query,
        "seed":    seed,
        "seed_name": seed_data.get("name", seed),
        "seed_file": seed_data.get("file", ""),
        "depth":   depth,
        "hits":    hit_list,
        "text":    format_affected(G, query, depth=depth),
    }
