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

    def test_relation_aware_expansion_prefers_call_chain_over_import_noise(self):
        graph = {
            "nodes": [
                {"id": "root", "name": "AuthService", "type": "class", "file": "auth.py", "rank": 0.5},
                {"id": "caller", "name": "login", "type": "function", "file": "api.py", "rank": 0.4},
                {"id": "dep", "name": "TokenStore", "type": "class", "file": "token.py", "rank": 0.4},
                {"id": "noise", "name": "Config", "type": "module", "file": "config.py", "rank": 0.99},
            ],
            "edges": [
                {"from": "caller", "to": "root", "relation": "calls"},
                {"from": "root", "to": "dep", "relation": "imports"},
                {"from": "root", "to": "noise", "relation": "relates-to"},
            ],
        }

        result = context_subgraph("AuthService", graph, max_hops=1, top_k=1, token_budget=1000)

        self.assertEqual(result["seed_nodes"], ["root"])
        self.assertEqual([node["id"] for node in result["nodes"]], ["root", "caller", "dep", "noise"])
        self.assertTrue(all(node.get("selection_reason") for node in result["nodes"]))
        self.assertEqual(result["candidate_count"], 4)

    def test_budget_reports_per_item_drop_reasons_and_never_exceeds_budget(self):
        result = context_subgraph("AuthService", self.graph, max_hops=2, token_budget=18)

        self.assertLessEqual(result["tokens_used"], result["token_budget"])
        self.assertIn("drop_reasons", result)
        self.assertTrue(result["drop_reasons"])


if __name__ == "__main__":
    unittest.main()
