"""
MORAGENT launcher — guarantees the MCP server starts even on a fresh clone.

Uses only the Python standard library. Strategy:
  1. If the current interpreter already has `mcp`, run server.py directly.
  2. Otherwise, use the repo-local .venv (creating it and installing mcp[cli]
     on first run). This sidesteps PEP 668 "externally-managed-environment"
     errors on Homebrew/Debian Pythons — no global pip install needed.

The bootstrap is self-healing: interrupted first runs (half-created venv) and
concurrent first launches are detected and repaired on the next attempt.

Claude Code invokes this via .mcp.json. Humans can also run it by hand:
    python3 run_server.py
"""
import os
import subprocess
import sys
import time
from pathlib import Path

if sys.version_info < (3, 10):
    print(f"MORAGENT requires Python 3.10+ (you have {sys.version_info.major}.{sys.version_info.minor}).\n"
          "  Install a newer Python from https://python.org/downloads and, if needed,\n"
          "  point MORAGENT to it with the PYTHON_CMD environment variable.",
          file=sys.stderr, flush=True)
    sys.exit(1)

HERE = Path(__file__).parent.resolve()
SERVER = HERE / "server.py"
VENV_DIR = HERE / ".venv"


def venv_python(venv_dir: Path) -> Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def _mcp_works(python_path: Path) -> bool:
    check = subprocess.run([str(python_path), "-c", "import mcp"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return check.returncode == 0


def ensure_venv() -> Path:
    """Create (or heal) the repo-local venv with mcp installed. Returns its python path."""
    vpy = venv_python(VENV_DIR)

    if not VENV_DIR.exists():
        print("MORAGENT: first run — creating local environment (30-60s, one time only)...",
              file=sys.stderr, flush=True)
        import venv
        try:
            venv.EnvBuilder(with_pip=True).create(VENV_DIR)
        except FileExistsError:
            # Another MORAGENT process is creating the venv right now — wait for it.
            pass
        except Exception as exc:
            print(f"MORAGENT: could not create a virtual environment ({exc}).\n"
                  "  On Debian/Ubuntu, install the venv module first:\n"
                  "    sudo apt install python3-venv\n"
                  "  Or preinstall the dependency yourself:\n"
                  "    python3 -m pip install \"mcp[cli]\"",
                  file=sys.stderr, flush=True)
            sys.exit(1)

    # Wait briefly for the interpreter to appear (concurrent first launches).
    for _ in range(60):
        if vpy.exists():
            break
        time.sleep(1)
    if not vpy.exists():
        print(f"MORAGENT: virtual environment at {VENV_DIR} has no interpreter.\n"
              f"  Delete the folder and try again:  rm -rf \"{VENV_DIR}\"",
              file=sys.stderr, flush=True)
        sys.exit(1)

    # Verify mcp is actually importable — heals environments left half-installed
    # by an interrupted first run (e.g. an MCP startup timeout mid pip-install).
    if not _mcp_works(vpy):
        print("MORAGENT: installing mcp[cli] into local environment...",
              file=sys.stderr, flush=True)
        result = subprocess.run(
            [str(vpy), "-m", "pip", "install", "--quiet", "mcp[cli]>=1.0.0"],
            stdout=sys.stderr, stderr=sys.stderr,
        )
        if result.returncode != 0 or not _mcp_works(vpy):
            # A concurrent process may have been mid-install; give it one chance.
            time.sleep(10)
            if not _mcp_works(vpy):
                print("MORAGENT: could not install mcp[cli] automatically.\n"
                      f"  Fix manually:  {vpy} -m pip install \"mcp[cli]\"",
                      file=sys.stderr, flush=True)
                sys.exit(1)
        print("MORAGENT: environment ready.", file=sys.stderr, flush=True)
    return vpy


def main() -> None:
    if not SERVER.exists():
        print(f"MORAGENT: server.py not found at {SERVER}", file=sys.stderr)
        sys.exit(1)

    # 1. Current interpreter already works? Run in-process (fastest path).
    try:
        import mcp  # noqa: F401
    except ImportError:
        pass
    else:
        import runpy
        sys.argv = [str(SERVER)]
        runpy.run_path(str(SERVER), run_name="__main__")
        return

    # 2. Fall back to the repo-local venv (stdin/stdout inherited for stdio MCP).
    vpy = ensure_venv()
    if os.name == "nt":
        sys.exit(subprocess.call([str(vpy), str(SERVER)]))
    else:
        os.execv(str(vpy), [str(vpy), str(SERVER)])


if __name__ == "__main__":
    main()
