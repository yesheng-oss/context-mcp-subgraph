"""
tree_html.py — D3 v7 collapsible file-tree HTML from graph.json.

Adapted from graphify's tree_html.py.
Field name differences from graphify: we use 'file' not 'source_file', 'name' not 'label'.
"""
from __future__ import annotations

import html as _html
import json
from collections import defaultdict
from pathlib import Path

DEFAULT_MAX_CHILDREN = 200


# ── Tree builder ──────────────────────────────────────────────────────────────

def _common_root(paths: list[str]) -> str:
    if not paths:
        return ""
    parts = [Path(p.replace("\\", "/")).parts for p in paths if p]
    if not parts:
        return ""
    common = list(parts[0])
    for p in parts[1:]:
        i = 0
        while i < len(common) and i < len(p) and common[i] == p[i]:
            i += 1
        common = common[:i]
    return str(Path(*common)) if common else ""


def build_tree(
    graph_dict: dict,
    *,
    root: str | None = None,
    max_children: int = DEFAULT_MAX_CHILDREN,
    project_label: str | None = None,
) -> dict:
    """Build {name, total_count, children} hierarchy from graph nodes."""
    nodes = graph_dict.get("nodes", [])
    file_nodes = [n for n in nodes if n.get("file")]
    if not file_nodes:
        return {"name": "(empty graph)", "total_count": 0, "children": []}

    if root is None:
        root = _common_root([n["file"].replace("\\", "/") for n in file_nodes])
    root_path = Path(root.replace("\\", "/")) if root else Path(".")

    by_file: dict[str, list[dict]] = defaultdict(list)
    for n in file_nodes:
        by_file[n["file"].replace("\\", "/")].append(n)

    dir_index: dict[str, dict] = {}
    label_root = project_label or root_path.name or root or "/"
    root_node: dict = {"name": label_root, "total_count": 0, "children": []}
    dir_index[str(root_path)] = root_node

    def _ensure_dir(abs_path: Path) -> dict:
        key = str(abs_path)
        if key in dir_index:
            return dir_index[key]
        if abs_path == abs_path.parent:
            return root_node
        parent = _ensure_dir(abs_path.parent) if abs_path.parent != abs_path else root_node
        node = {"name": abs_path.name, "total_count": 0, "children": []}
        dir_index[key] = node
        parent["children"].append(node)
        return node

    for src_file, syms in sorted(by_file.items()):
        src_path = Path(src_file)
        try:
            rel = src_path.relative_to(root_path)
            parent_path = (root_path / rel).parent
        except ValueError:
            parent_path = root_path
        parent_dir = _ensure_dir(parent_path)

        sym_children = []
        for n in syms:
            sym_name = n.get("name", n.get("id", "?"))
            if sym_name == src_path.name:
                continue
            sym_children.append({"name": sym_name, "total_count": 1, "children": []})
        sym_children.sort(key=lambda c: (c["name"].startswith("_"), c["name"].lower()))
        if len(sym_children) > max_children:
            extra = len(sym_children) - max_children
            sym_children = sym_children[:max_children] + [{"name": f"(+{extra} more)", "total_count": extra, "children": []}]
        file_node = {"name": src_path.name, "total_count": len(sym_children) or 1, "children": sym_children}
        parent_dir["children"].append(file_node)

    def _finalise(d: dict) -> int:
        kids = d.get("children") or []
        kids.sort(key=lambda c: (0 if (c.get("children") and len(c["children"]) > 0) else 1, c["name"].lower()))
        if not kids:
            return d.get("total_count") or 1
        n = sum(_finalise(c) for c in kids)
        d["total_count"] = n or 1
        return d["total_count"]

    _finalise(root_node)
    return root_node


# ── HTML emitter ──────────────────────────────────────────────────────────────

_HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{title}</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: 'Segoe UI', system-ui, sans-serif; background: #0f0f1a; color: #e0e0e0; }}
    header {{ padding: 18px 28px 10px; border-bottom: 1px solid #2a2a4e; }}
    h1 {{ font-size: 1.5rem; font-weight: 600; color: #e0e0e0; letter-spacing: -0.01em; }}
    h1 span {{ color: #4E79A7; }}
    .controls {{ padding: 12px 28px; display: flex; gap: 10px; border-bottom: 1px solid #2a2a4e; }}
    button {{ padding: 6px 16px; background: #1a1a2e; color: #c0c0d0; border: 1px solid #3a3a5e; border-radius: 5px; font-size: 0.85rem; cursor: pointer; }}
    button:hover {{ background: #2a2a4e; border-color: #4E79A7; color: #e0e0e0; }}
    #tree-container {{ width: 100vw; height: calc(100vh - 100px); overflow: auto; }}
    svg {{ background: #0f0f1a; display: block; }}
    .node circle {{ stroke-width: 2px; }}
    .node text {{ font: 12px 'Segoe UI', sans-serif; fill: #c8c8d8; paint-order: stroke fill; stroke: #0f0f1a; stroke-width: 3px; stroke-linejoin: round; stroke-opacity: 0.9; }}
    .link {{ fill: none; stroke-opacity: 0.4; stroke-width: 1.5px; }}
  </style>
</head>
<body>
  <header><h1><span>◈</span> {header}</h1></header>
  <div class="controls">
    <button onclick="expandAll()">Expand All</button>
    <button onclick="collapseAll()">Collapse All</button>
    <button onclick="resetView()">Reset</button>
  </div>
  <div id="tree-container">
    <svg id="tree-svg" width="{svg_width}" height="{svg_height}"></svg>
  </div>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <script>
    const initialJsonData = {data_json};
    function transformData(d) {{
      function p(node, parentL1) {{
        const r = {{ name: node.name, count: node.total_count || 0, originalStageName: parentL1 === "Root" ? node.name : parentL1 }};
        if (node.children && node.children.length > 0)
          r.children = node.children.map(c => p(c, parentL1 === "Root" ? node.name : parentL1));
        return r;
      }}
      return {{ name: d.name, count: d.total_count || 0, originalStageName: "Root", children: (d.children || []).map(c => p(c, "Root")) }};
    }}
    const treeData = transformData(initialJsonData);
    const PALETTE = [
      ["#4E79A7","#3a5c84","#1e3050"],["#59A14F","#3d7a42","#1e4020"],
      ["#E15759","#b03a3c","#6a1820"],["#B07AA1","#845a78","#4a2040"],
      ["#F28E2B","#b8681c","#6a3808"],["#76B7B2","#4d8a85","#1e4040"],
      ["#EDC948","#b89c20","#6a5808"],["#FF9DA7","#cc6370","#7a1828"],
    ];
    const phaseColors = {{ "Root": {{ fill:"#2a2a4e",stroke:"#4E79A7",collapsedFill:"#1a1a3e" }}, "Default": {{ fill:"#3a3a5e",stroke:"#5a5a8e",collapsedFill:"#2a2a4e" }} }};
    (initialJsonData.children||[]).forEach((c,i) => {{ const pal=PALETTE[i%PALETTE.length]; phaseColors[c.name]={{ fill:pal[0],stroke:pal[0],collapsedFill:pal[2] }}; }});
    const rootPalette = {{fill:"#1a1a3e",stroke:"#4E79A7",collapsedFill:"#0f0f2a"}};
    const svg = d3.select("#tree-svg");
    const margin = {{top:40,right:120,bottom:80,left:450}};
    const duration = 500;
    let nc = 0;
    const g = svg.append("g").attr("transform",`translate(${{margin.left}},${{margin.top}})`);
    const treemap = d3.tree().nodeSize([40,0]);
    let root = d3.hierarchy(treeData, d=>d.children);
    root.x0=0; root.y0=0;
    if (root.children) root.children.forEach(collapse);
    update(root);
    function collapse(d) {{ if(d.children){{ d._children=d.children; d._children.forEach(collapse); d.children=null; }} }}
    function expand(d) {{ if(d._children){{ d.children=d._children; d._children=null; }} if(d.children) d.children.forEach(expand); }}
    window.expandAll=()=>{{ expand(root); update(root); }};
    window.collapseAll=()=>{{ if(root.children) root.children.forEach(collapse); update(root); }};
    window.resetView=()=>{{ if(root.children) root.children.forEach(c=>{{ if(c.children||c._children) collapse(c); }}); update(root); }};
    function pal(d) {{
      if (d.depth===0) return rootPalette;
      // originalStageName is the top-level ancestor's name at every depth (see
      // transformData), so the whole subtree under e.g. "src" shares one color
      // family instead of every node at a given depth looking identical.
      return phaseColors[d.data.originalStageName]||phaseColors.Default;
    }}
    function update(src) {{
      const td = treemap(root);
      const nodes = td.descendants(), links = td.descendants().slice(1);
      const minX = d3.min(nodes,d=>d.x)||0, maxX = d3.max(nodes,d=>d.x)||0;
      svg.transition().duration(duration/2).attr("height",Math.max(+svg.attr("height"),maxX-minX+margin.top+margin.bottom+100));
      g.transition().duration(duration/2).attr("transform",`translate(${{margin.left}},${{margin.top-minX+40}})`);
      nodes.forEach(d=>{{ d.y=d.depth*400; }});
      const node = g.selectAll('g.node').data(nodes, d=>d.id||(d.id=++nc));
      const ne = node.enter().append('g')
        .attr('class','node')
        .attr('transform',`translate(${{src.y0}},${{src.x0}})`)
        .style('cursor',d=>(d.children||d._children)?'pointer':'default')
        .on('click',(e,d)=>{{ if(d.children){{ d._children=d.children; d.children=null; }} else if(d._children){{ d.children=d._children; d._children=null; }} update(d); }});
      ne.append('circle').attr('r',1e-6);
      ne.append('text').attr('dy','.35em').attr('x',d=>d.children||d._children?-14:14).attr('text-anchor',d=>d.children||d._children?'end':'start').style("fill-opacity",1e-6);
      const nu = ne.merge(node);
      nu.transition().duration(duration).attr('transform',d=>`translate(${{d.y}},${{d.x}})`);
      nu.select('circle').attr('r',8.5)
        .style('fill',d=>d._children?pal(d).collapsedFill:d.children?pal(d).fill:"#fff")
        .style('stroke',d=>pal(d).stroke);
      nu.select('text').style("fill-opacity",1).text(d=>d.data.name.replace(/\s*\(Total Count: \d+\)$/,''));
      node.exit().transition().duration(duration).attr('transform',`translate(${{src.y}},${{src.x}})`).remove();
      const link = g.selectAll('path.link').data(links,d=>d.id);
      link.enter().insert('path',"g").attr('class','link').attr('d',d=>{{ const o={{x:src.x0,y:src.y0}}; return `M${{o.y}} ${{o.x}} C${{(o.y+o.y)/2}} ${{o.x}},${{(o.y+o.y)/2}} ${{o.x}},${{o.y}} ${{o.x}}`; }})
        .merge(link).transition().duration(duration).attr('d',d=>`M${{d.y}} ${{d.x}} C${{(d.y+d.parent.y)/2}} ${{d.x}},${{(d.y+d.parent.y)/2}} ${{d.parent.x}},${{d.parent.y}} ${{d.parent.x}}`)
        .style('stroke',d=>pal(d.parent).stroke);
      link.exit().transition().duration(duration).attr('d',d=>{{ const o={{x:src.x,y:src.y}}; return `M${{o.y}} ${{o.x}} C${{o.y}} ${{o.x}},${{o.y}} ${{o.x}},${{o.y}} ${{o.x}}`; }}).remove();
      nodes.forEach(d=>{{ d.x0=d.x; d.y0=d.y; }});
    }}
  </script>
</body>
</html>"""


def to_html(graph_dict: dict, output_path: str, *, project_label: str | None = None) -> str:
    """Generate D3 collapsible tree HTML. Returns path written."""
    tree = build_tree(graph_dict, project_label=project_label)
    title = _html.escape(f"{tree['name']} — CodeGraph file tree")
    header = _html.escape(f"{tree['name']} — File Tree")
    data_json = json.dumps(tree, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")

    html_content = _HTML_TEMPLATE.format(
        title=title,
        header=header,
        svg_width=6000,
        svg_height=8000,
        data_json=data_json,
    )
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html_content, encoding="utf-8")
    return str(out)
