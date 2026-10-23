"""A /loop payload uses the same slash completion contract as a direct invocation."""

import pytest
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.completion import CompleteEvent
from prompt_toolkit.document import Document

from hermes_cli.commands_completion import SlashCommandAutoSuggest, SlashCommandCompleter


@pytest.fixture
def completer():
    return SlashCommandCompleter(
        skill_commands_provider=lambda: {
            "/review-build": {"description": "Review the current build"},
            "/check-build": {"description": "Check the current build"},
        },
        skill_bundles_provider=lambda: {
            "/build-bundle": {"description": "Build skills", "skills": ["review-build"]},
        },
        plugin_commands_provider=lambda: {"build-plugin": "Inspect the build"},
    )


def _complete(completer, text):
    return list(completer.get_completions(Document(text), CompleteEvent(completion_requested=True)))


@pytest.mark.parametrize("prefix", [
    "/loop ", "/loop 5m ", "/loop every 1h30m ", "/LOOP 5M ", "/loop\t5m\t", "/proactive 5m ",
])
@pytest.mark.parametrize("payload", ["/review", "/status", "/build-b", "/build-p", "/review-build /check"])
def test_loop_payload_completes_like_a_direct_command(completer, prefix, payload):
    direct = _complete(completer, payload)
    assert direct
    nested = _complete(completer, prefix + payload)
    assert [(c.text, c.start_position, c.display_text, c.display_meta_text) for c in nested] == [
        (c.text, c.start_position, c.display_text, c.display_meta_text) for c in direct
    ]
    buffer = Buffer(document=Document(prefix + payload))
    buffer.apply_completion(nested[0])
    assert buffer.text.startswith(prefix)
    assert buffer.text != prefix + payload


@pytest.mark.parametrize("text", [
    "/loop 5m check /review", "/loop 5m /review-build check /check",
    "loop 5m /review", "/loop status /review", "/loop every ", "/loop 5m, /review",
    "/loop 5m /review-build --until /check", "/loop 5m /review-build --times /check",
])
def test_loop_prose_controls_and_flags_do_not_offer_skills(completer, text):
    assert not _complete(completer, text)


def test_loop_completion_uses_the_cursor_not_the_remaining_text(completer):
    text = "/loop 5m /review-b after-cursor"
    document = Document(text, cursor_position=len("/loop 5m /review-b"))
    completions = list(completer.get_completions(document, CompleteEvent()))
    assert len(completions) == 1
    buffer = Buffer(document=document)
    buffer.apply_completion(completions[0])
    assert buffer.text == "/loop 5m /review-build after-cursor"


def test_loop_completion_honors_outer_and_inner_command_filters():
    for hidden in ("/loop", "/status"):
        completer = SlashCommandCompleter(
            command_filter=lambda cmd: cmd in {"/loop", "/status"} and cmd != hidden,
            plugin_commands_provider=dict,
        )
        assert not _complete(completer, "/loop 5m /stat")


@pytest.mark.parametrize("prefix", ["/loop ", "/loop 5m ", "/loop every 5m "])
def test_loop_payload_keeps_stacked_skill_ghost_text(completer, prefix):
    suggest = SlashCommandAutoSuggest(completer=completer)
    result = suggest.get_suggestion(Buffer(), Document(prefix + "/review-build /check"))
    assert result is not None
    assert result.text == "-build"
