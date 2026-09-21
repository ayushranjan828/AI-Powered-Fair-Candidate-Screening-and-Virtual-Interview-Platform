"""Dev entry point:  python run.py   ->  http://127.0.0.1:8000

Builds the React UI (frontend/, Vite) if it is missing or out of date, then
serves it from the FastAPI app - so a single `python run.py` is all you need.

Importing `backend` installs the DNS fallback in backend/dnsfix.py, so this works
even on machines whose security agent blocks getaddrinfo for file-launched Python.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "frontend"
DIST_INDEX = FRONTEND_DIR / "dist" / "index.html"

# Everything whose change should trigger a rebuild.
WATCHED_FILES = ("package.json", "package-lock.json", "vite.config.js", "index.html")
WATCHED_DIRS = ("src",)

# Skip node_modules and dist when scanning for changes - walking them is slow
# and nothing in them is a source file.
SKIP_DIRS = {"node_modules", "dist", ".vite"}


def _newest_source_mtime() -> float:
    """Most recent modification time across the frontend sources."""
    newest = 0.0

    for name in WATCHED_FILES:
        path = FRONTEND_DIR / name
        if path.is_file():
            newest = max(newest, path.stat().st_mtime)

    for name in WATCHED_DIRS:
        root = FRONTEND_DIR / name
        if not root.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for filename in filenames:
                try:
                    newest = max(newest, (Path(dirpath) / filename).stat().st_mtime)
                except OSError:
                    continue  # file vanished mid-scan; it is not the newest anyway

    return newest


def _run(npm: str, args: list[str], what: str) -> None:
    print(f"[frontend] {what}...", flush=True)
    result = subprocess.run([npm, *args], cwd=FRONTEND_DIR)
    if result.returncode != 0:
        raise SystemExit(
            f"[frontend] `npm {' '.join(args)}` failed with exit code {result.returncode}.\n"
            f"           Fix the error above, or build by hand:\n"
            f"           cd \"{FRONTEND_DIR}\" && npm install && npm run build"
        )


def build_frontend() -> None:
    """Install dependencies and build, but only when something actually changed."""
    if not (FRONTEND_DIR / "package.json").is_file():
        return  # no React project here; nothing to do

    have_build = DIST_INDEX.is_file()
    if have_build and DIST_INDEX.stat().st_mtime >= _newest_source_mtime():
        return  # build is newer than every source file

    npm = shutil.which("npm")
    if npm is None:
        message = (
            "[frontend] npm was not found on PATH. The UI is a React app and has "
            "to be built with Node.js (https://nodejs.org)."
        )
        if have_build:
            # An existing build is better than refusing to start; it is just stale.
            print(f"{message}\n[frontend] Serving the existing build - it may be out of date.",
                  file=sys.stderr, flush=True)
            return
        raise SystemExit(message)

    if not (FRONTEND_DIR / "node_modules").is_dir():
        _run(npm, ["install", "--no-audit", "--no-fund"], "installing dependencies (first run only)")

    _run(npm, ["run", "build"], "building the React UI")
    print("[frontend] Build complete.", flush=True)


if __name__ == "__main__":
    # Build before the app is imported so the static mount sees the fresh dist/.
    build_frontend()

    import backend  # noqa: F401,E402  - installs the DNS fallback before uvicorn starts
    import uvicorn  # noqa: E402

    uvicorn.run(
        "backend.main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
        reload=os.getenv("RELOAD", "0") == "1",
    )
