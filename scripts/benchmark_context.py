"""Offline benchmark for the context subgraph retriever.

Usage: python scripts/benchmark_context.py [--budget 160]
The benchmark is deterministic and does not call an external model or API.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from codegraph.graph.query import context_subgraph
from codegraph.tokenizer import count_tokens


GRAPH = {
    "nodes": [
        {"id": "api", "name": "login", "type": "function", "file": "src/api.py", "rank": 0.9},
        {"id": "auth", "name": "AuthService", "type": "class", "file": "src/auth.py", "rank": 0.85},
        {"id": "token", "name": "TokenStore", "type": "class", "file": "src/token.py", "rank": 0.7},
        {"id": "db", "name": "Database", "type": "class", "file": "src/db.py", "rank": 0.6},
        {"id": "audit", "name": "AuditLogger", "type": "class", "file": "src/audit.py", "rank": 0.2},
        {"id": "config", "name": "Config", "type": "module", "file": "src/config.py", "rank": 0.1},
    ],
    "edges": [
        {"from": "api", "to": "auth", "relation": "calls"},
        {"from": "auth", "to": "token", "relation": "calls"},
        {"from": "token", "to": "db", "relation": "imports"},
        {"from": "auth", "to": "audit", "relation": "calls"},
        {"from": "auth", "to": "config", "relation": "relates-to"},
    ],
}

CASES = [
    {"question": "AuthService", "expected": {"auth", "token", "db"}},
    {"question": "what calls Database", "expected": {"token"}},
    {"question": "login", "expected": {"api", "auth"}},
]


def run(budget: int) -> dict:
    latencies = []
    recalls = []
    path_hits = []
    budget_ok = True
    raw_tokens = count_tokens(json.dumps(GRAPH, ensure_ascii=False))
    compressed_tokens = []

    for case in CASES:
        started = time.perf_counter()
        result = context_subgraph(case["question"], GRAPH, max_hops=2, top_k=3, token_budget=budget)
        latencies.append((time.perf_counter() - started) * 1000)
        returned = {node["id"] for node in result["nodes"]}
        recalls.append(len(returned & case["expected"]) / len(case["expected"]))
        path_hits.append(sum(bool(node.get("path_edges")) for node in result["nodes"][1:]) / max(1, len(result["nodes"]) - 1))
        budget_ok = budget_ok and result["tokens_used"] <= budget
        compressed_tokens.append(result["tokens_used"])

    return {
        "cases": len(CASES),
        "token_budget": budget,
        "top_k_recall": round(statistics.mean(recalls), 4),
        "path_accuracy": round(statistics.mean(path_hits), 4),
        "avg_latency_ms": round(statistics.mean(latencies), 3),
        "p95_latency_ms": round(sorted(latencies)[min(len(latencies) - 1, int(len(latencies) * 0.95))], 3),
        "budget_compliant": budget_ok,
        "raw_graph_tokens": raw_tokens,
        "avg_context_tokens": round(statistics.mean(compressed_tokens), 2),
        "compression_ratio": round(raw_tokens / max(1, statistics.mean(compressed_tokens)), 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--budget", type=int, default=160)
    args = parser.parse_args()
    print(json.dumps(run(max(1, args.budget)), indent=2))


if __name__ == "__main__":
    main()
