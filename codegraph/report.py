"""
report.py — generate REPORT.md from the built graph.
"""

from pathlib import Path


def generate(graph_dict: dict, project_root: str) -> str:
    """Write REPORT.md to project_root and return its content."""
    content = _build_report(graph_dict)
    cache_dir = Path(project_root) / "codegraph-cache"
    cache_dir.mkdir(exist_ok=True)
    out = cache_dir / "CODEGRAPH_REPORT.md"
    out.write_text(content, encoding="utf-8")
    return content


def _build_report(g: dict) -> str:
    nodes      = g.get("nodes", [])
    edges      = g.get("edges", [])
    communities = g.get("communities", [])
    god_nodes  = g.get("god_nodes", [])
    generated  = g.get("generated_at", "")

    node_map = {n["id"]: n for n in nodes if "id" in n}

    lines = [
        "# CodeGraph Report",
        f"_Generated: {generated}_",
        "",
        f"**{len(nodes)} nodes** · **{len(edges)} edges** · **{len(communities)} communities**",
        "",
    ]

    # God nodes
    lines += ["## God Nodes", "", "_Highest-degree concepts everything flows through:_", ""]
    if god_nodes:
        for nid in god_nodes:
            n = node_map.get(nid, {})
            name = n.get("name", nid)
            fpath = n.get("file", "")
            deg = sum(1 for e in edges if e.get("from") == nid or e.get("to") == nid)
            lines.append(f"- **{name}** `{fpath}` — {deg} connections")
    else:
        lines.append("_No god nodes identified._")
    lines.append("")

    # Communities
    lines += ["## Community Clusters", ""]
    if communities:
        for c in communities[:10]:
            members = c.get("members", [])
            names = [node_map.get(m, {}).get("name", m) for m in members[:5]]
            cluster_label = c.get("label") or f"Cluster {c['id']}"
            lines.append(f"### {cluster_label} ({len(members)} nodes)")
            lines.append(f"Members: {', '.join(names)}{' …' if len(members) > 5 else ''}")
            lines.append("")
    else:
        lines.append("_No communities detected._")
        lines.append("")

    # Surprising cross-module connections
    lines += ["## Surprising Connections", ""]
    cross = _cross_module_edges(edges, node_map)
    if cross:
        for u_name, v_name, rel in cross[:8]:
            lines.append(f"- **{u_name}** →({rel})→ **{v_name}**")
    else:
        lines.append("_None found._")
    lines.append("")

    # Suggested questions
    lines += ["## Suggested Questions", ""]
    questions = _suggest_questions(nodes, god_nodes, node_map)
    for q in questions:
        lines.append(f"- {q}")
    lines.append("")

    # Confidence breakdown
    conf_counts = {}
    for e in edges:
        c = e.get("confidence", "UNKNOWN")
        conf_counts[c] = conf_counts.get(c, 0) + 1
    lines += ["## Confidence Breakdown", ""]
    for label, count in sorted(conf_counts.items()):
        lines.append(f"- **{label}**: {count} edges")
    lines.append("")

    # Knowledge gaps
    lines += _knowledge_gaps_section(nodes, edges, communities, node_map)

    return "\n".join(lines)


def _knowledge_gaps_section(
    nodes: list, edges: list, communities: list, node_map: dict
) -> list[str]:
    """Identify under-connected areas: isolated nodes, thin communities, ambiguous edges."""
    lines = ["## Knowledge Gaps", ""]

    # Isolated nodes (no edges at all)
    connected_ids: set[str] = set()
    for e in edges:
        connected_ids.add(e.get("from", ""))
        connected_ids.add(e.get("to", ""))
    isolated = [n for n in nodes if n["id"] not in connected_ids]
    if isolated:
        lines.append(f"**Isolated nodes** ({len(isolated)} with no edges):")
        for n in isolated[:8]:
            lines.append(f"  - `{n.get('name', n['id'])}` in `{n.get('file', '?')}`")
        if len(isolated) > 8:
            lines.append(f"  - …and {len(isolated) - 8} more")
    else:
        lines.append("_No isolated nodes._")
    lines.append("")

    # Thin communities (single-node clusters)
    thin = [c for c in communities if len(c.get("members", [])) == 1]
    if thin:
        lines.append(f"**Thin communities** ({len(thin)} single-node clusters):")
        for c in thin[:5]:
            nid = c["members"][0]
            n = node_map.get(nid, {})
            lines.append(f"  - `{n.get('name', nid)}` in `{n.get('file', '?')}`")
        if len(thin) > 5:
            lines.append(f"  - …and {len(thin) - 5} more")
    else:
        lines.append("_No thin communities._")
    lines.append("")

    # High-ambiguity edges
    ambiguous = [e for e in edges if e.get("confidence") == "AMBIGUOUS"]
    if ambiguous and edges:
        pct = round(100 * len(ambiguous) / len(edges), 1)
        lines.append(f"**Ambiguous edges**: {len(ambiguous)} of {len(edges)} ({pct}%) "
                     "have low-confidence resolution — consider adding type annotations.")
    else:
        lines.append("_No ambiguous edges._")
    lines.append("")

    return lines


def _cross_module_edges(edges: list, node_map: dict) -> list[tuple]:
    results = []
    for e in edges:
        u = node_map.get(e.get("from", ""), {})
        v = node_map.get(e.get("to", ""), {})
        u_file = (u.get("file", "") or "").split("/")[0]
        v_file = (v.get("file", "") or "").split("/")[0]
        if u_file and v_file and u_file != v_file:
            results.append((u.get("name", "?"), v.get("name", "?"), e.get("relation", "?")))
    return results[:8]


def _suggest_questions(nodes: list, god_node_ids: list, node_map: dict) -> list[str]:
    questions = []
    if god_node_ids:
        name = node_map.get(god_node_ids[0], {}).get("name", "")
        if name:
            questions.append(f"What does {name} depend on?")
            questions.append(f"What uses {name}?")
    classes = [n for n in nodes if n.get("type") == "class"][:2]
    for c in classes:
        questions.append(f"What is the relationship between {c['name']} and other modules?")
    questions.append("Which files have the most connections?")
    questions.append("Are there any circular dependencies?")
    return questions[:5]
