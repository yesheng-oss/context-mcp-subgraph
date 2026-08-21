import unittest

from codegraph.graph.query import context_subgraph


class ContextSubgraphTests(unittest.TestCase):
    def setUp(self):
        self.graph = {
            "nodes": [
                {"id": "a", "name": "AuthService", "type": "class", "file": "src/auth.py", "rank": 0.9},
                {"id": "b", "name": "TokenStore", "type": "class", "file": "src/token.py", "rank": 0.8},
                {"id": "c", "name": "Database", "type": "module", "file": "src/db.py", "rank": 0.7},
                {"id": "d", "name": "Unrelated", "type": "class", "file": "src/other.py", "rank": 0.1},
            ],
            "edges": [
                {"from": "a", "to": "b", "relation": "calls"},
                {"from": "b", "to": "c", "relation": "imports"},
                {"from": "c", "to": "d", "relation": "imports"},
            ],
        }

    def test_expands_seed_nodes_by_bounded_hops_and_returns_paths(self):
        result = context_subgraph("AuthService", self.graph, max_hops=2, token_budget=1000)

        self.assertEqual(result["seed_nodes"], ["a"])
        self.assertEqual([node["id"] for node in result["nodes"]], ["a", "b", "c"])
        self.assertEqual(
            [(edge["from"], edge["to"], edge["relation"]) for edge in result["edges"]],
            [("a", "b", "calls"), ("b", "c", "imports")],
        )
        self.assertEqual(result["nodes"][1]["depth"], 1)
        self.assertEqual(result["nodes"][2]["depth"], 2)

    def test_budget_keeps_high_value_nodes_and_reports_dropped_candidates(self):
        result = context_subgraph("AuthService", self.graph, max_hops=3, token_budget=30)

        self.assertEqual(result["nodes"][0]["id"], "a")
        self.assertTrue(result["truncated"])
        self.assertGreater(result["dropped_count"], 0)
        self.assertTrue(result["has_more"])
        self.assertLessEqual(result["tokens_used"], 30)

    def test_empty_query_returns_ranked_high_signal_seeds(self):
        result = context_subgraph("", self.graph, max_hops=0, top_k=2, token_budget=1000)

        self.assertEqual([node["id"] for node in result["nodes"]], ["a", "b"])
        self.assertEqual(result["seed_nodes"], ["a", "b"])


if __name__ == "__main__":
    unittest.main()
