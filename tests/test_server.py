"""Tests for MORAGENT MCP Server."""
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# Add parent dir so we can import server
sys.path.insert(0, str(Path(__file__).parent.parent))
import server


# ── Constants ────────────────────────────────────────────────────────────────


class TestVersion:
    def test_version_exists(self):
        assert hasattr(server, "__version__")
        assert server.__version__ == "2.0.0"

    def test_version_is_string(self):
        assert isinstance(server.__version__, str)


class TestConstants:
    def test_excluded_dirs_is_set(self):
        assert isinstance(server.EXCLUDED_DIRS, set)
        assert ".claude" in server.EXCLUDED_DIRS
        assert "__pycache__" in server.EXCLUDED_DIRS

    def test_valid_models(self):
        assert "sonnet" in server.VALID_MODELS
        assert "opus" in server.VALID_MODELS
        assert "haiku" in server.VALID_MODELS
        assert len(server.VALID_MODELS) == 3

    def test_valid_orchestrations(self):
        assert "subagents" in server.VALID_ORCHESTRATIONS
        assert "team" in server.VALID_ORCHESTRATIONS
        assert "hybrid" in server.VALID_ORCHESTRATIONS

    def test_mcp_keywords_has_common_tools(self):
        assert "Gmail" in server.MCP_KEYWORDS
        assert "Slack" in server.MCP_KEYWORDS
        assert "Asana" in server.MCP_KEYWORDS

    def test_deliverable_extensions(self):
        assert "*.html" in server.DELIVERABLE_EXTENSIONS
        assert "*.pdf" in server.DELIVERABLE_EXTENSIONS


# ── Helpers ──────────────────────────────────────────────────────────────────


class TestReadSafe:
    def test_existing_file(self, tmp_path):
        f = tmp_path / "test.md"
        f.write_text("hello world", encoding="utf-8")
        assert server._read_safe(f) == "hello world"

    def test_nonexistent_file(self, tmp_path):
        f = tmp_path / "nope.md"
        assert server._read_safe(f) == ""

    def test_encoding_errors_replaced(self, tmp_path):
        f = tmp_path / "bad.md"
        f.write_bytes(b"hello \xff world")
        result = server._read_safe(f)
        assert "hello" in result
        assert "world" in result


class TestParseFrontmatter:
    def test_basic_frontmatter(self):
        content = "---\nname: test-agent\nmodel: sonnet\n---\n# Title"
        fm = server._parse_frontmatter(content)
        assert fm["name"] == "test-agent"
        assert fm["model"] == "sonnet"

    def test_no_frontmatter(self):
        content = "# Just a title\nSome text"
        fm = server._parse_frontmatter(content)
        assert fm == {}

    def test_quoted_values(self):
        content = '---\ndescription: "A test skill"\n---'
        fm = server._parse_frontmatter(content)
        assert fm["description"] == "A test skill"

    def test_single_quoted_values(self):
        content = "---\ndescription: 'A test skill'\n---"
        fm = server._parse_frontmatter(content)
        assert fm["description"] == "A test skill"

    def test_empty_value(self):
        content = "---\nname:\n---"
        fm = server._parse_frontmatter(content)
        assert fm["name"] == ""

    def test_colon_in_value(self):
        content = "---\ndescription: A skill: does things\n---"
        fm = server._parse_frontmatter(content)
        assert fm["description"] == "A skill: does things"

    def test_from_fixture(self, sample_agent_content):
        fm = server._parse_frontmatter(sample_agent_content)
        assert fm["name"] == "test-agent"
        assert fm["model"] == "opus"


class TestNextColor:
    def test_returns_string(self):
        server._color_index = 0
        assert isinstance(server._next_color(), str)

    def test_cycles_through_colors(self):
        server._color_index = 0
        colors = [server._next_color() for _ in range(len(server.COLORS))]
        assert colors == server.COLORS

    def test_wraps_around(self):
        server._color_index = 0
        for _ in range(len(server.COLORS)):
            server._next_color()
        assert server._next_color() == server.COLORS[0]


# ── Scanners ─────────────────────────────────────────────────────────────────


class TestScanAgents:
    def test_empty_dir(self, tmp_path):
        with patch.object(server, "_agents_dir", return_value=tmp_path / "agents"):
            with patch.object(server, "_user_agents", return_value=tmp_path / "user-agents"):
                agents = server._scan_agents()
                assert agents == []

    def test_finds_agent(self, tmp_path, sample_agent_content):
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        (agents_dir / "test-agent.md").write_text(sample_agent_content, encoding="utf-8")
        with patch.object(server, "_agents_dir", return_value=agents_dir):
            with patch.object(server, "_user_agents", return_value=tmp_path / "nope"):
                agents = server._scan_agents()
                assert len(agents) == 1
                assert agents[0]["name"] == "test-agent"
                assert agents[0]["model"] == "opus"
                assert agents[0]["scope"] == "project"

    def test_fallback_to_stem(self, tmp_path):
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        (agents_dir / "my-agent.md").write_text("# My Agent\nNo frontmatter here", encoding="utf-8")
        with patch.object(server, "_agents_dir", return_value=agents_dir):
            with patch.object(server, "_user_agents", return_value=tmp_path / "nope"):
                agents = server._scan_agents()
                assert agents[0]["name"] == "my-agent"


class TestScanSkills:
    def test_empty_dir(self, tmp_path):
        with patch.object(server, "_skills_dir", return_value=tmp_path / "skills"):
            skills = server._scan_skills()
            assert skills == []

    def test_finds_skill(self, tmp_path, sample_skill_content):
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        (skills_dir / "test-skill.md").write_text(sample_skill_content, encoding="utf-8")
        with patch.object(server, "_skills_dir", return_value=skills_dir):
            skills = server._scan_skills()
            assert len(skills) == 1
            assert skills[0]["name"] == "test-skill"
            assert "test skill" in skills[0]["description"].lower()


class TestScanMemories:
    def test_empty_dir(self, tmp_path):
        with patch.object(server, "_memory_dir", return_value=tmp_path / "memory"):
            memories = server._scan_memories()
            assert memories == []

    def test_finds_memory(self, tmp_path):
        mem_dir = tmp_path / "memory"
        agent_mem = mem_dir / "test-agent"
        agent_mem.mkdir(parents=True)
        (agent_mem / "MEMORY.md").write_text("# Memory\n\nSome content\nAnother line\n", encoding="utf-8")
        with patch.object(server, "_memory_dir", return_value=mem_dir):
            memories = server._scan_memories()
            assert len(memories) == 1
            assert memories[0]["agent"] == "test-agent"
            assert memories[0]["lines"] > 0
            assert memories[0]["has_memory"] is True


# ── Glossary ─────────────────────────────────────────────────────────────────


class TestGlossary:
    def test_known_term(self):
        result = server.moragent_glossary("Agente")
        assert "Que es:" in result or "que" in result.lower()

    def test_unknown_term(self):
        result = server.moragent_glossary("xyznotexist")
        assert "no encontrado" in result.lower() or "not found" in result.lower()

    def test_empty_returns_all(self):
        result = server.moragent_glossary("")
        for term in server.GLOSSARY:
            assert term in result

    def test_case_insensitive(self):
        result = server.moragent_glossary("agente")
        assert "no encontrado" not in result.lower()


# ── Validation ───────────────────────────────────────────────────────────────


class TestCreateAgentValidation:
    def test_invalid_model(self):
        result = server.moragent_create_agent(name="test", role="test", model="gpt4")
        assert "Error" in result
        assert "Invalid model" in result

    def test_invalid_scope(self):
        result = server.moragent_create_agent(name="test", role="test", scope="global")
        assert "Error" in result
        assert "Invalid scope" in result

    def test_empty_name(self):
        result = server.moragent_create_agent(name="", role="test")
        assert "Error" in result
        assert "empty" in result.lower()


class TestScaffoldValidation:
    def test_invalid_orchestration(self):
        result = server.moragent_scaffold_project(
            project_name="test", description="test", orchestration="waterfall"
        )
        assert "Error" in result
        assert "Invalid orchestration" in result

    def test_empty_project_name(self):
        result = server.moragent_scaffold_project(
            project_name="   ", description="test"
        )
        assert "Error" in result
        assert "empty" in result.lower()
