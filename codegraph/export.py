"""
export.py — generate interactive visualizations from graph.json.

Formats:
  to_html()     — self-contained vis.js HTML (dark theme, search, community toggle)
  to_graphml()  — GraphML for Gephi/yEd
  to_obsidian() — per-node .md files with [[wikilinks]] + community summaries
"""
from __future__ import annotations

import html as _html
import json
import re
from pathlib import Path


# ── Color palette (same as graphify for visual consistency) ──────────────────

COMMUNITY_COLORS = [
    "#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F",
    "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC",
]

MAX_VIZ_NODES = 5_000


# ── HTML export ───────────────────────────────────────────────────────────────

def to_html(graph_dict: dict, output_path: str) -> str:
    """Generate self-contained vis.js HTML. Returns path written."""
    nodes = graph_dict.get("nodes", [])
    edges = graph_dict.get("edges", [])
    communities_list = graph_dict.get("communities", [])

    # Build community lookup: node_id → community_id
    node_community: dict[str, int] = {}
    for c in communities_list:
        for mid in c.get("members", []):
            node_community[mid] = c["id"]

    # Community color map
    comm_colors: dict[int, str] = {}
    for c in communities_list:
        comm_colors[c["id"]] = COMMUNITY_COLORS[c["id"] % len(COMMUNITY_COLORS)]

    # Degree map
    degree: dict[str, int] = {}
    for e in edges:
        degree[e.get("from", "")] = degree.get(e.get("from", ""), 0) + 1
        degree[e.get("to", "")]   = degree.get(e.get("to", ""), 0) + 1

    # Limit nodes for viz
    if len(nodes) > MAX_VIZ_NODES:
        nodes = sorted(nodes, key=lambda n: -degree.get(n.get("id", ""), 0))[:MAX_VIZ_NODES]
        node_ids_kept = {n["id"] for n in nodes}
        edges = [e for e in edges if e.get("from") in node_ids_kept and e.get("to") in node_ids_kept]

    # Build vis node list
    viz_nodes = []
    for n in nodes:
        nid = n.get("id", "")
        cid = node_community.get(nid, -1)
        color = comm_colors.get(cid, "#607D8B")
        deg = degree.get(nid, 0)
        size = max(8, min(30, 8 + deg * 1.5))
        name = _html.escape(str(n.get("name", nid)))
        file_path = _html.escape(str(n.get("file", "-")))
        node_type = _html.escape(str(n.get("type", "?")))
        comm_label = ""
        if cid >= 0:
            comm = next((c for c in communities_list if c["id"] == cid), None)
            comm_label = comm["label"] if comm else f"Community {cid}"
        tooltip = f"<b>{name}</b><br>type: {node_type}<br>file: {file_path}<br>degree: {deg}"
        viz_nodes.append({
            "id":             nid,
            "label":          n.get("name", nid),
            "color":          {"background": color, "border": color},
            "size":           size,
            "font":           {"color": "#e0e0e0", "size": 11},
            "title":          tooltip,
            "community":      cid,
            "community_name": comm_label,
            "source_file":    n.get("file", ""),
            "file_type":      n.get("type", ""),
            "degree":         deg,
        })

    # Build vis edge list
    viz_edges = []
    for e in edges:
        conf = e.get("confidence", "EXTRACTED")
        dashes = conf in ("INFERRED", "AMBIGUOUS")
        width = 1 if conf == "AMBIGUOUS" else (1.5 if conf == "INFERRED" else 2)
        viz_edges.append({
            "from":   e.get("from"),
            "to":     e.get("to"),
            "title":  e.get("relation", ""),
            "dashes": dashes,
            "width":  width,
            "color":  {"color": "#3a3a5e", "highlight": "#6a6aae"},
        })

    # Legend data
    legend = []
    for c in sorted(communities_list, key=lambda c: -len(c.get("members", []))):
        cid = c["id"]
        legend.append({
            "cid":   cid,
            "label": c.get("label", f"Community {cid}"),
            "color": comm_colors.get(cid, "#607D8B"),
            "count": len(c.get("members", [])),
        })

    nodes_json  = json.dumps(viz_nodes)
    edges_json  = json.dumps(viz_edges)
    legend_json = json.dumps(legend)
    stats_text  = f"{len(nodes)} nodes · {len(edges)} edges · {len(communities_list)} communities"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>CodeGraph</title>
<script src="https://unpkg.com/vis-network@9.1.9/dist/vis-network.min.js"></script>
<link rel="stylesheet" href="https://unpkg.com/vis-network@9.1.9/dist/vis-network.min.css">
{_html_styles()}
</head>
<body>
<div id="graph"></div>
<div id="sidebar">
  <div id="toolbar">
    <button class="tb-btn" onclick="network.fit()">Fit</button>
    <button class="tb-btn" onclick="network.setOptions({{physics:{{enabled:true}}}});setTimeout(()=>network.setOptions({{physics:{{enabled:false}}}}),2000)">Relayout</button>
  </div>
  <div id="search-wrap">
    <input id="search" type="text" placeholder="Search nodes…" autocomplete="off">
    <div id="search-results"></div>
  </div>
  <div id="info-panel">
    <h3>Node Info</h3>
    <div id="info-content"><span class="empty">Click a node to inspect it</span></div>
  </div>
  <div id="legend-wrap">
    <h3>Communities</h3>
    <div id="legend-controls">
      <label><input type="checkbox" id="select-all-cb" checked> All</label>
    </div>
    <div id="legend"></div>
  </div>
  <div id="stats">{stats_text}</div>
</div>
{_html_script(nodes_json, edges_json, legend_json)}
</body>
</html>"""

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return str(out)


def _html_styles() -> str:
    return """<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f0f1a; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; height: 100vh; overflow: hidden; }
  #graph { flex: 1; }
  #sidebar { width: 280px; background: #1a1a2e; border-left: 1px solid #2a2a4e; display: flex; flex-direction: column; overflow: hidden; }
  #search-wrap { padding: 12px; border-bottom: 1px solid #2a2a4e; }
  #search { width: 100%; background: #0f0f1a; border: 1px solid #3a3a5e; color: #e0e0e0; padding: 7px 10px; border-radius: 6px; font-size: 13px; outline: none; }
  #search:focus { border-color: #4E79A7; }
  #search-results { max-height: 140px; overflow-y: auto; padding: 4px 12px; border-bottom: 1px solid #2a2a4e; display: none; }
  .search-item { padding: 4px 6px; cursor: pointer; border-radius: 4px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .search-item:hover { background: #2a2a4e; }
  #info-panel { padding: 14px; border-bottom: 1px solid #2a2a4e; min-height: 140px; }
  #info-panel h3 { font-size: 13px; color: #aaa; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  #info-content { font-size: 13px; color: #ccc; line-height: 1.6; }
  #info-content .field { margin-bottom: 5px; }
  #info-content .field b { color: #e0e0e0; }
  #info-content .empty { color: #555; font-style: italic; }
  .neighbor-link { display: block; padding: 2px 6px; margin: 2px 0; border-radius: 3px; cursor: pointer; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-left: 3px solid #333; }
  .neighbor-link:hover { background: #2a2a4e; }
  #neighbors-list { max-height: 160px; overflow-y: auto; margin-top: 4px; }
  #legend-wrap { flex: 1; overflow-y: auto; padding: 12px; }
  #legend-wrap h3 { font-size: 13px; color: #aaa; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
  .legend-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; border-radius: 4px; font-size: 12px; }
  .legend-item:hover { background: #2a2a4e; padding-left: 4px; }
  .legend-item.dimmed { opacity: 0.35; }
  .legend-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
  .legend-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legend-count { color: #666; font-size: 11px; }
  #stats { padding: 10px 14px; border-top: 1px solid #2a2a4e; font-size: 11px; color: #888; }
  #toolbar { padding: 6px 8px; border-bottom: 1px solid #2a2a4e; display: flex; gap: 6px; }
  .tb-btn { background: #1a1a2e; border: 1px solid #3a3a5e; color: #c0c0d0; border-radius: 4px; padding: 3px 10px; font-size: 11px; cursor: pointer; }
  .tb-btn:hover { background: #2a2a4e; border-color: #4E79A7; color: #e0e0e0; }
  #legend-controls { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding: 4px 0; }
  #legend-controls label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12px; color: #aaa; user-select: none; }
  #legend-controls label:hover { color: #e0e0e0; }
  #select-all-cb { appearance: none; -webkit-appearance: none; width: 14px; height: 14px; border: 1.5px solid #3a3a5e; border-radius: 3px; background: #0f0f1a; cursor: pointer; position: relative; flex-shrink: 0; }
  #select-all-cb:checked { background: #4E79A7; border-color: #4E79A7; }
  #select-all-cb:checked::after { content: "✓"; position: absolute; color: #fff; font-size: 10px; top: -2px; left: 1px; }
  .legend-cb { appearance: none; -webkit-appearance: none; width: 14px; height: 14px; border: 1.5px solid #3a3a5e; border-radius: 3px; background: #0f0f1a; cursor: pointer; position: relative; flex-shrink: 0; }
  .legend-cb:checked { background: #4E79A7; border-color: #4E79A7; }
  .legend-cb:checked::after { content: "✓"; position: absolute; color: #fff; font-size: 10px; top: -2px; left: 1px; }
  .type-badge { display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 3px; margin-left: 4px; background: #2a2a4e; color: #888; vertical-align: middle; }
</style>"""


def _html_script(nodes_json: str, edges_json: str, legend_json: str) -> str:
    return f"""<script>
const RAW_NODES = {nodes_json};
const RAW_EDGES = {edges_json};
const LEGEND = {legend_json};

function esc(s) {{
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}}

function makeTooltip(html) {{
  const d = document.createElement('div');
  d.style.cssText = 'background:#1a1a2e;border:1px solid #3a3a5e;border-radius:6px;padding:8px 12px;font-size:12px;color:#e0e0e0;max-width:260px;line-height:1.6;';
  d.innerHTML = html;
  return d;
}}
const nodesDS = new vis.DataSet(RAW_NODES.map(n => ({{
  id: n.id, label: n.label, color: n.color, size: n.size,
  font: n.font, title: makeTooltip(n.title),
  _community: n.community, _community_name: n.community_name,
  _source_file: n.source_file, _file_type: n.file_type, _degree: n.degree,
}})));

const edgesDS = new vis.DataSet(RAW_EDGES.map((e, i) => ({{
  id: i, from: e.from, to: e.to, title: e.title ? makeTooltip(esc(e.title)) : undefined,
  dashes: e.dashes, width: e.width, color: e.color,
  arrows: {{ to: {{ enabled: true, scaleFactor: 0.5 }} }},
}})));

const container = document.getElementById('graph');
const network = new vis.Network(container, {{ nodes: nodesDS, edges: edgesDS }}, {{
  physics: {{
    enabled: true,
    solver: 'forceAtlas2Based',
    forceAtlas2Based: {{ gravitationalConstant: -60, centralGravity: 0.005, springLength: 120, springConstant: 0.08, damping: 0.4, avoidOverlap: 0.8 }},
    stabilization: {{ iterations: 200, fit: true }},
  }},
  interaction: {{ hover: true, tooltipDelay: 100, hideEdgesOnDrag: true }},
  nodes: {{ shape: 'dot', borderWidth: 1.5 }},
  edges: {{ smooth: {{ type: 'continuous', roundness: 0.2 }}, selectionWidth: 3 }},
}});

network.once('stabilizationIterationsDone', () => network.setOptions({{ physics: {{ enabled: false }} }}));

function showInfo(nodeId) {{
  const n = nodesDS.get(nodeId);
  if (!n) return;
  const neighborIds = network.getConnectedNodes(nodeId);
  const neighborItems = neighborIds.map(nid => {{
    const nb = nodesDS.get(nid);
    const color = nb ? nb.color.background : '#555';
    return `<span class="neighbor-link" style="border-left-color:${{esc(color)}}" onclick="focusNode(${{JSON.stringify(nid)}})">${{esc(nb ? nb.label : nid)}}</span>`;
  }}).join('');
  document.getElementById('info-content').innerHTML = `
    <div class="field"><b>${{esc(n.label)}}</b><span class="type-badge">${{esc(n._file_type || '?')}}</span></div>
    <div class="field">Community: ${{esc(n._community_name || '—')}}</div>
    <div class="field" title="${{esc(n._source_file || '')}}">File: ${{esc((n._source_file || '—').split('/').pop() || n._source_file || '—')}}</div>
    <div class="field">Connections: ${{n._degree}}</div>
    ${{neighborIds.length ? `<div style="margin-top:8px;color:#aaa;font-size:11px">Neighbors (${{neighborIds.length}})</div><div id="neighbors-list">${{neighborItems}}</div>` : ''}}
  `;
}}

function focusNode(nodeId) {{
  network.focus(nodeId, {{ scale: 1.4, animation: true }});
  network.selectNodes([nodeId]);
  showInfo(nodeId);
}}

let hoveredNodeId = null;
network.on('hoverNode', p => {{ hoveredNodeId = p.node; container.style.cursor = 'pointer'; }});
network.on('blurNode', () => {{ hoveredNodeId = null; container.style.cursor = 'default'; }});
container.addEventListener('click', () => {{ if (hoveredNodeId !== null) {{ showInfo(hoveredNodeId); network.selectNodes([hoveredNodeId]); }} }});
network.on('click', p => {{
  if (p.nodes.length > 0) showInfo(p.nodes[0]);
  else if (hoveredNodeId === null) document.getElementById('info-content').innerHTML = '<span class="empty">Click a node to inspect it</span>';
}});

const searchInput = document.getElementById('search');
const searchResults = document.getElementById('search-results');
searchInput.addEventListener('input', () => {{
  const q = searchInput.value.toLowerCase().trim();
  searchResults.innerHTML = '';
  if (!q) {{ searchResults.style.display = 'none'; return; }}
  const matches = RAW_NODES.filter(n => String(n.label).toLowerCase().includes(q)).slice(0, 20);
  if (!matches.length) {{ searchResults.style.display = 'none'; return; }}
  searchResults.style.display = 'block';
  matches.forEach(n => {{
    const el = document.createElement('div');
    el.className = 'search-item';
    el.textContent = n.label;
    el.style.borderLeft = `3px solid ${{n.color.background}}`;
    el.style.paddingLeft = '8px';
    el.onclick = () => {{ network.focus(n.id, {{ scale: 1.5, animation: true }}); network.selectNodes([n.id]); showInfo(n.id); searchResults.style.display = 'none'; searchInput.value = ''; }};
    searchResults.appendChild(el);
  }});
}});
document.addEventListener('click', e => {{ if (!searchResults.contains(e.target) && e.target !== searchInput) searchResults.style.display = 'none'; }});

const hiddenCommunities = new Set();
const selectAllCb = document.getElementById('select-all-cb');
function updateSelectAllState() {{
  selectAllCb.checked = hiddenCommunities.size === 0;
  selectAllCb.indeterminate = hiddenCommunities.size > 0 && hiddenCommunities.size < LEGEND.length;
}}
selectAllCb.addEventListener('change', () => {{
  const hide = !selectAllCb.checked;
  document.querySelectorAll('.legend-item').forEach(item => hide ? item.classList.add('dimmed') : item.classList.remove('dimmed'));
  document.querySelectorAll('.legend-cb').forEach(cb => {{ cb.checked = !hide; }});
  LEGEND.forEach(c => {{ if (hide) hiddenCommunities.add(c.cid); else hiddenCommunities.delete(c.cid); }});
  nodesDS.update(RAW_NODES.map(n => ({{ id: n.id, hidden: hide }})));
  updateSelectAllState();
}});

const legendEl = document.getElementById('legend');
LEGEND.forEach(c => {{
  const item = document.createElement('div');
  item.className = 'legend-item';
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.className = 'legend-cb'; cb.checked = true;
  cb.addEventListener('change', e => {{
    e.stopPropagation();
    if (cb.checked) {{ hiddenCommunities.delete(c.cid); item.classList.remove('dimmed'); }}
    else {{ hiddenCommunities.add(c.cid); item.classList.add('dimmed'); }}
    nodesDS.update(RAW_NODES.filter(n => n.community === c.cid).map(n => ({{ id: n.id, hidden: !cb.checked }})));
    updateSelectAllState();
  }});
  item.innerHTML = `<div class="legend-dot" style="background:${{c.color}}"></div><span class="legend-label">${{esc(c.label)}}</span><span class="legend-count">${{c.count}}</span>`;
  item.prepend(cb);
  item.onclick = e => {{ if (e.target === cb) return; cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); }};
  legendEl.appendChild(item);
}});
</script>"""


# ── GraphML export ────────────────────────────────────────────────────────────

def to_graphml(graph_dict: dict, output_path: str) -> str:
    """Write GraphML for Gephi/yEd. Returns path written."""
    nodes = graph_dict.get("nodes", [])
    edges = graph_dict.get("edges", [])

    def esc(s: str) -> str:
        return _html.escape(str(s), quote=True)

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<graphml xmlns="http://graphml.graphdrawing.org/graphml">',
        '  <key id="name"       for="node" attr.name="name"       attr.type="string"/>',
        '  <key id="type"       for="node" attr.name="type"       attr.type="string"/>',
        '  <key id="file"       for="node" attr.name="file"       attr.type="string"/>',
        '  <key id="community"  for="node" attr.name="community"  attr.type="int"/>',
        '  <key id="relation"   for="edge" attr.name="relation"   attr.type="string"/>',
        '  <key id="confidence" for="edge" attr.name="confidence" attr.type="string"/>',
        '  <graph id="G" edgedefault="directed">',
    ]

    for n in nodes:
        nid = esc(n.get("id", ""))
        lines.append(f'    <node id="{nid}">')
        lines.append(f'      <data key="name">{esc(n.get("name", ""))}</data>')
        lines.append(f'      <data key="type">{esc(n.get("type", ""))}</data>')
        lines.append(f'      <data key="file">{esc(n.get("file", ""))}</data>')
        if "community" in n:
            lines.append(f'      <data key="community">{int(n["community"])}</data>')
        lines.append('    </node>')

    for i, e in enumerate(edges):
        src = esc(e.get("from", ""))
        tgt = esc(e.get("to", ""))
        lines.append(f'    <edge id="e{i}" source="{src}" target="{tgt}">')
        lines.append(f'      <data key="relation">{esc(e.get("relation", ""))}</data>')
        lines.append(f'      <data key="confidence">{esc(e.get("confidence", ""))}</data>')
        lines.append('    </edge>')

    lines += ['  </graph>', '</graphml>']

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    return str(out)


# ── Obsidian vault export ─────────────────────────────────────────────────────

def _obsidian_tag(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_\-/]", "", name.replace(" ", "_"))


def to_obsidian(graph_dict: dict, output_dir: str) -> str:
    """Write per-node .md files with [[wikilinks]] and community summaries.

    Returns the path of the vault directory.
    """
    nodes = graph_dict.get("nodes", [])
    edges = graph_dict.get("edges", [])
    communities_list = graph_dict.get("communities", [])

    vault = Path(output_dir)
    vault.mkdir(parents=True, exist_ok=True)
    nodes_dir = vault / "nodes"
    nodes_dir.mkdir(exist_ok=True)
    comms_dir = vault / "communities"
    comms_dir.mkdir(exist_ok=True)

    # Build adjacency for quick lookup
    node_map = {n["id"]: n for n in nodes}
    out_edges: dict[str, list[dict]] = {}
    in_edges: dict[str, list[dict]] = {}
    for e in edges:
        src, tgt = e.get("from", ""), e.get("to", "")
        out_edges.setdefault(src, []).append(e)
        in_edges.setdefault(tgt, []).append(e)

    # Community membership
    node_community: dict[str, dict] = {}
    for c in communities_list:
        for mid in c.get("members", []):
            node_community[mid] = c

    # Write per-node files
    for n in nodes:
        nid   = n.get("id", "")
        name  = n.get("name", nid)
        fpath = n.get("file", "")
        ntype = n.get("type", "")
        comm  = node_community.get(nid)
        comm_tag = _obsidian_tag(comm.get("label", f"community_{comm['id']}")) if comm else "misc"

        lines = [
            "---",
            f'name: "{name}"',
            f'type: "{ntype}"',
            f'file: "{fpath}"',
            f'community: "{comm_tag}"',
            "---",
            "",
            f"# {name}",
            "",
        ]
        if n.get("description"):
            lines += [n["description"], ""]

        lines += [f"**Type:** `{ntype}`  **File:** `{fpath}`", ""]

        if comm:
            lines += [f"**Community:** [[communities/{_obsidian_tag(comm['label'])}]]", ""]

        depends = out_edges.get(nid, [])
        if depends:
            lines += ["## Depends On", ""]
            for e in depends[:30]:
                tgt_node = node_map.get(e.get("to", ""), {})
                tgt_name = tgt_node.get("name", e.get("to", ""))
                rel = e.get("relation", "→")
                lines.append(f"- [[nodes/{tgt_name}]] _{rel}_")
            lines.append("")

        callers = in_edges.get(nid, [])
        if callers:
            lines += ["## Used By", ""]
            for e in callers[:30]:
                src_node = node_map.get(e.get("from", ""), {})
                src_name = src_node.get("name", e.get("from", ""))
                rel = e.get("relation", "→")
                lines.append(f"- [[nodes/{src_name}]] _{rel}_")
            lines.append("")

        safe_name = re.sub(r"[^\w\-. ]", "_", name)
        (nodes_dir / f"{safe_name}.md").write_text("\n".join(lines), encoding="utf-8")

    # Write per-community summary files
    for c in communities_list:
        cid    = c["id"]
        label  = c.get("label", f"Community {cid}")
        tag    = _obsidian_tag(label)
        members = c.get("members", [])
        member_nodes = [node_map[m] for m in members if m in node_map]

        # Cohesion score (simple inline calc)
        intra = sum(1 for e in edges
                    if e.get("from") in set(members) and e.get("to") in set(members))
        n = len(members)
        cohesion = round(intra / (n * (n - 1) / 2), 3) if n > 1 else 1.0

        lines = [
            "---",
            f'community_id: {cid}',
            f'label: "{label}"',
            f'members: {n}',
            f'cohesion: {cohesion}',
            "---",
            "",
            f"# {label}",
            "",
            f"**{n} members** · cohesion score: `{cohesion}`",
            "",
            "## Members",
            "",
        ]
        for mn in sorted(member_nodes, key=lambda x: x.get("name", ""))[:50]:
            mname = mn.get("name", mn.get("id", ""))
            safe_mname = re.sub(r"[^\w\-. ]", "_", mname)
            lines.append(f"- [[nodes/{safe_mname}]] `{mn.get('type', '?')}` · `{mn.get('file', '')}`")
        if n > 50:
            lines.append(f"- …and {n - 50} more")
        lines.append("")

        (comms_dir / f"{tag}.md").write_text("\n".join(lines), encoding="utf-8")

    # Write index
    index_lines = ["# CodeGraph Vault", "", "## Communities", ""]
    for c in sorted(communities_list, key=lambda c: -len(c.get("members", []))):
        tag = _obsidian_tag(c.get("label", f"Community {c['id']}"))
        index_lines.append(f"- [[communities/{tag}]] ({len(c.get('members', []))} nodes)")
    index_lines += ["", "## All Nodes", ""]
    for n in sorted(nodes, key=lambda x: x.get("name", ""))[:200]:
        safe_name = re.sub(r"[^\w\-. ]", "_", n.get("name", n.get("id", "")))
        index_lines.append(f"- [[nodes/{safe_name}]]")

    (vault / "index.md").write_text("\n".join(index_lines), encoding="utf-8")
    return str(vault)


# ── Convenience: generate all exports ────────────────────────────────────────

def generate_all(graph_dict: dict, cache_dir: str) -> dict[str, str]:
    """Generate all visualizations and exports. Returns {format: path}."""
    from .tree_html import to_html as _tree_html
    from .callflow_html import to_html as _callflow_html
    base = Path(cache_dir)
    results: dict[str, str] = {}
    try:
        results["html"]     = to_html(graph_dict, str(base / "graph.html"))
    except Exception as e:
        results["html_error"] = str(e)
    try:
        results["tree"]     = _tree_html(graph_dict, str(base / "tree.html"))
    except Exception as e:
        results["tree_error"] = str(e)
    try:
        results["callflow"] = _callflow_html(graph_dict, str(base / "callflow.html"))
    except Exception as e:
        results["callflow_error"] = str(e)
    try:
        results["graphml"]  = to_graphml(graph_dict, str(base / "graph.graphml"))
    except Exception as e:
        results["graphml_error"] = str(e)
    try:
        results["obsidian"] = to_obsidian(graph_dict, str(base / "obsidian"))
    except Exception as e:
        results["obsidian_error"] = str(e)
    return results
