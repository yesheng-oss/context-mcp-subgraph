"""
codegraph/__main__.py — stdin/stdout dispatcher for Node.js integration.
Reads {"tool": "codegraph_build", "args": {...}} from stdin, writes result JSON to stdout.
"""

import json
import sys
import asyncio

from .server import _dispatch


def main():
    try:
        payload = json.loads(sys.stdin.read())
        result = asyncio.run(_dispatch(payload["tool"], payload["args"]))
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
