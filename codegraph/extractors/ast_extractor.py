"""
ast_extractor.py — extract AST nodes from code files.
Tries tree-sitter first; falls back to regex if grammar not installed.
"""

from __future__ import annotations
import re
from pathlib import Path
from typing import Any

try:
    from tree_sitter import Language, Parser, Node as TSNode
    _TS_AVAILABLE = True
except ImportError:
    _TS_AVAILABLE = False

# ── Language registry ─────────────────────────────────────────────────────────
# pkg: importable package name  fn: function returning Language object
_REGISTRY: dict[str, dict] = {
    "python": {
        "pkg": "tree_sitter_python", "fn": "language",
        "ext": {".py", ".pyw"},
        "function_types": {"function_definition"},
        "class_types":    {"class_definition"},
        "import_types":   {"import_statement", "import_from_statement"},
        "call_types":     {"call"},
        "name_field":     "name",
        "call_field":     "function",
    },
    "javascript": {
        "pkg": "tree_sitter_javascript", "fn": "language",
        "ext": {".js", ".mjs", ".cjs", ".jsx"},
        "function_types": {
            "function_declaration", "function_expression",
            "arrow_function", "method_definition",
            "generator_function_declaration",
        },
        "class_types":    {"class_declaration", "class_expression"},
        "import_types":   {"import_statement"},
        "call_types":     {"call_expression"},
        "name_field":     "name",
        "call_field":     "function",
    },
    "typescript": {
        "pkg": "tree_sitter_typescript", "fn": "language_typescript",
        "ext": {".ts", ".mts", ".cts"},
        "function_types": {
            "function_declaration", "function_expression",
            "arrow_function", "method_definition",
            "method_signature", "abstract_method_signature",
        },
        "class_types":    {
            "class_declaration", "class_expression",
            "interface_declaration", "type_alias_declaration",
        },
        "import_types":   {"import_statement"},
        "call_types":     {"call_expression"},
        "name_field":     "name",
        "call_field":     "function",
    },
    "tsx": {
        "pkg": "tree_sitter_typescript", "fn": "language_tsx",
        "ext": {".tsx"},
        "function_types": {
            "function_declaration", "function_expression",
            "arrow_function", "method_definition",
        },
        "class_types":    {"class_declaration", "interface_declaration"},
        "import_types":   {"import_statement"},
        "call_types":     {"call_expression"},
        "name_field":     "name",
        "call_field":     "function",
    },
    "go": {
        "pkg": "tree_sitter_go", "fn": "language",
        "ext": {".go"},
        "function_types": {"function_declaration", "method_declaration"},
        "class_types":    {"type_declaration"},
        "import_types":   {"import_declaration"},
        "call_types":     {"call_expression"},
        "name_field":     "name",
        "call_field":     "function",
    },
    "rust": {
        "pkg": "tree_sitter_rust", "fn": "language",
        "ext": {".rs"},
        "function_types": {"function_item"},
        "class_types":    {"struct_item", "enum_item", "trait_item", "impl_item"},
        "import_types":   {"use_declaration"},
        "call_types":     {"call_expression"},
        "name_field":     "name",
        "call_field":     "function",
    },
    "java": {
        "pkg": "tree_sitter_java", "fn": "language",
        "ext": {".java"},
        "function_types": {"method_declaration", "constructor_declaration"},
        "class_types":    {
            "class_declaration", "interface_declaration",
            "enum_declaration", "annotation_type_declaration",
        },
        "import_types":   {"import_declaration"},
        "call_types":     {"method_invocation"},
        "name_field":     "name",
        "call_field":     "name",
    },
    "kotlin": {
        "pkg": "tree_sitter_kotlin", "fn": "language",
        "ext": {".kt"},
        "function_types": {"function_declaration", "anonymous_function"},
        "class_types":    {"class_declaration", "interface_declaration", "object_declaration"},
        "import_types":   {"import_header"},
        "call_types":     {"call_expression"},
        "name_field":     "simple_identifier",
        "call_field":     "call_suffix",
    },
    "c": {
        "pkg": "tree_sitter_c", "fn": "language",
        "ext": {".c", ".h"},
        "function_types": {"function_definition"},
        "class_types":    {"struct_specifier", "enum_specifier", "union_specifier"},
        "import_types":   {"preproc_include"},
        "call_types":     {"call_expression"},
        "name_field":     "declarator",
        "call_field":     "function",
    },
    "cpp": {
        "pkg": "tree_sitter_cpp", "fn": "language",
        "ext": {".cpp", ".cc", ".cxx", ".hpp", ".hh"},
        "function_types": {"function_definition"},
        "class_types":    {
            "class_specifier", "struct_specifier",
            "enum_specifier", "namespace_definition",
        },
        "import_types":   {"preproc_include"},
        "call_types":     {"call_expression"},
        "name_field":     "declarator",
        "call_field":     "function",
    },
    "csharp": {
        "pkg": "tree_sitter_c_sharp", "fn": "language",
        "ext": {".cs"},
        "function_types": {"method_declaration", "constructor_declaration", "local_function_statement"},
        "class_types":    {
            "class_declaration", "interface_declaration",
            "struct_declaration", "enum_declaration", "record_declaration",
        },
        "import_types":   {"using_directive"},
        "call_types":     {"invocation_expression"},
        "name_field":     "name",
        "call_field":     "expression",
    },
    "ruby": {
        "pkg": "tree_sitter_ruby", "fn": "language",
        "ext": {".rb", ".rake"},
        "function_types": {"method", "singleton_method"},
        "class_types":    {"class", "module"},
        "import_types":   set(),
        "call_types":     {"call"},
        "name_field":     "name",
        "call_field":     "method",
    },
    "php": {
        "pkg": "tree_sitter_php", "fn": "language",
        "ext": {".php"},
        "function_types": {"function_definition", "method_declaration"},
        "class_types":    {"class_declaration", "interface_declaration", "trait_declaration"},
        "import_types":   {"namespace_use_declaration"},
        "call_types":     {"function_call_expression", "member_call_expression"},
        "name_field":     "name",
        "call_field":     "function",
    },
    "swift": {
        "pkg": "tree_sitter_swift", "fn": "language",
        "ext": {".swift"},
        "function_types": {"function_declaration"},
        "class_types":    {
            "class_declaration", "struct_declaration",
            "protocol_declaration", "extension_declaration",
        },
        "import_types":   {"import_declaration"},
        "call_types":     {"call_expression"},
        "name_field":     "name",
        "call_field":     "function",
    },
    "lua": {
        "pkg": "tree_sitter_lua", "fn": "language",
        "ext": {".lua", ".luau"},
        "function_types": {"function_declaration", "local_function"},
        "class_types":    set(),
        "import_types":   set(),
        "call_types":     {"function_call"},
        "name_field":     "name",
        "call_field":     "name",
    },
    "dart": {
        "pkg": "tree_sitter_dart", "fn": "language",
        "ext": {".dart"},
        "function_types": {"function_signature", "method_signature"},
        "class_types":    {"class_definition", "mixin_declaration"},
        "import_types":   {"import_or_export"},
        "call_types":     {"invocation_expression"},
        "name_field":     "name",
        "call_field":     "function_expression",
    },
}

# Extension → language config lookup
_EXT_TO_LANG: dict[str, dict] = {}
for _lang, _cfg in _REGISTRY.items():
    for _ext in _cfg["ext"]:
        _EXT_TO_LANG[_ext] = _cfg

# ── Grammar cache ─────────────────────────────────────────────────────────────
_GRAMMAR_CACHE: dict[str, Any] = {}


def _get_language(cfg: dict) -> "Language | None":
    key = f"{cfg['pkg']}.{cfg['fn']}"
    if key in _GRAMMAR_CACHE:
        return _GRAMMAR_CACHE[key]
    try:
        import importlib
        mod  = importlib.import_module(cfg["pkg"])
        lang = Language(getattr(mod, cfg["fn"])())
        _GRAMMAR_CACHE[key] = lang
        return lang
    except Exception:
        _GRAMMAR_CACHE[key] = None
        return None


# ── Tree walker ───────────────────────────────────────────────────────────────

def _walk(node: "TSNode", target_types: set[str]):
    if node.type in target_types:
        yield node
    for child in node.children:
        yield from _walk(child, target_types)


def _get_name(node: "TSNode", name_field: str) -> str | None:
    named = node.child_by_field_name(name_field)
    if named:
        return named.text.decode("utf-8", errors="ignore").strip()
    for child in node.children:
        if child.type in {"identifier", "name", "simple_identifier",
                          "property_identifier", "type_identifier"}:
            return child.text.decode("utf-8", errors="ignore").strip()
    return None


def _get_call_name(node: "TSNode", call_field: str) -> str | None:
    func = node.child_by_field_name(call_field)
    if not func:
        return None
    text = func.text.decode("utf-8", errors="ignore").strip()
    return text.split(".")[-1] if "." in text else text


def _find_enclosing_function(
    node: "TSNode",
    function_types: set[str],
    name_field: str,
) -> str | None:
    parent = node.parent
    while parent:
        if parent.type in function_types:
            return _get_name(parent, name_field)
        parent = parent.parent
    return None


# ── Enrichment helpers ────────────────────────────────────────────────────────

_SIDE_EFFECT_KEYWORDS = frozenset([
    "write(", "update(", "delete(", "insert(", "save(", "emit(", "send(",
    "fetch(", ".http", "db.", "fs.", "socket", "console.", ".log(",
    "print(", "request(", "axios", "subprocess", "os.system", "os.remove",
])


def _has_side_effect(body_text: str) -> bool:
    lower = body_text.lower()
    return any(kw in lower for kw in _SIDE_EFFECT_KEYWORDS)


def _is_exported(ts_node: "TSNode") -> bool:
    """True if function/class is public/exported."""
    parent = ts_node.parent
    if parent and parent.type in {
        "export_statement", "export_declaration", "exported_identifier",
    }:
        return True
    if parent and parent.text:
        text = parent.text.decode("utf-8", errors="ignore")[:20]
        if text.strip().startswith("pub "):
            return True
    # Python: public if name doesn't start with _
    name_node = ts_node.child_by_field_name("name")
    if name_node:
        name = name_node.text.decode("utf-8", errors="ignore")
        return not name.startswith("_")
    return True


def _get_docstring(ts_node: "TSNode") -> str:
    """Extract first docstring or comment from function/class body."""
    body = ts_node.child_by_field_name("body")
    if not body:
        return ""
    for child in body.children:
        if child.type == "expression_statement":
            for gc in child.children:
                if gc.type in {"string", "concatenated_string"}:
                    raw = gc.text.decode("utf-8", errors="ignore").strip()
                    raw = raw.strip('"""').strip("'''").strip('"').strip("'").strip()
                    if raw and len(raw) < 400:
                        return raw
        if child.type in {"comment", "block_comment", "line_comment"}:
            raw = child.text.decode("utf-8", errors="ignore").strip()
            raw = re.sub(r'^[/*#!\s]+', '', raw).strip()
            raw = re.sub(r'\s*\*/$', '', raw).strip()
            if raw and len(raw) < 400:
                return raw
    return ""


def _get_return_type(ts_node: "TSNode") -> str:
    """Extract return type annotation string."""
    rt = ts_node.child_by_field_name("return_type")
    if rt:
        return rt.text.decode("utf-8", errors="ignore").lstrip("->").lstrip(":").strip()
    past_params = False
    for child in ts_node.children:
        if child.type in {"formal_parameters", "parameters"}:
            past_params = True
        if past_params and child.type in {"type_annotation", "return_type"}:
            return child.text.decode("utf-8", errors="ignore").lstrip(":").strip()
    return ""


def _get_params(ts_node: "TSNode") -> list:
    """Extract parameter list as [{name, type, optional}]."""
    params_node = ts_node.child_by_field_name("parameters")
    if not params_node:
        return []
    result = []
    for child in params_node.children:
        if child.type in {
            "identifier", "required_parameter", "optional_parameter",
            "typed_parameter", "default_parameter", "rest_parameter",
            "typed_default_parameter",
        }:
            name_node = child.child_by_field_name("name") or (
                child if child.type == "identifier" else None
            )
            type_node = child.child_by_field_name("type")
            if not name_node:
                continue
            param_name = name_node.text.decode("utf-8", errors="ignore").strip("?").strip()
            param_type = (
                type_node.text.decode("utf-8", errors="ignore").lstrip(":").strip()
                if type_node else ""
            )
            optional = child.type == "optional_parameter" or "?" in name_node.text.decode()
            if param_name and not param_name.startswith("("):
                result.append({"name": param_name, "type": param_type, "optional": optional})
    return result


def _get_signature(ts_node: "TSNode", source: bytes, name: str) -> str:
    """Return first logical line(s) of a function/class declaration (no body)."""
    lines = source.decode("utf-8", errors="ignore").splitlines()
    start = ts_node.start_point[0]
    end   = ts_node.end_point[0]
    sig_lines = []
    for i in range(start, min(start + 5, end + 1)):
        sig_lines.append(lines[i].strip() if i < len(lines) else "")
        l = lines[i] if i < len(lines) else ""
        if l.rstrip().endswith("{") or re.search(r':\s*(?:#.*)?$', l):
            break
    sig = " ".join(sig_lines)
    sig = re.sub(r'\s*\{.*$', '', sig)
    sig = re.sub(r'\s*:\s*(?:#.*)?$', '', sig).strip()
    return sig or name


def _get_last_modified(abs_path: str) -> str:
    """Return ISO timestamp of last git commit touching this file, or empty string."""
    import subprocess
    try:
        r = subprocess.run(
            ["git", "log", "-1", "--format=%cI", "--", abs_path],
            capture_output=True, text=True, timeout=5,
        )
        ts = r.stdout.strip()
        return ts if ts else ""
    except Exception:
        return ""


def _extract_with_treesitter(source: bytes, rel_path: str, cfg: dict) -> list[dict]:
    lang = _get_language(cfg)
    if lang is None:
        return []

    parser = Parser(lang)
    tree   = parser.parse(source)
    root   = tree.root_node

    nodes: list[dict] = []
    seen:  set[str]   = set()
    node_by_name: dict[str, dict] = {}

    def _add(name: str, ntype: str, line: int) -> dict | None:
        if not name or name in seen:
            return None
        seen.add(name)
        entry = {
            "id":      f"{rel_path}::{ntype}::{name}",
            "name":    name,
            "type":    ntype,
            "file":    rel_path,
            "line":    line + 1,
            "calls":   [],
            "imports": [],
        }
        nodes.append(entry)
        node_by_name[name] = entry
        return entry

    for node in _walk(root, cfg["function_types"]):
        name = _get_name(node, cfg["name_field"])
        if name:
            entry = _add(name, "function", node.start_point[0])
            if entry:
                entry["signature"]   = _get_signature(node, source, name)
                entry["params"]      = _get_params(node)
                entry["return_type"] = _get_return_type(node)
                entry["docstring"]   = _get_docstring(node)
                entry["exported"]    = _is_exported(node)
                entry["complexity"]  = node.end_point[0] - node.start_point[0] + 1
                body_text = source[node.start_byte:node.end_byte].decode("utf-8", errors="ignore")
                entry["side_effect"] = _has_side_effect(body_text)

    for node in _walk(root, cfg["class_types"]):
        name = _get_name(node, cfg["name_field"])
        if name:
            entry = _add(name, "class", node.start_point[0])
            if entry:
                entry["signature"]  = _get_signature(node, source, name)
                entry["docstring"]  = _get_docstring(node)
                entry["exported"]   = _is_exported(node)
                entry["complexity"] = node.end_point[0] - node.start_point[0] + 1
                entry["inherits"]   = []
                entry["implements"] = []

    # ── Inheritance / implements extraction ───────────────────────────────────
    for node in _walk(root, cfg["class_types"]):
        name = _get_name(node, cfg["name_field"])
        if not name or name not in node_by_name:
            continue
        entry = node_by_name[name]
        if "inherits" not in entry:
            entry["inherits"] = []
            entry["implements"] = []

        for child in node.children:
            # TypeScript / JavaScript: class_heritage > extends_clause / implements_clause
            if child.type == "class_heritage":
                for hc in child.children:
                    if hc.type == "extends_clause":
                        for ec in hc.children:
                            if ec.type in {"identifier", "type_identifier"}:
                                entry["inherits"].append(
                                    ec.text.decode("utf-8", errors="ignore").strip()
                                )
                    elif hc.type == "implements_clause":
                        for ic in hc.children:
                            if ic.type in {"identifier", "type_identifier", "generic_type"}:
                                t = ic.text.decode("utf-8", errors="ignore").strip()
                                t = t.split("<")[0].strip()
                                if t and t not in (",",):
                                    entry["implements"].append(t)
            # Python: class Foo(Base1, Base2):
            elif child.type == "argument_list":
                for ac in child.children:
                    if ac.type == "identifier":
                        entry["inherits"].append(
                            ac.text.decode("utf-8", errors="ignore").strip()
                        )
            # Java / C#: superclass / base_list
            elif child.type in {"superclass", "base_list"}:
                for sc in child.children:
                    if sc.type in {"type_identifier", "identifier"}:
                        entry["inherits"].append(
                            sc.text.decode("utf-8", errors="ignore").strip()
                        )
            elif child.type in {"super_interfaces", "interface_type_list"}:
                for ic in child.children:
                    if ic.type in {"type_identifier", "identifier"}:
                        entry["implements"].append(
                            ic.text.decode("utf-8", errors="ignore").strip()
                        )

    # Associate call expressions with their enclosing function
    for node in _walk(root, cfg["call_types"]):
        callee = _get_call_name(node, cfg["call_field"])
        if not callee:
            continue
        enclosing = _find_enclosing_function(node, cfg["function_types"], cfg["name_field"])
        if enclosing and enclosing in node_by_name:
            calls_list = node_by_name[enclosing]["calls"]
            if callee not in calls_list:
                calls_list.append(callee)

    # Collect file-level imports and attach to every node in this file
    import_names: list[str] = []
    for node in _walk(root, cfg["import_types"]):
        text = node.text.decode("utf-8", errors="ignore").strip()
        raw = None
        # Try 'from "module"' or "from 'module'" first (JS/TS/Python)
        m = re.search(r'from\s+["\']([^"\']+)["\']', text)
        if m:
            raw = m.group(1)
        if not raw:
            # Plain: import module or import "module"
            m = re.search(r'import\s+["\']?([a-zA-Z_][\w./\\-]*)["\']?', text)
            if m:
                raw = m.group(1)
        if not raw:
            # require("module")
            m = re.search(r'require\s*\(\s*["\']([^"\']+)["\']\s*\)', text)
            if m:
                raw = m.group(1)
        if raw:
            stem = raw.strip("\"'").replace("\\", "/").split("/")[-1].split(".")[0]
            if stem and stem not in import_names:
                import_names.append(stem)
    # For languages with empty import_types (Ruby, Lua), fall back to regex
    if not import_names and not cfg.get("import_types"):
        source_str = source_bytes.decode("utf-8", errors="ignore")
        ext = Path(rel_path).suffix.lower()
        lang_name = _EXT_TO_LANG_NAME.get(ext, "")
        import_names = _collect_imports_regex(source_str, lang_name)

    # Always assign (empty list is valid — don't gate on non-empty)
    for entry in nodes:
        entry["imports"] = import_names[:]

    return nodes


# ── Regex fallbacks ───────────────────────────────────────────────────────────

_REGEX_PATTERNS: dict[str, dict[str, str | None]] = {
    "python": {
        "function": r"^(?:async\s+)?def\s+([a-zA-Z_]\w*)\s*\(",
        "class":    r"^class\s+([a-zA-Z_]\w*)\s*[:\(]",
    },
    "javascript": {
        "function": r"(?:function\s+([a-zA-Z_$]\w*)|([a-zA-Z_$]\w*)\s*[:=]\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>))",
        "class":    r"class\s+([a-zA-Z_$]\w*)",
    },
    "typescript": {
        "function": r"(?:function\s+([a-zA-Z_$]\w*)|([a-zA-Z_$]\w*)\s*[:=]\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>))",
        "class":    r"(?:class|interface)\s+([a-zA-Z_$]\w*)",
    },
    "go": {
        "function": r"^func\s+(?:\([^)]*\)\s+)?([a-zA-Z_]\w*)\s*\(",
        "class":    r"^type\s+([a-zA-Z_]\w*)\s+(?:struct|interface)",
    },
    "rust": {
        "function": r"^(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_]\w*)",
        "class":    r"^(?:pub\s+)?(?:struct|enum|trait|impl)\s+([a-zA-Z_]\w*)",
    },
    "java": {
        "function": r"(?:public|private|protected|static|\s)+[\w<>\[\]]+\s+([a-zA-Z_]\w*)\s*\(",
        "class":    r"(?:class|interface|enum)\s+([a-zA-Z_]\w*)",
    },
    "c": {
        "function": r"^[a-zA-Z_][\w\s\*]+\s+([a-zA-Z_]\w*)\s*\([^;]*\)\s*\{",
        "class":    r"^(?:struct|enum|union)\s+([a-zA-Z_]\w*)",
    },
    "cpp": {
        "function": r"(?:[\w:~]+\s+)+([a-zA-Z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{",
        "class":    r"(?:class|struct|enum|namespace)\s+([a-zA-Z_]\w*)",
    },
    "ruby": {
        "function": r"^\s*def\s+([a-zA-Z_]\w*[?!]?)",
        "class":    r"^\s*(?:class|module)\s+([A-Z]\w*)",
    },
    "csharp": {
        "function": r"(?:public|private|protected|static|\s)+[\w<>\[\]]+\s+([a-zA-Z_]\w*)\s*\(",
        "class":    r"(?:class|interface|struct|enum|record)\s+([a-zA-Z_]\w*)",
    },
    "php": {
        "function": r"^\s*(?:public|private|protected|static|\s)*function\s+([a-zA-Z_]\w*)",
        "class":    r"^\s*(?:abstract\s+)?(?:class|interface|trait)\s+([a-zA-Z_]\w*)",
    },
    "swift": {
        "function": r"^\s*(?:public|private|internal|open|\s)*func\s+([a-zA-Z_]\w*)",
        "class":    r"^\s*(?:public|private|internal|open|\s)*(?:class|struct|protocol|extension|enum)\s+([a-zA-Z_]\w*)",
    },
    "lua": {
        "function": r"(?:local\s+)?function\s+([a-zA-Z_]\w*)",
        "class":    None,
    },
}

_EXT_TO_LANG_NAME: dict[str, str] = {
    ".py": "python", ".pyw": "python",
    ".js": "javascript", ".mjs": "javascript", ".jsx": "javascript",
    ".ts": "typescript", ".tsx": "typescript",
    ".go": "go",
    ".rs": "rust",
    ".java": "java", ".kt": "java",
    ".c": "c", ".h": "c",
    ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
    ".cs": "csharp",
    ".rb": "ruby", ".rake": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".lua": "lua", ".luau": "lua",
}


# Generic call pattern: word immediately followed by (
_CALL_RE = re.compile(r'\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(')

# Language-specific import patterns (group 1 or 2 = module name)
_IMPORT_RE: dict[str, re.Pattern] = {
    "javascript": re.compile(
        r'(?:import\s+[\s\S]*?from\s+["\']([^"\']+)["\']'
        r'|require\s*\(\s*["\']([^"\']+)["\']\s*\))',
        re.MULTILINE,
    ),
    "typescript": re.compile(
        r'(?:import\s+[\s\S]*?from\s+["\']([^"\']+)["\']'
        r'|require\s*\(\s*["\']([^"\']+)["\']\s*\))',
        re.MULTILINE,
    ),
    "python": re.compile(
        r'^\s*(?:import\s+([\w.]+)|from\s+([\w.]+)\s+import)',
        re.MULTILINE,
    ),
    "go": re.compile(r'"([^"]+)"', re.MULTILINE),
    "rust": re.compile(r'use\s+([\w:]+)', re.MULTILINE),
    "java": re.compile(r'import\s+([\w.]+)', re.MULTILINE),
    "csharp": re.compile(r'using\s+([\w.]+)', re.MULTILINE),
    "ruby": re.compile(r'require(?:_relative)?\s*["\']([^"\']+)["\']', re.MULTILINE),
    "lua": re.compile(r'require\s*\(?["\']([^"\']+)["\']\)?', re.MULTILINE),
    "c": re.compile(r'#include\s+[<"]([^>"]+)[>"]', re.MULTILINE),
    "cpp": re.compile(r'#include\s+[<"]([^>"]+)[>"]', re.MULTILINE),
    "dart": re.compile(r'import\s+["\']([^"\']+)["\']', re.MULTILINE),
    "swift": re.compile(r'^import\s+([\w.]+)', re.MULTILINE),
}

# Keywords that look like calls but aren't
_KEYWORD_BLACKLIST = {
    "if", "for", "while", "switch", "catch", "function", "class",
    "return", "typeof", "instanceof", "new", "await", "async",
    "import", "export", "from", "let", "const", "var",
}


def _collect_imports_regex(source: str, lang: str) -> list[str]:
    pat = _IMPORT_RE.get(lang)
    if not pat:
        return []
    names: list[str] = []
    seen: set[str] = set()
    for m in pat.finditer(source):
        raw = next((g for g in m.groups() if g), None)
        if not raw:
            continue
        # Keep only the last path component / first dotted segment
        stem = raw.replace("\\", "/").split("/")[-1].split(".")[0].strip("'\"")
        if stem and stem not in seen:
            seen.add(stem)
            names.append(stem)
    return names


def _attach_calls_brace(lines: list[str], func_nodes: list[dict]) -> None:
    """Brace-count scope tracker: assign call-expression names to enclosing function."""
    # Sort functions by line
    funcs = sorted(func_nodes, key=lambda n: n["line"])
    if not funcs:
        return

    # Stack: list of (func_node, brace_depth_at_entry)
    stack: list[tuple[dict, int]] = []
    depth = 0
    func_idx = 0

    for line_no, line in enumerate(lines, 1):
        # Push any functions that start on this line
        while func_idx < len(funcs) and funcs[func_idx]["line"] == line_no:
            stack.append((funcs[func_idx], depth))
            func_idx += 1

        depth += line.count("{") - line.count("}")

        # Pop functions whose scope has closed
        while stack and depth < stack[-1][1]:
            stack.pop()

        # Collect calls on this line and attach to innermost function
        if stack:
            current = stack[-1][0]
            for m in _CALL_RE.finditer(line):
                callee = m.group(1)
                if callee in _KEYWORD_BLACKLIST or callee == current["name"]:
                    continue
                calls = current["calls"]
                if callee not in calls:
                    calls.append(callee)


def _extract_with_regex(source: str, rel_path: str, ext: str) -> list[dict]:
    lang = _EXT_TO_LANG_NAME.get(ext.lower())
    if not lang or lang not in _REGEX_PATTERNS:
        return []

    patterns = _REGEX_PATTERNS[lang]
    lines = source.splitlines()
    nodes: list[dict] = []
    seen: set[str] = set()

    import_names = _collect_imports_regex(source, lang)

    for line_no, line in enumerate(lines, 1):
        for ntype, pattern in patterns.items():
            if not pattern:
                continue
            m = re.search(pattern, line)
            if m:
                name = next((g for g in m.groups() if g), None)
                if name and name not in seen:
                    seen.add(name)
                    nodes.append({
                        "id":      f"{rel_path}::{ntype}::{name}",
                        "name":    name,
                        "type":    ntype,
                        "file":    rel_path,
                        "line":    line_no,
                        "calls":   [],
                        "imports": import_names[:],
                    })

    # brace-scope tracking only works for brace-delimited languages
    _BRACE_LANGS = {"javascript", "typescript", "go", "rust", "java", "c", "cpp", "csharp", "php", "swift"}
    func_nodes = [n for n in nodes if n["type"] == "function"]
    if func_nodes and lang in _BRACE_LANGS:
        _attach_calls_brace(lines, func_nodes)

    return nodes


# ── Public interface ──────────────────────────────────────────────────────────

def extract(abs_path: str, rel_path: str) -> list[dict]:
    """
    Extract AST nodes from a code file.
    Tries tree-sitter first; falls back to regex if grammar not installed.
    """
    ext = Path(abs_path).suffix.lower()
    cfg = _EXT_TO_LANG.get(ext)

    try:
        source_bytes = Path(abs_path).read_bytes()
    except Exception:
        return []

    if _TS_AVAILABLE and cfg:
        nodes = _extract_with_treesitter(source_bytes, rel_path, cfg)
        if nodes:
            last_mod = _get_last_modified(abs_path)
            for n in nodes:
                n.setdefault("last_modified", last_mod)
            return nodes

    try:
        source_text = source_bytes.decode("utf-8", errors="ignore")
    except Exception:
        return []

    nodes = _extract_with_regex(source_text, rel_path, ext)
    last_mod = _get_last_modified(abs_path)
    for n in nodes:
        n.setdefault("last_modified", last_mod)
    return nodes
