#!/usr/bin/env python3
"""
codegraph/server.py — MCP server exposing codebase knowledge graph tools.

Tools:
  codegraph_build    — scan project, extract AST nodes, build graph (local only, no API)
  codegraph_query    — structural question OR single-node lookup (or both)
  codegraph_arch     — module map: every file with its exports and imports
  codegraph_report   — return full CODEGRAPH_REPORT.md
  codegraph_nodes    — list nodes of a given type
  codegraph_affected — BFS: what breaks if I change node X?
"""

import asyncio
import json
import os
import time
from pathlib import Path

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent

from .scanner import scan
from .config import classify_file
from .cache import file_hash, set_cached_nodes, save_cache
from .extractors.ast_extractor import extract as ast_extract
from .graph.builder import build, to_json_dict, save_graph, load_graph
from .graph.query import answer as graph_answer, context_subgraph, module_map
from .graph.clustering import detect_communities
from .report import generate as generate_report
from .affected import run_affected
from .export import to_html as export_html, to_graphml, to_obsidian, generate_all as export_all
from .tree_html import to_html as tree_html
from .callflow_html import to_html as callflow_html

app = Server("codegraph")


# ── Tool definitions ──────────────────────────────────────────────────────────

TOOLS = [
    Tool(
        name="codegraph_build",
        description=(
            "Scan a project directory and build the knowledge graph from code files. "
            "Uses tree-sitter AST (with regex fallback) for all code files. "
            "Fast, local, no API key needed. "
            "Run once per project; rebuild whenever code changes."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path":    {"type": "string", "description": "Absolute path to project root"},
                "cluster": {"type": "boolean", "description": "Run community detection after build (default true)"},
            },
            "required": ["path"],
        },
    ),
    Tool(
        name="codegraph_query",
        description=(
            "Ask a structural question about the codebase OR look up a specific node by name — or both in one call. "
            "Pass `question` for natural-language traversal: what calls X, what does module Y depend on. "
            "Pass `node` for fast single-node lookup: returns type, file, depends_on, used_by. "
            "Pass both to get node detail + surrounding graph context together. "
            "Returns structured text within token_budget. Use before reading any files."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path":         {"type": "string", "description": "Project root"},
                "question":     {"type": "string", "description": "Natural language question about the codebase"},
                "node":         {"type": "string", "description": "Node name or partial name to look up (type, file, deps, callers)"},
                "token_budget": {"type": "integer", "description": "Max tokens in response (default 2000)"},
            },
            "required": ["path"],
        },
    ),
    Tool(
        name="codegraph_context",
        description=(
            "Build a bounded, token-budgeted context subgraph for an AI coding task. "
            "Finds query-matching seed nodes, expands callers/dependencies/imports up to max_hops, "
            "ranks candidates, and returns compact nodes, relationship paths, budget usage, "
            "candidate counts, and per-item drop reasons."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path":         {"type": "string", "description": "Project root"},
                "question":     {"type": "string", "description": "Current code task or architecture question"},
                "max_hops":     {"type": "integer", "description": "Maximum graph expansion depth (default 2, max 5)"},
                "top_k":        {"type": "integer", "description": "Maximum query seed nodes (default 5)"},
                "token_budget": {"type": "integer", "description": "Maximum approximate tokens for nodes and edges"},
            },
            "required": ["path"],
        },
    ),
    Tool(
        name="codegraph_report",
        description="Return CODEGRAPH_REPORT.md — god nodes, clusters, surprising connections, suggested questions.",
        inputSchema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    ),
    Tool(
        name="codegraph_nodes",
        description="List all nodes of a given type, sorted by PageRank (most connected first).",
        inputSchema={
            "type": "object",
            "properties": {
                "path":         {"type": "string"},
                "type":         {"type": "string", "enum": ["class", "function", "module", "concept", "service", "file", "struct", "table"]},
                "limit":        {"type": "integer", "description": "Max results (default 50)"},
                "token_budget": {"type": "integer", "description": "Return highest-rank nodes within this token budget"},
            },
            "required": ["path", "type"],
        },
    ),
    Tool(
        name="codegraph_html",
        description=(
            "Generate interactive vis.js HTML graph visualization. "
            "Dark theme, search box, community toggle, click-to-inspect node panel. "
            "Outputs codegraph-cache/graph.html. Also generates graph.graphml and obsidian/ vault."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path":    {"type": "string", "description": "Project root"},
                "formats": {"type": "array", "items": {"type": "string"}, "description": "Formats to generate: html, graphml, obsidian, tree, callflow (default: all)"},
            },
            "required": ["path"],
        },
    ),
    Tool(
        name="codegraph_affected",
        description=(
            "BFS traversal: given a node name, find every node that would be affected "
            "if you change it — callers, importers, inheritors, etc. "
            "Use before refactoring to understand blast radius. "
            "Returns affected nodes with file paths, relation types, and traversal depth."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path":  {"type": "string", "description": "Project root"},
                "node":  {"type": "string", "description": "Node name, ID, or file path to start from"},
                "depth": {"type": "integer", "description": "BFS depth (default 2, max 5)"},
            },
            "required": ["path", "node"],
        },
    ),
    Tool(
        name="codegraph_filter",
        description=(
            "Filter graph nodes by semantic properties. Results sorted by PageRank (most connected first). "
            "All filters optional — combine freely. "
            "node_type: function|class|module|file. "
            "exported/side_effect: bool. "
            "return_type: substring match. "
            "called_by/calls: node name. "
            "file_pattern: glob. "
            "token_budget: max tokens in response."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path":         {"type": "string"},
                "node_type":    {"type": "string", "enum": ["function", "class", "module", "file"]},
                "exported":     {"type": "boolean"},
                "side_effect":  {"type": "boolean"},
                "return_type":  {"type": "string", "description": "Substring match on return type"},
                "called_by":    {"type": "string", "description": "Only nodes called by this name"},
                "calls":        {"type": "string", "description": "Only nodes that call this name"},
                "file_pattern": {"type": "string", "description": "Glob pattern for file path"},
                "limit":        {"type": "integer", "description": "Max results (default 20)"},
                "token_budget": {"type": "integer", "description": "Max tokens in response"},
            },
            "required": ["path"],
        },
    ),
    Tool(
        name="codegraph_arch",
        description=(
            "Return a module map: every file with its exported functions/classes and what it imports. "
            "Use this to understand project structure without reading any files. "
            "Call after codegraph_build. Much faster than reading each file."
        ),
        inputSchema={
            "type": "object",
            "properties": {
                "path":  {"type": "string", "description": "Project root"},
                "limit": {"type": "integer", "description": "Max files in output (default 100)"},
            },
            "required": ["path"],
        },
    ),
]


@app.list_tools()
async def list_tools():
    return TOOLS


@app.call_tool()
async def call_tool(name: str, arguments: dict):
    try:
        result = await _dispatch(name, arguments)
        return [TextContent(type="text", text=json.dumps(result, indent=2))]
    except Exception as e:
        return [TextContent(type="text", text=json.dumps({"error": str(e)}))]


async def _dispatch(name: str, args: dict):
    if name == "codegraph_build":    return await _build(args)
    if name == "codegraph_query":    return await _query(args)
    if name == "codegraph_context":  return await _context(args)
    if name == "codegraph_report":   return await _report(args)
    if name == "codegraph_nodes":    return await _nodes(args)
    if name == "codegraph_arch":     return await _arch(args)
    if name == "codegraph_affected": return await _affected(args)
    if name == "codegraph_html":     return await _export_viz(args)
    if name == "codegraph_filter":   return await _filter(args)
    raise ValueError(f"Unknown tool: {name}")


# ── Build ─────────────────────────────────────────────────────────────────────

async def _build(args: dict) -> dict:
    root       = args["path"]
    do_cluster = args.get("cluster", True)
    t0         = time.time()

    scan_result = scan(root)
    cache   = scan_result["cache"]
    cached  = scan_result["cached"]
    changed = scan_result["changed"]
    deleted = scan_result["deleted"]

    all_nodes: list[dict] = []

    for rel_path, nodes in cached.items():
        if nodes:
            all_nodes.extend(nodes)
        else:
            # Previously cached as empty — still add a file-level node so it's visible
            all_nodes.append({
                "id":   f"{rel_path}::file::{Path(rel_path).name}",
                "name": Path(rel_path).name,
                "type": "file",
                "file": rel_path,
            })

    for rel_path, abs_path in changed.items():
        cat = classify_file(abs_path)
        if cat in ("code", "sql"):
            nodes = ast_extract(abs_path, rel_path)
            if not nodes:
                # Extractor found no symbols — still represent the file so it appears in the graph
                nodes = [{
                    "id":   f"{rel_path}::file::{Path(rel_path).name}",
                    "name": Path(rel_path).name,
                    "type": "file",
                    "file": rel_path,
                }]
            set_cached_nodes(cache, rel_path, file_hash(abs_path), nodes)
            all_nodes.extend(nodes)
        elif cat == "config":
            # Label config files as a single node — don't decompose every key
            node = {"id": f"{rel_path}::file::{Path(rel_path).name}",
                    "name": Path(rel_path).name, "type": "file", "file": rel_path}
            set_cached_nodes(cache, rel_path, file_hash(abs_path), [node])
            all_nodes.append(node)
        elif cat == "build":
            from codegraph.extractors.build_extractor import extract as build_extract
            nodes = build_extract(abs_path, rel_path)
            set_cached_nodes(cache, rel_path, file_hash(abs_path), nodes)
            all_nodes.extend(nodes)
        elif cat in ("image", "audio", "video", "doc", "pdf"):
            # Label-only — node in graph so AI can reference the file, no content extraction
            node = {"id": f"{rel_path}::file::{Path(rel_path).name}",
                    "name": Path(rel_path).name, "type": "file", "file": rel_path}
            set_cached_nodes(cache, rel_path, file_hash(abs_path), [node])
            all_nodes.append(node)

    G          = build(all_nodes)
    communities = []
    if do_cluster:
        try:
            communities = detect_communities(G)
        except Exception:
            pass

    graph_dict = to_json_dict(G)
    save_graph(root, graph_dict)
    generate_report(graph_dict, root)
    save_cache(root, cache)

    cache_dir = str(Path(root) / "codegraph-cache")
    viz = {}
    try:
        viz = export_all(graph_dict, cache_dir) or {}
    except Exception as e:
        viz = {"error": str(e)}

    elapsed_ms = int((time.time() - t0) * 1000)
    result = {
        "success":     True,
        "nodes":       len(graph_dict.get("nodes", [])),
        "edges":       len(graph_dict.get("edges", [])),
        "communities": len(communities),
        "cached":      len(cached),
        "changed":     len(changed),
        "deleted":     len(deleted),
        "scanned":     scan_result.get("scanned", len(cached) + len(changed)),
        "cache_hit_rate": round(scan_result.get("cache_hit_rate", 0.0), 4),
        "time_ms":     elapsed_ms,
        "summary":     f"Built graph: {len(graph_dict.get('nodes', []))} nodes from code files.",
        "outputs":     viz,
    }

    return result


# ── Query / Report / Nodes / Path ─────────────────────────────────────────────

def _explain_node(node_name: str, graph_dict: dict) -> dict:
    query = node_name.lower()
    nodes = graph_dict.get("nodes", [])
    edges = graph_dict.get("edges", [])

    match = next((n for n in nodes if n.get("name", "").lower() == query), None)
    if not match:
        match = next((n for n in nodes if query in n.get("name", "").lower()), None)
    if not match:
        candidates = [n["name"] for n in nodes if query in n.get("id", "").lower()]
        return {"found": False, "query": node_name,
                "message": f"No node matching '{node_name}'.",
                "suggestions": candidates[:10]}

    nid = match["id"]
    depends_on, used_by = [], []
    for e in edges:
        if e.get("from") == nid:
            t = next((n for n in nodes if n.get("id") == e.get("to")), None)
            depends_on.append({"name": t["name"] if t else e["to"],
                               "file": t.get("file", "") if t else "",
                               "relation": e.get("relation", "→")})
        elif e.get("to") == nid:
            s = next((n for n in nodes if n.get("id") == e.get("from")), None)
            used_by.append({"name": s["name"] if s else e["from"],
                            "file": s.get("file", "") if s else "",
                            "relation": e.get("relation", "→")})

    return {
        "found":       True,
        "name":        match.get("name"),
        "type":        match.get("type"),
        "file":        match.get("file"),
        "description": match.get("description") or None,
        "depends_on":  depends_on[:20],
        "used_by":     used_by[:20],
    }


async def _query(args: dict) -> dict:
    graph_dict = load_graph(args["path"])
    if not graph_dict:
        raise ValueError("No graph found. Run codegraph_build first.")

    question  = args.get("question")
    node_name = args.get("node")

    if not question and not node_name:
        raise ValueError("Provide at least one of: question, node")

    result = {}
    if node_name:
        result["node"] = _explain_node(node_name, graph_dict)
    if question:
        result["query"] = graph_answer(question, graph_dict, token_budget=args.get("token_budget", 2000))
    return result


async def _context(args: dict) -> dict:
    graph_dict = load_graph(args["path"])
    if not graph_dict:
        raise ValueError("No graph found. Run codegraph_build first.")
    return context_subgraph(
        args.get("question", ""),
        graph_dict,
        max_hops=min(int(args.get("max_hops", 2)), 5),
        top_k=min(int(args.get("top_k", 5)), 20),
        token_budget=max(1, int(args.get("token_budget", 2000))),
    )


async def _report(args: dict) -> dict:
    report_path = Path(args["path"]) / "codegraph-cache" / "CODEGRAPH_REPORT.md"
    if report_path.exists():
        return {"content": report_path.read_text(encoding="utf-8")}
    graph_dict = load_graph(args["path"])
    if not graph_dict:
        raise ValueError("No graph found. Run codegraph_build first.")
    return {"content": generate_report(graph_dict, args["path"])}


async def _nodes(args: dict) -> dict:
    graph_dict = load_graph(args["path"])
    if not graph_dict:
        raise ValueError("No graph found. Run codegraph_build first.")
    node_type    = args["type"]
    limit        = int(args.get("limit", 50))
    token_budget = args.get("token_budget")
    matched = sorted(
        [n for n in graph_dict.get("nodes", []) if n.get("type") == node_type],
        key=lambda n: n.get("rank", 0), reverse=True,
    )
    if token_budget:
        result, tokens = [], 0
        for n in matched:
            cost = len(json.dumps(n)) // 4
            if tokens + cost > int(token_budget):
                break
            result.append(n)
            tokens += cost
        return {"type": node_type, "count": len(matched), "nodes": result,
                "truncated": len(result) < min(len(matched), limit)}
    return {"type": node_type, "count": len(matched), "nodes": matched[:limit]}


async def _arch(args: dict) -> dict:
    graph_dict = load_graph(args["path"])
    if not graph_dict:
        raise ValueError("No graph found. Run codegraph_build first.")
    limit = args.get("limit", 100)
    return module_map(graph_dict, limit=limit)


async def _affected(args: dict) -> dict:
    graph_dict = load_graph(args["path"])
    if not graph_dict:
        raise ValueError("No graph found. Run codegraph_build first.")
    depth = min(int(args.get("depth", 2)), 5)
    return run_affected(graph_dict, args["node"], depth=depth)


async def _filter(args: dict) -> dict:
    """Filter graph nodes by semantic properties, sorted by PageRank."""
    graph_dict = load_graph(args["path"])
    if not graph_dict:
        raise ValueError("No graph found. Run codegraph_build first.")

    nodes = graph_dict.get("nodes", [])
    edges = graph_dict.get("edges", [])

    node_by_id = {n["id"]: n for n in nodes}
    callers: dict[str, set] = {}
    callees: dict[str, set] = {}
    for e in edges:
        src, tgt = e.get("from", ""), e.get("to", "")
        callers.setdefault(tgt, set()).add(node_by_id.get(src, {}).get("name", src))
        callees.setdefault(src, set()).add(node_by_id.get(tgt, {}).get("name", tgt))

    node_type    = args.get("node_type")
    exported     = args.get("exported")
    side_effect  = args.get("side_effect")
    return_type  = args.get("return_type")
    called_by    = args.get("called_by")
    calls_name   = args.get("calls")
    file_pattern = args.get("file_pattern")
    limit        = int(args.get("limit", 20))
    token_budget = args.get("token_budget")

    matched = []
    for n in nodes:
        if node_type and n.get("type") != node_type:
            continue
        if exported is not None and bool(n.get("exported")) != bool(exported):
            continue
        if side_effect is not None and bool(n.get("side_effect")) != bool(side_effect):
            continue
        if return_type:
            if return_type.lower() not in (n.get("return_type") or "").lower():
                continue
        if called_by:
            nid = n.get("id", "")
            if called_by.lower() not in {c.lower() for c in callers.get(nid, set())}:
                continue
        if calls_name:
            nid = n.get("id", "")
            if calls_name.lower() not in {c.lower() for c in callees.get(nid, set())}:
                continue
        if file_pattern:
            from fnmatch import fnmatch
            if not fnmatch(n.get("file", ""), file_pattern.replace("\\", "/")):
                continue
        matched.append(n)

    matched.sort(key=lambda n: n.get("rank", 0), reverse=True)

    if token_budget:
        result_nodes, tokens = [], 0
        for n in matched:
            cost = len(json.dumps(n)) // 4
            if tokens + cost > int(token_budget):
                break
            result_nodes.append(n)
            tokens += cost
        return {"nodes": result_nodes, "count": len(matched),
                "truncated": len(result_nodes) < min(len(matched), limit)}

    return {"nodes": matched[:limit], "count": len(matched), "truncated": len(matched) > limit}


async def _export_viz(args: dict) -> dict:
    graph_dict = load_graph(args["path"])
    if not graph_dict:
        raise ValueError("No graph found. Run codegraph_build first.")
    cache_dir = str(Path(args["path"]) / "codegraph-cache")
    formats = args.get("formats") or ["html", "graphml", "obsidian", "tree", "callflow"]
    results: dict[str, str] = {}
    if "html" in formats:
        try:
            results["html"] = export_html(graph_dict, str(Path(cache_dir) / "graph.html"))
        except Exception as e:
            results["html_error"] = str(e)
    if "graphml" in formats:
        try:
            results["graphml"] = to_graphml(graph_dict, str(Path(cache_dir) / "graph.graphml"))
        except Exception as e:
            results["graphml_error"] = str(e)
    if "obsidian" in formats:
        try:
            results["obsidian"] = to_obsidian(graph_dict, str(Path(cache_dir) / "obsidian"))
        except Exception as e:
            results["obsidian_error"] = str(e)
    if "tree" in formats:
        try:
            results["tree"] = tree_html(graph_dict, str(Path(cache_dir) / "tree.html"))
        except Exception as e:
            results["tree_error"] = str(e)
    if "callflow" in formats:
        try:
            results["callflow"] = callflow_html(graph_dict, str(Path(cache_dir) / "callflow.html"))
        except Exception as e:
            results["callflow_error"] = str(e)
    results["summary"] = f"Generated: {', '.join(k for k in results if not k.endswith('_error'))}"
    return results


# ── Entry point ───────────────────────────────────────────────────────────────

async def _async_main():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


def main():
    """Sync entry point — required by pyproject.toml [project.scripts]."""
    asyncio.run(_async_main())


if __name__ == "__main__":
    main()
