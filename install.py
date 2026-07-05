"""
MORAGENT Installer
==================
Installs MORAGENT into any Claude Code project. / Instala MORAGENT en cualquier proyecto de Claude Code.

Usage / Uso:
    python install.py                  # Install in current directory / Instala en el directorio actual
    python install.py /path/to/project # Install in a specific directory / Instala en un directorio especifico

Requirements / Requisitos:
    - Python 3.10+
    - pip install "mcp[cli]"
    - Claude Code installed

What it does / Que hace:
    1. Checks Python and mcp are installed
    2. Copies server.py into the project
    3. Creates .mcp.json so Claude Code detects MORAGENT
    4. Installs the /moragent skill (.claude/skills/moragent/SKILL.md)
    5. Done — open Claude Code and type /moragent
"""
import sys
import json
import shutil
import subprocess
from pathlib import Path

if sys.version_info < (3, 10):
    print(f"[ERROR] MORAGENT requires Python 3.10+ (you have {sys.version_info.major}.{sys.version_info.minor}).")
    print("        https://python.org/downloads")
    sys.exit(1)

SCRIPT_DIR = Path(__file__).parent.resolve()
SKILL_SRC = SCRIPT_DIR / "skills" / "moragent" / "SKILL.md"

BANNER = r"""
█▀▄▀█ █▀█ █▀█ ▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀
█░▀░█ █▄█ █▀▄ █▀█ █▄█ ██▄ █░▀█ ░█░
─────────────────────────────────────
 AI AGENT STUDIO v3.0.0 — Installer
─────────────────────────────────────
"""


def find_python():
    """Find the Python executable (cross-platform)."""
    import platform
    # On Windows try python first, on Unix try python3 first
    candidates = [sys.executable]
    if platform.system() == "Windows":
        candidates += ["python", "python3"]
    else:
        candidates += ["python3", "python"]
    for cmd in candidates:
        try:
            result = subprocess.run([cmd, "--version"], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                return cmd
        except Exception:
            pass
    return None


def check_mcp():
    """Check if mcp package is installed."""
    try:
        import mcp  # noqa: F401
        return True
    except ImportError:
        return False


def install(target_dir: str = "."):
    target = Path(target_dir).resolve()

    print(BANNER)
    print(f"Target: {target}\n")

    # 1. Check Python
    python_cmd = find_python()
    if not python_cmd:
        print("[ERROR] Python not found. Install Python 3.10+")
        print("        https://python.org/downloads")
        return False
    print(f"[OK] Python: {python_cmd}")

    # 2. Check/install mcp (best effort — run_server.py bootstraps a local
    # venv on first launch if this fails, e.g. on PEP 668 managed Pythons)
    if not check_mcp():
        print("[...] Installing dependency: mcp[cli]")
        result = subprocess.run([python_cmd, "-m", "pip", "install", "mcp[cli]"])
        if result.returncode == 0:
            print("[OK] mcp installed")
        else:
            print("[--] Global install failed (managed Python?). No problem:")
            print("     run_server.py will create a local .venv on first launch.")
    else:
        print("[OK] mcp already installed")

    # 3. Copy server.py
    moragent_dir = target / "moragent-plugin"
    moragent_dir.mkdir(exist_ok=True)

    server_src = SCRIPT_DIR / "server.py"
    launcher_src = SCRIPT_DIR / "run_server.py"
    if not server_src.exists() or not launcher_src.exists():
        print(f"[ERROR] server.py / run_server.py not found next to install.py ({SCRIPT_DIR})")
        return False
    server_dst = moragent_dir / "server.py"
    launcher_dst = moragent_dir / "run_server.py"
    shutil.copy2(server_src, server_dst)
    shutil.copy2(launcher_src, launcher_dst)
    print(f"[OK] server.py -> {server_dst}")
    print(f"[OK] run_server.py -> {launcher_dst}")

    # Keep the bootstrap venv out of the user's git history
    (moragent_dir / ".gitignore").write_text(".venv/\n__pycache__/\n", encoding="utf-8")

    # 4. Create .mcp.json
    # ${PYTHON_CMD:-python3} defaults to python3 (macOS/Linux) and respects
    # PYTHON_CMD (e.g. "python" on Windows) — same convention as the repo's .mcp.json.
    # run_server.py bootstraps a local venv with mcp[cli] if needed.
    # Relative path: the MCP server's cwd is the project root, and this keeps
    # .mcp.json portable (movable folders, committable, works for teammates).
    mcp_config = {
        "mcpServers": {
            "moragent": {
                "command": "${PYTHON_CMD:-python3}",
                "args": ["moragent-plugin/run_server.py"],
                "env": {"PYTHONUTF8": "1"}
            }
        }
    }

    mcp_path = target / ".mcp.json"
    # Merge with existing .mcp.json if it exists
    if mcp_path.exists():
        try:
            existing = json.loads(mcp_path.read_text(encoding="utf-8"))
            existing.setdefault("mcpServers", {})["moragent"] = mcp_config["mcpServers"]["moragent"]
            mcp_config = existing
            print("[OK] .mcp.json updated (merged with existing)")
        except (json.JSONDecodeError, OSError):
            print("[OK] .mcp.json created (replaced invalid file)")
    else:
        print("[OK] .mcp.json created")

    mcp_path.write_text(json.dumps(mcp_config, indent=2, ensure_ascii=False), encoding="utf-8")

    # 5. Install the /moragent skill (modern SKILL.md format)
    if not SKILL_SRC.exists():
        print(f"[ERROR] Skill source not found: {SKILL_SRC}")
        print("        Run install.py from a full MORAGENT checkout (git clone).")
        return False
    skill_dir = target / ".claude" / "skills" / "moragent"
    skill_dir.mkdir(parents=True, exist_ok=True)
    skill_path = skill_dir / "SKILL.md"
    shutil.copy2(SKILL_SRC, skill_path)
    print(f"[OK] /moragent skill -> {skill_path}")

    # Migrate from MORAGENT <= 2.x: remove the legacy command file so /moragent
    # doesn't register twice (the skill above replaces it).
    legacy_command = target / ".claude" / "commands" / "moragent.md"
    if legacy_command.exists():
        legacy_command.unlink()
        print(f"[OK] legacy command removed (migrated to skill): {legacy_command}")
    legacy_flat_skill = target / ".claude" / "skills" / "moragent.md"
    if legacy_flat_skill.exists():
        legacy_flat_skill.unlink()
        print(f"[OK] legacy flat skill removed: {legacy_flat_skill}")

    # 6. Done
    print(f"""
─────────────────────────────────────
 Installation complete!
─────────────────────────────────────

Next steps:
  1. Open Claude Code in: {target}
  2. Claude will ask to enable MORAGENT -> say "yes"
  3. Type: /moragent

MORAGENT guides you from there. Bilingual: /moragent english | /moragent espanol
""")
    return True


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "."
    success = install(target)
    sys.exit(0 if success else 1)
