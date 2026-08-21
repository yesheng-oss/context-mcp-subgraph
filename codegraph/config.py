"""
config.py — codegraph file type taxonomy and settings.
"""

from pathlib import Path

# ── Skip entirely — pure noise, never extract ─────────────────────────────────
SKIP_FILENAMES = {
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "poetry.lock", "Cargo.lock", "Pipfile.lock",
    "composer.lock", "Gemfile.lock", "uv.lock",
}

SKIP_EXTENSIONS = {
    ".min.js", ".min.css",
    ".map",
    ".lock",
    ".pyc", ".pyo", ".pyd",
    ".class", ".jar",
    ".o", ".a", ".so", ".dylib",
    ".wasm",
    ".exe", ".dll",
    ".zip", ".tar", ".gz", ".bz2",
    ".db", ".sqlite", ".sqlite3",
}

SKIP_DIRS = {
    "node_modules", ".git", ".hg", "__pycache__",
    "dist", "build", ".next", ".nuxt", ".svelte-kit",
    ".venv", "venv", "env", ".env",
    "vendor", "target",
    ".mypy_cache", ".ruff_cache", ".pytest_cache",
    "coverage", ".nyc_output",
    "codegraph-cache",
}

# ── Code — tree-sitter AST extraction ────────────────────────────────────────
CODE_EXTENSIONS = {
    ".py", ".pyw",
    ".js", ".mjs", ".cjs", ".jsx",
    ".ts", ".mts", ".cts", ".tsx",
    ".go",
    ".rs",
    ".java", ".kt", ".scala", ".groovy",
    ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx",
    ".cs",
    ".rb", ".rake",
    ".php",
    ".swift",
    ".lua", ".luau",
    ".zig",
    ".ex", ".exs",
    ".dart",
    ".vue", ".svelte", ".astro",
    ".sh", ".bash", ".zsh", ".fish",
    ".ps1", ".psm1",
    ".r", ".R",
    ".jl",
    ".f", ".f90", ".f95", ".f03", ".f08",
}

# ── SQL — tree-sitter-sql extraction ─────────────────────────────────────────
SQL_EXTENSIONS = {".sql"}

# ── Build/config — single file node + key field extraction ───────────────────
BUILD_EXTENSIONS = {
    ".toml",
    ".gradle",
}
BUILD_FILENAMES = {
    "package.json", "package.yaml",
    "Makefile", "makefile", "GNUmakefile",
    "CMakeLists.txt",
    "Dockerfile",
    "docker-compose.yml", "docker-compose.yaml",
    "docker-compose.override.yml",
    "requirements.txt", "requirements-dev.txt",
    "Pipfile",
    "go.mod",
    "pom.xml",
    "build.xml",
    ".env.example", ".env.template",
}

# ── Config — label-only node ──────────────────────────────────────────────────
CONFIG_EXTENSIONS = {
    ".yml", ".yaml",
    ".json",
    ".ini", ".cfg", ".conf",
    ".env",
    ".properties",
    ".xml",
    ".plist",
}

# ── Docs — LLM semantic extraction ───────────────────────────────────────────
DOC_EXTENSIONS = {
    ".md", ".mdx", ".markdown",
    ".txt", ".rst", ".adoc",
    ".tex", ".latex",
    ".ipynb",
    ".org",
}

# ── PDF — LLM semantic extraction ────────────────────────────────────────────
PDF_EXTENSIONS = {".pdf"}

# ── Media — label-only node ───────────────────────────────────────────────────
IMAGE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp",
    ".svg", ".ico", ".bmp", ".tiff", ".avif",
}
AUDIO_EXTENSIONS = {".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"}

# ── Size limits ───────────────────────────────────────────────────────────────
MAX_FILE_BYTES = 500_000
DOC_MAX_CHARS  = 8_000

# Keep for backward compat — scanner imports this
DEFAULT_IGNORE = SKIP_DIRS


def classify_file(path: str) -> str:
    p    = Path(path)
    name = p.name
    ext  = p.suffix.lower()
    stem = p.stem.lower()

    if name in SKIP_FILENAMES:       return "skip"
    if ext  in SKIP_EXTENSIONS:      return "skip"
    if stem.endswith(".min"):         return "skip"

    if name in BUILD_FILENAMES:      return "build"
    if ext   in BUILD_EXTENSIONS:    return "build"

    if ext in CODE_EXTENSIONS:       return "code"
    if ext in SQL_EXTENSIONS:        return "sql"

    if ext in CONFIG_EXTENSIONS:     return "config"

    if ext in DOC_EXTENSIONS:        return "doc"
    if ext in PDF_EXTENSIONS:        return "pdf"
    if ext in IMAGE_EXTENSIONS:      return "image"
    if ext in AUDIO_EXTENSIONS:      return "audio"
    if ext in VIDEO_EXTENSIONS:      return "video"

    return "unknown"
