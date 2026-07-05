"""Tests for MORAGENT MCP Server v3."""
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
        assert server.__version__ == "3.0.0"

    def test_version_is_string(self):
        assert isinstance(server.__version__, str)


class TestConstants:
    def test_excluded_dirs_is_set(self):
        assert isinstance(server.EXCLUDED_DIRS, set)
        assert ".claude" in server.EXCLUDED_DIRS
        assert "__pycache__" in server.EXCLUDED_DIRS

    def test_valid_models(self):
        assert server.VALID_MODELS == {"sonnet", "opus", "haiku", "fable", "inherit"}

    def test_valid_orchestrations(self):
        assert server.VALID_ORCHESTRATIONS == {
            "pipeline", "parallel", "orchestrator", "evaluator", "router", "hybrid"
        }

    def test_legacy_orchestrations_map_to_valid(self):
        for legacy, modern in server.LEGACY_ORCHESTRATIONS.items():
            assert modern in server.VALID_ORCHESTRATIONS, legacy

    def test_mcp_keywords_has_common_tools(self):
        assert "Gmail" in server.MCP_KEYWORDS
        assert "Slack" in server.MCP_KEYWORDS
        assert "Asana" in server.MCP_KEYWORDS

    def test_deliverable_extensions(self):
        assert "*.html" in server.DELIVERABLE_EXTENSIONS
        assert "*.pdf" in server.DELIVERABLE_EXTENSIONS


# ── I18N ─────────────────────────────────────────────────────────────────────


class TestLanguage:
    def test_default_language_is_spanish(self):
        assert server._get_lang() == "es"

    def test_set_language_persists(self):
        server._set_lang("en")
        server._lang_cache = None  # force re-read from disk
        assert server._get_lang() == "en"

    def test_t_returns_by_language(self):
        assert server._t("hola", "hello") == "hola"
        server._set_lang("en")
        assert server._t("hola", "hello") == "hello"

    def test_language_tool_reports_current(self):
        result = server.moragent_language()
        assert "es" in result

    def test_language_tool_switches(self):
        result = server.moragent_language("english")
        assert "English" in result
        assert server._get_lang() == "en"

    def test_language_tool_accepts_spanish_aliases(self):
        server._set_lang("en")
        server.moragent_language("espanol")
        assert server._get_lang() == "es"

    def test_language_tool_rejects_unknown(self):
        result = server.moragent_language("klingon")
        assert "Error" in result

    def test_invalid_config_falls_back_to_default(self, tmp_path):
        (tmp_path / "moragent.json").write_text("{not json", encoding="utf-8")
        server._lang_cache = None
        assert server._get_lang() == "es"


class TestBilingualContentParity:
    def test_glossary_same_size(self):
        assert len(server.GLOSSARY["es"]) == len(server.GLOSSARY["en"]) == 25

    def test_glossary_fields_complete(self):
        for lang in ("es", "en"):
            for term, entry in server.GLOSSARY[lang].items():
                assert set(entry.keys()) == {"what", "analogy", "where", "tip"}, (lang, term)

    def test_lessons_same_topics(self):
        assert server.LEARN_CONTENT["es"].keys() == server.LEARN_CONTENT["en"].keys()

    def test_patterns_lesson_exists(self):
        for lang in ("es", "en"):
            assert "patterns" in server.LEARN_CONTENT[lang]
            content = server.LEARN_CONTENT[lang]["patterns"]
            for pattern in ("PIPELINE", "ROUTING", "ORCHESTRATOR", "EVALUATOR"):
                assert pattern in content.upper(), (lang, pattern)

    def test_quality_checks_same_types(self):
        assert server.QUALITY_CHECKS["es"].keys() == server.QUALITY_CHECKS["en"].keys()


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
        assert "unit testing" in fm["description"]


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


# ── Templates ────────────────────────────────────────────────────────────────


class TestTemplates:
    def test_agent_template_has_description_frontmatter(self):
        for lang in ("es", "en"):
            rendered = server.AGENT_TPL[lang].format(
                name="x", description="does X", model="sonnet", color="blue",
                display="X", role="r", expertise="- e", tools="- t", extra="")
            fm = server._parse_frontmatter(rendered)
            assert fm["description"] == "does X", lang
            assert fm["name"] == "x"
            assert "memory" not in fm  # non-standard field removed in v3

    def test_skill_template_has_no_user_invocable(self):
        for lang in ("es", "en"):
            rendered = server.SKILL_TPL[lang].format(
                name="x", display="X", description="d", args="a", steps="1. s", output="o")
            fm = server._parse_frontmatter(rendered)
            assert "user_invocable" not in fm
            assert fm["description"] == "d"


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
                assert agents[0]["has_description_fm"] is True

    def test_fallback_to_stem(self, tmp_path):
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        (agents_dir / "my-agent.md").write_text("# My Agent\nNo frontmatter here", encoding="utf-8")
        with patch.object(server, "_agents_dir", return_value=agents_dir):
            with patch.object(server, "_user_agents", return_value=tmp_path / "nope"):
                agents = server._scan_agents()
                assert agents[0]["name"] == "my-agent"
                assert agents[0]["has_description_fm"] is False


class TestScanSkills:
    def test_empty_dir(self, tmp_path):
        with patch.object(server, "_skills_dir", return_value=tmp_path / "skills"):
            with patch.object(server, "_commands_dir", return_value=tmp_path / "commands"):
                assert server._scan_skills() == []

    def test_finds_modern_skill(self, tmp_path, sample_skill_content):
        skills_dir = tmp_path / "skills"
        (skills_dir / "test-skill").mkdir(parents=True)
        (skills_dir / "test-skill" / "SKILL.md").write_text(sample_skill_content, encoding="utf-8")
        with patch.object(server, "_skills_dir", return_value=skills_dir):
            with patch.object(server, "_commands_dir", return_value=tmp_path / "commands"):
                skills = server._scan_skills()
                assert len(skills) == 1
                assert skills[0]["name"] == "test-skill"
                assert skills[0]["kind"] == "skill"

    def test_finds_legacy_flat_skill(self, tmp_path, sample_skill_content):
        skills_dir = tmp_path / "skills"
        skills_dir.mkdir()
        (skills_dir / "test-skill.md").write_text(sample_skill_content, encoding="utf-8")
        with patch.object(server, "_skills_dir", return_value=skills_dir):
            with patch.object(server, "_commands_dir", return_value=tmp_path / "commands"):
                skills = server._scan_skills()
                assert len(skills) == 1
                assert skills[0]["name"] == "test-skill"

    def test_finds_legacy_command(self, tmp_path, sample_skill_content):
        commands_dir = tmp_path / "commands"
        commands_dir.mkdir()
        (commands_dir / "test-skill.md").write_text(sample_skill_content, encoding="utf-8")
        with patch.object(server, "_skills_dir", return_value=tmp_path / "skills"):
            with patch.object(server, "_commands_dir", return_value=commands_dir):
                skills = server._scan_skills()
                assert len(skills) == 1
                assert skills[0]["kind"] == "command"

    def test_modern_wins_over_duplicates(self, tmp_path, sample_skill_content):
        skills_dir = tmp_path / "skills"
        (skills_dir / "test-skill").mkdir(parents=True)
        (skills_dir / "test-skill" / "SKILL.md").write_text(sample_skill_content, encoding="utf-8")
        (skills_dir / "test-skill.md").write_text(sample_skill_content, encoding="utf-8")
        with patch.object(server, "_skills_dir", return_value=skills_dir):
            with patch.object(server, "_commands_dir", return_value=tmp_path / "commands"):
                skills = server._scan_skills()
                assert len(skills) == 1


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
    def test_known_term_spanish(self):
        result = server.moragent_glossary("Agente")
        assert "Que es" in result

    def test_known_term_english(self):
        server._set_lang("en")
        result = server.moragent_glossary("Agent")
        assert "What it is" in result

    def test_cross_language_lookup(self):
        # Asking for the English key while in Spanish still resolves
        result = server.moragent_glossary("Pipeline")
        assert "no encontrado" not in result.lower()

    def test_unknown_term(self):
        result = server.moragent_glossary("xyznotexist")
        assert "no encontrado" in result.lower()

    def test_empty_returns_all(self):
        result = server.moragent_glossary("")
        for term in server.GLOSSARY["es"]:
            assert term in result

    def test_case_insensitive(self):
        result = server.moragent_glossary("agente")
        assert "no encontrado" not in result.lower()


class TestLearn:
    def test_known_topic(self):
        result = server.moragent_learn("patterns")
        assert "PIPELINE" in result.upper()

    def test_topic_follows_language(self):
        es = server.moragent_learn("architecture")
        server._set_lang("en")
        en = server.moragent_learn("architecture")
        assert es != en
        assert "Imagina una empresa" in es
        assert "Picture a company" in en

    def test_unknown_topic_lists_available(self):
        result = server.moragent_learn("nope")
        assert "architecture" in result


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


class TestScaffoldValidation:
    def test_invalid_orchestration(self):
        result = server.moragent_scaffold_project(
            project_name="test", description="test", orchestration="waterfall"
        )
        assert "Error" in result
        assert "Invalid orchestration" in result

    def test_legacy_orchestration_accepted(self, tmp_path):
        with patch.object(server, "_cwd", return_value=tmp_path):
            with patch.object(server, "_agents_dir", return_value=tmp_path / ".claude" / "agents"):
                with patch.object(server, "_skills_dir", return_value=tmp_path / ".claude" / "skills"):
                    with patch.object(server, "_memory_dir", return_value=tmp_path / ".claude" / "agent-memory"):
                        result = server.moragent_scaffold_project(
                            project_name="test", description="test", orchestration="subagents"
                        )
                        assert "Error" not in result
                        assert "orchestrator" in result

    def test_empty_project_name(self):
        result = server.moragent_scaffold_project(
            project_name="   ", description="test"
        )
        assert "Error" in result


# ── Create (end-to-end on tmp dirs) ─────────────────────────────────────────


class TestCreateAgent:
    def test_creates_agent_with_delegation_ready_frontmatter(self, tmp_path):
        agents_dir = tmp_path / "agents"
        with patch.object(server, "_agents_dir", return_value=agents_dir):
            with patch.object(server, "_memory_dir", return_value=tmp_path / "memory"):
                result = server.moragent_create_agent(
                    name="report-writer", role="Writes weekly HTML reports")
                assert "report-writer" in result
                content = (agents_dir / "report-writer.md").read_text(encoding="utf-8")
                fm = server._parse_frontmatter(content)
                assert fm["description"] == "Writes weekly HTML reports"
                assert fm["model"] == "sonnet"
                assert (tmp_path / "memory" / "report-writer" / "MEMORY.md").exists()


class TestCreateSkill:
    def test_creates_modern_skill_layout(self, tmp_path):
        skills_dir = tmp_path / "skills"
        with patch.object(server, "_skills_dir", return_value=skills_dir):
            result = server.moragent_create_skill(
                name="weekly-report", description="Generates the weekly report",
                steps=["Load data", "Build charts", "Render HTML"])
            assert "/weekly-report" in result
            skill_file = skills_dir / "weekly-report" / "SKILL.md"
            assert skill_file.exists()
            fm = server._parse_frontmatter(skill_file.read_text(encoding="utf-8"))
            assert fm["name"] == "weekly-report"


# ── Enrich ───────────────────────────────────────────────────────────────────


class TestEnrich:
    def test_flags_missing_description(self, tmp_path):
        agents_dir = tmp_path / "agents"
        agents_dir.mkdir()
        (agents_dir / "thin.md").write_text(
            "---\nname: thin\nmodel: sonnet\n---\n\n# Thin\n\nshort\n", encoding="utf-8")
        with patch.object(server, "_agents_dir", return_value=agents_dir):
            result = server.moragent_enrich("thin", "agent")
            assert "description" in result

    def test_agent_not_found(self, tmp_path):
        with patch.object(server, "_agents_dir", return_value=tmp_path / "agents"):
            with patch.object(server, "_user_agents", return_value=tmp_path / "user-agents"):
                result = server.moragent_enrich("ghost", "agent")
                assert "no encontrado" in result.lower() or "not found" in result.lower()

    def test_finds_modern_skill(self, tmp_path, sample_skill_content):
        skills_dir = tmp_path / "skills"
        (skills_dir / "test-skill").mkdir(parents=True)
        (skills_dir / "test-skill" / "SKILL.md").write_text(sample_skill_content, encoding="utf-8")
        with patch.object(server, "_skills_dir", return_value=skills_dir):
            with patch.object(server, "_commands_dir", return_value=tmp_path / "commands"):
                result = server.moragent_enrich("test-skill", "skill")
                assert "test-skill" in result
