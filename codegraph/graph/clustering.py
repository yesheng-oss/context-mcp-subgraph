"""
graph/clustering.py — community detection using Leiden (graspologic) with Louvain fallback.

Replaces naive connected-components with production-grade algorithm:
  - Hub exclusion before partitioning
  - Oversized community splitting (>25% of graph)
  - Low-cohesion re-splitting
  - Stable IDs via size-desc lexical sort + previous-run remap
"""
from __future__ import annotations

import contextlib
import inspect
import io
import json
import sys

import networkx as nx


# ── Low-level partitioner ────────────────────────────────────────────────────

def _suppress_output():
    return contextlib.redirect_stdout(io.StringIO())


def _partition(G: nx.Graph, resolution: float = 1.0) -> dict[str, int]:
    """Run community detection. Returns {node_id: community_id}.

    Tries Leiden (graspologic) first, falls back to Louvain (networkx).
    Output is deterministic via sorted nodes/edges and seed=42.
    """
    stable = nx.Graph()
    stable.add_nodes_from(sorted(G.nodes(), key=str))
    edge_rows = sorted(
        G.edges(data=True),
        key=lambda row: (
            str(row[0]),
            str(row[1]),
            json.dumps(row[2], sort_keys=True, ensure_ascii=False, default=str),
        ),
    )
    for src, tgt, attrs in edge_rows:
        stable.add_edge(src, tgt, **attrs)

    try:
        from graspologic.partition import leiden
        lsig = inspect.signature(leiden).parameters
        kwargs: dict = {}
        if "random_seed" in lsig:
            kwargs["random_seed"] = 42
        if "trials" in lsig:
            kwargs["trials"] = 1
        if "resolution" in lsig:
            kwargs["resolution"] = resolution
        old_stderr = sys.stderr
        try:
            sys.stderr = io.StringIO()
            with _suppress_output():
                result = leiden(stable, **kwargs)
        finally:
            sys.stderr = old_stderr
        return result
    except ImportError:
        pass

    louvain_sig = inspect.signature(nx.community.louvain_communities).parameters
    kwargs = {"seed": 42, "resolution": resolution}
    if "max_level" in louvain_sig:
        kwargs["max_level"] = 10
    communities = nx.community.louvain_communities(stable, **kwargs)
    return {node: cid for cid, nodes in enumerate(communities) for node in nodes}


# ── Constants ────────────────────────────────────────────────────────────────

_MAX_COMMUNITY_FRACTION = 0.25
_MIN_SPLIT_SIZE = 10
_COHESION_SPLIT_THRESHOLD = 0.05
_COHESION_SPLIT_MIN_SIZE = 50


# ── Public API ───────────────────────────────────────────────────────────────

def cluster(
    G: nx.Graph,
    resolution: float = 1.0,
    exclude_hubs_percentile: float | None = None,
) -> dict[int, list[str]]:
    """Run Leiden community detection. Returns {community_id: [node_ids]}.

    Community IDs are stable: 0 = largest community.
    Oversized communities (>25% of nodes, min 10) are split by a second pass.
    """
    if G.number_of_nodes() == 0:
        return {}
    if G.is_directed():
        G = G.to_undirected()
    if G.number_of_edges() == 0:
        return {i: [n] for i, n in enumerate(sorted(G.nodes))}

    hub_nodes: set[str] = set()
    if exclude_hubs_percentile is not None:
        degrees = sorted(d for _, d in G.degree())
        if degrees:
            # idx is the last position we keep; nodes beyond this are hubs
            idx = min(len(degrees) - 1, int(len(degrees) * exclude_hubs_percentile / 100))
            threshold = degrees[idx]
            hub_nodes = {n for n, d in G.degree() if d > threshold}

    excluded = hub_nodes
    isolates = [n for n in G.nodes() if G.degree(n) == 0 and n not in excluded]
    connected_nodes = [n for n in G.nodes() if G.degree(n) > 0 and n not in excluded]
    connected = G.subgraph(connected_nodes)

    raw: dict[int, list[str]] = {}
    if connected.number_of_nodes() > 0:
        partition = _partition(connected, resolution=resolution)
        for node, cid in partition.items():
            raw.setdefault(cid, []).append(node)

    next_cid = max(raw.keys(), default=-1) + 1
    for node in isolates:
        raw[next_cid] = [node]
        next_cid += 1

    if hub_nodes:
        node_community: dict[str, int] = {n: cid for cid, nodes in raw.items() for n in nodes}
        for hub in sorted(hub_nodes):
            votes: dict[int, int] = {}
            for nb in G.neighbors(hub):
                cid = node_community.get(nb)
                if cid is not None:
                    votes[cid] = votes.get(cid, 0) + 1
            if votes:
                best = min(votes, key=lambda c: (-votes[c], c))
                raw.setdefault(best, []).append(hub)
                node_community[hub] = best
            else:
                raw[next_cid] = [hub]
                node_community[hub] = next_cid
                next_cid += 1

    max_size = max(_MIN_SPLIT_SIZE, int(G.number_of_nodes() * _MAX_COMMUNITY_FRACTION))
    final_communities: list[list[str]] = []
    for nodes in raw.values():
        if len(nodes) > max_size:
            final_communities.extend(_split_community(G, nodes))
        else:
            final_communities.append(nodes)

    second_pass: list[list[str]] = []
    for nodes in final_communities:
        if len(nodes) >= _COHESION_SPLIT_MIN_SIZE and cohesion_score(G, nodes) < _COHESION_SPLIT_THRESHOLD:
            splits = _split_community(G, nodes)
            second_pass.extend(splits if len(splits) > 1 else [nodes])
        else:
            second_pass.append(nodes)
    final_communities = second_pass

    final_communities.sort(key=lambda nodes: (-len(nodes), tuple(sorted(map(str, nodes)))))
    return {i: sorted(nodes) for i, nodes in enumerate(final_communities)}


def _split_community(G: nx.Graph, nodes: list[str]) -> list[list[str]]:
    subgraph = G.subgraph(nodes)
    if subgraph.number_of_edges() == 0:
        return [[n] for n in sorted(nodes)]
    try:
        sub_partition = _partition(subgraph)
        sub_communities: dict[int, list[str]] = {}
        for node, cid in sub_partition.items():
            sub_communities.setdefault(cid, []).append(node)
        if len(sub_communities) <= 1:
            return [sorted(nodes)]
        return [sorted(v) for v in sub_communities.values()]
    except Exception:
        return [sorted(nodes)]


def cohesion_score(G: nx.Graph, community_nodes: list[str]) -> float:
    """Ratio of actual intra-community edges to maximum possible."""
    n = len(community_nodes)
    if n <= 1:
        return 1.0
    subgraph = G.subgraph(community_nodes)
    actual = subgraph.number_of_edges()
    possible = n * (n - 1) / 2
    return actual / possible if possible > 0 else 0.0


def remap_communities_to_previous(
    communities: dict[int, list[str]],
    previous_node_community: dict[str, int],
) -> dict[int, list[str]]:
    """Remap community IDs to maximize overlap with a previous run (stable IDs)."""
    if not communities:
        return {}
    new_sets = {cid: set(nodes) for cid, nodes in communities.items()}
    old_sets: dict[int, set[str]] = {}
    for node, old_cid in previous_node_community.items():
        old_sets.setdefault(old_cid, set()).add(node)

    overlaps: list[tuple[int, int, int]] = []
    for old_cid, old_nodes in old_sets.items():
        for new_cid, new_nodes in new_sets.items():
            overlap = len(old_nodes & new_nodes)
            if overlap > 0:
                overlaps.append((overlap, old_cid, new_cid))
    overlaps.sort(key=lambda x: (-x[0], x[1], x[2]))

    new_to_final: dict[int, int] = {}
    used_old_ids: set[int] = set()
    matched_new_ids: set[int] = set()
    for _overlap, old_cid, new_cid in overlaps:
        if old_cid in used_old_ids or new_cid in matched_new_ids:
            continue
        new_to_final[new_cid] = old_cid
        used_old_ids.add(old_cid)
        matched_new_ids.add(new_cid)

    unmatched = [cid for cid in communities if cid not in matched_new_ids]
    unmatched.sort(key=lambda cid: (-len(communities[cid]), tuple(sorted(communities[cid]))))
    next_id = 0
    for new_cid in unmatched:
        while next_id in used_old_ids:
            next_id += 1
        new_to_final[new_cid] = next_id
        used_old_ids.add(next_id)
        next_id += 1

    remapped: dict[int, list[str]] = {}
    for new_cid, nodes in communities.items():
        remapped[new_to_final[new_cid]] = sorted(nodes)
    return dict(sorted(remapped.items()))


# ── Public wrapper maintaining the existing detect_communities() API ──────────

def detect_communities(G) -> list[dict]:
    """Assign community IDs to graph nodes. Returns list of community dicts.

    Wraps cluster() so callers don't need to change. Falls back to connected
    components if networkx community detection is unavailable.
    """
    if G.number_of_nodes() == 0:
        return []

    try:
        comm_map = cluster(G)
    except Exception:
        # Final fallback: connected components (original behaviour)
        undirected = G.to_undirected()
        comm_map = {}
        for cid, component in enumerate(nx.connected_components(undirected)):
            comm_map[cid] = sorted(component)

    communities = []
    for comm_id, member_ids in comm_map.items():
        label = _community_label(G, member_ids)
        communities.append({"id": comm_id, "label": label, "members": member_ids})
        for nid in member_ids:
            if G.has_node(nid):
                G.nodes[nid]["community"] = comm_id

    G.graph["communities"] = communities

    # PageRank centrality — stored as node.rank (float 0-1)
    try:
        ranks = _pagerank(G)
        for nid, rank_val in ranks.items():
            G.nodes[nid]["rank"] = round(rank_val, 6)
    except Exception:
        uniform = 1.0 / max(G.number_of_nodes(), 1)
        for nid in G.nodes():
            G.nodes[nid]["rank"] = uniform

    return communities


def _pagerank(G, alpha: float = 0.85, max_iter: int = 200, tol: float = 1e-6) -> dict:
    """Pure-Python power-iteration PageRank. No scipy/numpy required."""
    nodes = list(G.nodes())
    n = len(nodes)
    if n == 0:
        return {}
    rank = {node: 1.0 / n for node in nodes}
    for _ in range(max_iter):
        dangling = sum(rank[node] for node in nodes if G.out_degree(node) == 0)
        new_rank = {}
        for node in nodes:
            incoming = sum(rank[pred] / G.out_degree(pred) for pred in G.predecessors(node))
            new_rank[node] = (1 - alpha) / n + alpha * (incoming + dangling / n)
        if sum(abs(new_rank[node] - rank[node]) for node in nodes) < tol * n:
            return new_rank
        rank = new_rank
    return rank


def _community_label(G, member_ids: list) -> str:
    files = []
    for nid in member_ids:
        if G.has_node(nid):
            f = G.nodes[nid].get("file", "")
            if f:
                files.append(f.replace("\\", "/").split("/")[0])
    if not files:
        return "misc"
    return max(set(files), key=files.count)
