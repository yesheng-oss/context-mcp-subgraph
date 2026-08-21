"""
callflow_html.py — Mermaid architecture flowcharts from graph.json communities.

Generates a dark-themed, self-contained HTML with:
  - Overview architecture diagram (community-level)
  - Per-community flowcharts showing key call/import edges
  - Navigation bar
  - Call detail tables
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from html import escape
from pathlib import Path


# ── CSS (dark theme) ──────────────────────────────────────────────────────────

_CSS = """:root {
  --bg:#0f172a;--surface:#1e293b;--border:#334155;
  --text:#e2e8f0;--muted:#94a3b8;--accent:#38bdf8;
  --warn:#fbbf24;--ok:#34d399;
}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.7;}
.container{max-width:1200px;margin:0 auto;padding:40px 24px;}
h1{font-size:2.4rem;margin-bottom:8px;background:linear-gradient(135deg,var(--accent),#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
h2{font-size:1.7rem;margin:48px 0 16px;padding-bottom:8px;border-bottom:2px solid var(--accent);}
h3{font-size:1.25rem;margin:32px 0 12px;color:var(--accent);}
p{margin:8px 0;color:var(--muted);}
.subtitle{color:var(--muted);font-size:1.1rem;margin-bottom:32px;}
.mermaid{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;margin:20px 0;overflow-x:auto;}
.call-table{width:100%;border-collapse:collapse;margin:16px 0;font-size:.92rem;}
.call-table th{background:#1a2744;color:var(--accent);text-align:left;padding:10px 14px;border:1px solid var(--border);}
.call-table td{padding:8px 14px;border:1px solid var(--border);vertical-align:top;}
.call-table tr:nth-child(even){background:rgba(255,255,255,.02);}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;margin:16px 0;}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;margin:16px 0;}
code{font-family:'Fira Code',monospace;background:rgba(255,255,255,.06);padding:1px 6px;border-radius:3px;font-size:.88em;}
ul{margin:8px 0 8px 24px;color:var(--muted);}
li{margin:4px 0;}
a{color:var(--accent);}
hr{border:none;border-top:1px solid var(--border);margin:40px 0;}
.nav{position:sticky;top:0;background:var(--bg);z-index:10;padding:12px 0;border-bottom:1px solid var(--border);display:flex;gap:20px;flex-wrap:wrap;font-size:.9rem;}
.nav a{text-decoration:none;}
.nav a:hover{text-decoration:underline;}
"""


# ── Mermaid helpers ───────────────────────────────────────────────────────────

def _mermaid_id(s: str) -> str:
    """Sanitize for Mermaid node ID; include hash suffix to prevent collisions."""
    sanitized = re.sub(r"[^a-zA-Z0-9_]", "_", s)[:32] or "node"
    h = format(hash(s) & 0xFFFF, "04x")
    return f"{sanitized}_{h}"


def _mermaid_label(s: str) -> str:
    return s.replace('"', "'")[:60]


# ── Overview diagram: community meta-graph ────────────────────────────────────

def _overview_diagram(communities: list[dict], edges: list[dict], node_map: dict[str, dict]) -> str:
    """Mermaid flowchart showing cross-community edges."""
    node_community: dict[str, int] = {}
    for c in communities:
        for mid in c.get("members", []):
            node_community[mid] = c["id"]

    cross_counts: dict[tuple[int, int], int] = defaultdict(int)
    for e in edges:
        src_comm = node_community.get(e.get("from", ""))
        tgt_comm = node_community.get(e.get("to", ""))
        if src_comm is not None and tgt_comm is not None and src_comm != tgt_comm:
            key = (src_comm, tgt_comm)
            cross_counts[key] += 1

    lines = ["flowchart LR"]
    for c in communities:
        cid = c["id"]
        label = _mermaid_label(c.get("label", f"Community {cid}"))
        n = len(c.get("members", []))
        mid = _mermaid_id(f"c{cid}")
        lines.append(f'  {mid}["{label}\\n({n} nodes)"]')

    top_cross = sorted(cross_counts.items(), key=lambda x: -x[1])[:30]
    for (src_c, tgt_c), cnt in top_cross:
        src_mid = _mermaid_id(f"c{src_c}")
        tgt_mid = _mermaid_id(f"c{tgt_c}")
        lines.append(f"  {src_mid} -->|{cnt}| {tgt_mid}")

    return "\n".join(lines)


# ── Per-community diagram ─────────────────────────────────────────────────────

def _community_diagram(community: dict, edges: list[dict], node_map: dict[str, dict], max_nodes: int = 15) -> str:
    """Mermaid flowchart for a single community's internal call edges."""
    members = set(community.get("members", []))
    member_nodes = [node_map[m] for m in members if m in node_map]

    # Pick top nodes by internal degree
    internal_degree: dict[str, int] = defaultdict(int)
    intra_edges = []
    for e in edges:
        src, tgt = e.get("from", ""), e.get("to", "")
        if src in members and tgt in members:
            intra_edges.append(e)
            internal_degree[src] += 1
            internal_degree[tgt] += 1

    top_nodes = sorted(members, key=lambda n: -internal_degree.get(n, 0))[:max_nodes]
    top_set = set(top_nodes)

    lines = ["flowchart LR"]
    for nid in top_nodes:
        n = node_map.get(nid, {})
        name = _mermaid_label(n.get("name", nid))
        ntype = n.get("type", "")
        shape_open, shape_close = "[", "]"
        if ntype == "class":
            shape_open, shape_close = "([", "])"
        elif ntype in ("function", "method"):
            shape_open, shape_close = "(", ")"
        mid = _mermaid_id(nid)
        lines.append(f'  {mid}{shape_open}"{name}"{shape_close}')

    shown_edges: set[tuple[str, str]] = set()
    for e in intra_edges:
        src, tgt = e.get("from", ""), e.get("to", "")
        if src not in top_set or tgt not in top_set:
            continue
        key = (_mermaid_id(src), _mermaid_id(tgt))
        if key in shown_edges:
            continue
        shown_edges.add(key)
        rel = e.get("relation", "")
        arrow = f" -->|{rel}| " if rel else " --> "
        lines.append(f"  {_mermaid_id(src)}{arrow}{_mermaid_id(tgt)}")
        if len(shown_edges) >= 30:
            break

    if not shown_edges:
        # Fallback: show node list if no intra edges
        lines = ["flowchart LR"]
        for nid in top_nodes[:8]:
            n = node_map.get(nid, {})
            name = _mermaid_label(n.get("name", nid))
            lines.append(f'  {_mermaid_id(nid)}["{name}"]')

    return "\n".join(lines)


# ── Call detail table ─────────────────────────────────────────────────────────

def _call_table(community: dict, edges: list[dict], node_map: dict[str, dict]) -> str:
    members = set(community.get("members", []))
    cross_in = []
    for e in edges:
        src, tgt = e.get("from", ""), e.get("to", "")
        if tgt in members and src not in members:
            src_n = node_map.get(src, {})
            tgt_n = node_map.get(tgt, {})
            cross_in.append((src_n.get("name", src), tgt_n.get("name", tgt), e.get("relation", "→"), e.get("confidence", "")))

    if not cross_in:
        return ""

    rows = "\n".join(
        f"<tr><td><code>{escape(caller)}</code></td><td><code>{escape(callee)}</code></td><td>{escape(rel)}</td><td>{escape(conf)}</td></tr>"
        for caller, callee, rel, conf in cross_in[:20]
    )
    return f"""<table class="call-table">
<thead><tr><th>Caller</th><th>Callee</th><th>Relation</th><th>Confidence</th></tr></thead>
<tbody>{rows}</tbody>
</table>"""


# ── Main entry point ──────────────────────────────────────────────────────────

def to_html(graph_dict: dict, output_path: str) -> str:
    """Generate Mermaid call-flow HTML. Returns path written."""
    nodes = graph_dict.get("nodes", [])
    edges = graph_dict.get("edges", [])
    communities = graph_dict.get("communities", [])
    god_nodes = graph_dict.get("god_nodes", [])
    generated = graph_dict.get("generated_at", "")

    node_map = {n["id"]: n for n in nodes}

    # Full per-community sections (with a Mermaid diagram each) only for the
    # largest communities — a project with hundreds of communities would
    # otherwise render hundreds of Mermaid diagrams on one page, which is slow
    # to the point of being unusable and mostly noise from single-node clusters.
    MAX_COMMUNITY_SECTIONS = 20
    shown_communities = sorted(communities, key=lambda c: -len(c.get("members", [])))[:MAX_COMMUNITY_SECTIONS]

    # Navigation
    nav_links = '<nav class="nav"><a href="#overview">Overview</a>' + "".join(
        '<a href="#comm-{}">{}</a>'.format(c["id"], escape(c.get("label", f"C{c['id']}")))
        for c in shown_communities
    ) + "</nav>"

    # Overview section
    overview_mermaid = _overview_diagram(communities, edges, node_map)
    god_names = [node_map.get(nid, {}).get("name", nid) for nid in god_nodes[:5]]
    god_html = (
        "<div class='card'><h3>God Nodes</h3><ul>" +
        "".join(f"<li><code>{escape(n)}</code></li>" for n in god_names) +
        "</ul></div>"
    ) if god_names else ""

    omitted = len(communities) - len(shown_communities)
    scope_note = (
        f"<p>Showing the {len(shown_communities)} largest communities "
        f"({omitted} smaller/single-node communities omitted for readability).</p>"
        if omitted > 0 else ""
    )

    overview_section = f"""<section id="overview">
<h2>Architecture Overview</h2>
<p>{len(nodes)} nodes · {len(edges)} edges · {len(communities)} communities · generated {escape(generated)}</p>
{scope_note}
{god_html}
<div class="mermaid">
{overview_mermaid}
</div>
</section>"""

    # Per-community sections
    comm_sections = []
    for c in shown_communities:
        cid = c["id"]
        label = c.get("label", f"Community {cid}")
        members = c.get("members", [])
        diagram = _community_diagram(c, edges, node_map)
        table = _call_table(c, edges, node_map)

        # Top files in this community
        file_counts: dict[str, int] = defaultdict(int)
        for mid in members:
            f = node_map.get(mid, {}).get("file", "")
            if f:
                file_counts[f] += 1
        top_files = sorted(file_counts.items(), key=lambda x: -x[1])[:5]
        files_html = "".join(f"<li><code>{escape(fp)}</code> ({cnt} nodes)</li>" for fp, cnt in top_files)

        comm_sections.append(f"""<section id="comm-{cid}">
<h2>{escape(label)}</h2>
<p>{len(members)} nodes</p>
<div class="grid">
  <div class="card"><h3>Key Files</h3><ul>{files_html}</ul></div>
</div>
<div class="mermaid">
{diagram}
</div>
{"<h3>Incoming Cross-Community Calls</h3>" + table if table else ""}
<hr>
</section>""")

    body = "\n".join(comm_sections)

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>CodeGraph Call Flow</title>
<style>{_CSS}</style>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script>mermaid.initialize({{startOnLoad:true,theme:'dark',flowchart:{{curve:'basis'}}}});</script>
</head>
<body>
{nav_links}
<div class="container">
<h1>Call Flow Architecture</h1>
<p class="subtitle">Auto-generated from knowledge graph</p>
{overview_section}
{body}
</div>
</body>
</html>"""

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return str(out)
