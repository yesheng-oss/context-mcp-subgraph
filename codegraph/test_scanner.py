import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from codegraph.cache import save_cache, set_cached_nodes
from codegraph.scanner import scan


class ScannerCacheTests(unittest.TestCase):
    def test_unchanged_file_uses_stat_cache_without_rehashing(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "main.py"
            path.write_text("def main():\n    return 1\n", encoding="utf-8")
            cache = {}
            set_cached_nodes(cache, "main.py", "old-hash", [{"id": "main"}], str(path))
            save_cache(root, cache)

            with patch("codegraph.cache.file_hash", side_effect=AssertionError("unexpected hash")):
                result = scan(root)

            self.assertEqual(result["cached"], {"main.py": [{"id": "main"}]})
            self.assertEqual(result["changed"], {})
            self.assertEqual(result["scanned"], 1)
            self.assertEqual(result["cache_hit_rate"], 1.0)


if __name__ == "__main__":
    unittest.main()
