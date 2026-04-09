"""
MORAGENT Installer
==================
Instala MORAGENT en cualquier proyecto de Claude Code.

Uso:
    python install.py                  # Instala en el directorio actual
    python install.py /ruta/proyecto   # Instala en un directorio especifico

Requisitos:
    - Python 3.10+
    - pip install mcp[cli]  (o: pip install "mcp[cli]")
    - Claude Code instalado

Que hace:
    1. Verifica que Python y mcp esten instalados
    2. Copia server.py al proyecto
    3. Crea .mcp.json para que Claude Code detecte MORAGENT
    4. Crea .claude/commands/moragent.md (skill /moragent)
    5. Listo — abre Claude Code y escribe /moragent
"""
import os
import sys
import json
import shutil
import subprocess
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()

# ── Skill content (embedded to avoid extra file dependencies) ──
SKILL_CONTENT = '''---
name: moragent
description: MORAGENT AI Agent Studio - punto de entrada principal. Menu guiado para aprender, crear, operar y gestionar proyectos de IA agentica.
user_invocable: true
---

# MORAGENT AI Agent Studio

Punto de entrada principal del framework. Guia al usuario paso a paso.

## Argumentos
- `$ARGUMENTS`: Accion a ejecutar (opcional). Si no se pasa, mostrar menu principal.

## Menu Principal

Si `$ARGUMENTS` esta vacio o dice "menu", presentar este menu:

```
MORAGENT AI Agent Studio
========================

  1. Nuevo proyecto     — Describe tu idea y te armo todo
  2. Crear agente       — Agente especializado con rol y memoria
  3. Crear skill        — Procedimiento reutilizable (/nombre)
  4. Mi infraestructura — Dashboard de agentes, skills, memorias
  5. Aprender           — Conceptos de IA agentica con analogias
  6. Verificar calidad  — Checklist antes de entregar
  7. Buscar referencias — Trabajo previo como punto de partida
  8. Onboarding         — Como funciona todo (carpetas, archivos, flujo)
  9. Enriquecer         — Mejorar un agente o skill existente

Escribe el numero o describe que quieres hacer.
```

## Flujo por opcion

### 1. Nuevo proyecto
1. Preguntar: "Describe tu proyecto en una frase"
2. Llamar `moragent_advisor` con la idea
3. Recomendar arquitectura: que agentes REUSAR, cuales crear
4. Preguntar: "Quieres que lo cree?"
5. Si acepta: llamar `moragent_scaffold_project`

### 2. Crear agente
1. Preguntar: nombre, rol, modelo (sonnet=rapido, opus=inteligente, haiku=barato)
2. Llamar `moragent_create_agent`

### 3. Crear skill
1. Preguntar: nombre, pasos, output
2. Llamar `moragent_create_skill`

### 4. Mi infraestructura
1. Llamar `moragent_status`

### 5. Aprender
Submenu: architecture, orchestration, skills, context, automation, plugins, example, glosario.
Llamar `moragent_learn` o `moragent_glossary`.

### 6. Verificar calidad
1. Preguntar tipo: proposal, report, dashboard, analysis, code
2. Llamar `moragent_quality_check`

### 7. Buscar referencias
1. Llamar `moragent_find_references`

### 8. Onboarding
1. Llamar `moragent_onboard`

### 9. Enriquecer
1. Preguntar: nombre del agente o skill, y tipo (agente/skill)
2. Llamar `moragent_enrich`
3. Aplicar las mejoras sugeridas

## Atajos directos
| Input | Accion |
|-------|--------|
| "nuevo proyecto [idea]" | Flujo 1 |
| "crear agente [nombre]" | Flujo 2 |
| "status" o "infra" | Flujo 4 |
| "aprender [tema]" | Flujo 5 |
| "onboarding" | Flujo 8 |
| "enriquecer [nombre]" | Flujo 9 |
| numero (1-9) | Flujo correspondiente |
'''


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
        import mcp
        return True
    except ImportError:
        return False


def install(target_dir: str = "."):
    target = Path(target_dir).resolve()

    print(f"""
╔══════════════════════════════════════════╗
║   MORAGENT AI Agent Studio — Installer   ║
╚══════════════════════════════════════════╝

Target: {target}
""")

    # 1. Check Python
    python_cmd = find_python()
    if not python_cmd:
        print("[ERROR] Python no encontrado. Instala Python 3.10+")
        print("        https://python.org/downloads")
        return False
    print(f"[OK] Python: {python_cmd}")

    # 2. Check/install mcp
    if not check_mcp():
        print("[...] Instalando dependencia: mcp[cli]")
        subprocess.run([python_cmd, "-m", "pip", "install", "mcp[cli]"], check=True)
        print("[OK] mcp instalado")
    else:
        print("[OK] mcp ya instalado")

    # 3. Copy server.py
    moragent_dir = target / "moragent-plugin"
    moragent_dir.mkdir(exist_ok=True)

    server_src = SCRIPT_DIR / "server.py"
    server_dst = moragent_dir / "server.py"
    shutil.copy2(server_src, server_dst)
    print(f"[OK] server.py → {server_dst}")

    # 4. Create .mcp.json
    # Use "python" as command for portability across OS.
    # On Windows, "python" resolves via PATH. On Mac/Linux, "python3" may be needed.
    import platform
    portable_python = "python" if platform.system() == "Windows" else "python3"
    mcp_config = {
        "mcpServers": {
            "moragent": {
                "command": portable_python,
                "args": [str(server_dst)],
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
            print(f"[OK] .mcp.json actualizado (merge con existente)")
        except:
            print(f"[OK] .mcp.json creado (reemplazo)")
    else:
        print(f"[OK] .mcp.json creado")

    mcp_path.write_text(json.dumps(mcp_config, indent=2, ensure_ascii=False), encoding="utf-8")

    # 5. Create skill /moragent
    commands_dir = target / ".claude" / "commands"
    commands_dir.mkdir(parents=True, exist_ok=True)
    skill_path = commands_dir / "moragent.md"
    skill_path.write_text(SKILL_CONTENT, encoding="utf-8")
    print(f"[OK] /moragent skill → {skill_path}")

    # 6. Done
    print(f"""
╔══════════════════════════════════════════╗
║          Instalacion completa!           ║
╚══════════════════════════════════════════╝

Que hacer ahora:
  1. Abre Claude Code en: {target}
  2. Claude te preguntara si quieres activar MORAGENT → di "si"
  3. Escribe: /moragent

Eso es todo. MORAGENT te guia desde ahi.
""")
    return True


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "."
    success = install(target)
    sys.exit(0 if success else 1)
