"""Element addressing follows the live driver schema without losing snapshot authority."""

from unittest.mock import Mock

import pytest

from tools.computer_use.cua_backend import CuaDriverBackend
from tools.computer_use.cua_backend_session import _CuaDriverSession


ELEMENT_ACTIONS = ["left", "right", "middle", "double", "scroll", "set_value"]
TOKEN = "s00000001:5"


def _backend(properties, *, token=TOKEN, capabilities=()):
    session = _CuaDriverSession.__new__(_CuaDriverSession)
    tools = ("click", "double_click", "scroll", "set_value")
    session._tool_schemas = {
        tool: {"properties": {prop: {} for prop in properties}} for tool in tools
    }
    session._capabilities = {tool: set(capabilities) for tool in tools}
    session.call_tool = Mock(return_value={
        "isError": True, "data": {},
        "structuredContent": {"code": "stale_element_token", "message": "Capture again."},
    })
    backend = CuaDriverBackend.__new__(CuaDriverBackend)
    backend._session = session
    backend._session_id = "addressing-test"
    backend._set_active_target({"pid": 42, "window_id": 7})
    backend._snapshot_tokens = {5: token} if token else {}
    return backend


def _invoke(backend, action):
    if action == "scroll":
        return backend.scroll(direction="down", element=5)
    if action == "set_value":
        return backend.set_value("new value", element=5)
    return backend.click(element=5, button=action if action != "double" else "left",
                         click_count=2 if action == "double" else 1)


@pytest.mark.parametrize("action", ELEMENT_ACTIONS)
@pytest.mark.parametrize("addressing", ["index", "both", "token"])
def test_element_addressing_preserves_target_and_stale_verdict(action, addressing):
    properties = {"element_index"} if addressing == "index" else {"element_token"}
    if addressing == "both":
        properties.add("element_index")
    backend = _backend(properties)

    result = _invoke(backend, action)

    assert not result.ok
    assert result.code == "stale_element_token"
    name, args = backend._session.call_tool.call_args.args
    assert name == {"double": "double_click", "scroll": "scroll",
                    "set_value": "set_value"}.get(action, "click")
    assert args["pid"] == 42 and args["window_id"] == 7
    assert args["session"] == "addressing-test"
    if addressing == "token":
        assert "element_index" not in args
    else:
        assert args["element_index"] == 5
    if addressing == "index":
        assert "element_token" not in args
    else:
        assert args["element_token"] == TOKEN
    if action == "set_value":
        assert args["value"] == "new value"
    if action in {"left", "right", "middle"}:
        assert args["button"] == action


@pytest.mark.parametrize("action", ELEMENT_ACTIONS)
@pytest.mark.parametrize("invalidate", ["missing", "new_target", "transport_reset"])
def test_token_only_driver_refuses_missing_snapshot_before_dispatch(action, invalidate):
    backend = _backend({"element_token"}, token=None if invalidate == "missing" else TOKEN)
    if invalidate == "new_target":
        backend._set_active_target({"pid": 42, "window_id": 7})
    if invalidate == "transport_reset":
        backend._handle_transport_reset()
        backend._set_active_target({"pid": 42, "window_id": 7})

    result = _invoke(backend, action)

    assert not result.ok
    assert result.code == "snapshot_token_required"
    backend._session.call_tool.assert_not_called()


@pytest.mark.parametrize("addressing", ["both", "token", "capability"])
def test_explicit_token_is_forwarded_without_generic_argument_filtering(addressing):
    properties = {"element_token"}
    if addressing == "both":
        properties.add("element_index")
    backend = _backend(properties if addressing != "capability" else {"element_index"},
                       capabilities={"accessibility.element_tokens"})
    args = {"pid": 42, "window_id": 7, "element_token": TOKEN, "unrecognized": "keep"}

    result = backend._action("click", args)

    assert result.code == "stale_element_token"
    assert backend._session.call_tool.call_args.args[1] == {**args, "session": "addressing-test"}


def test_capability_only_legacy_driver_still_receives_cached_token():
    backend = _backend({"element_index"}, capabilities={"accessibility.element_tokens"})

    _invoke(backend, "left")

    args = backend._session.call_tool.call_args.args[1]
    assert args["element_index"] == 5
    assert args["element_token"] == TOKEN


@pytest.mark.parametrize("button", ["left", "right", "middle"])
@pytest.mark.parametrize("button_supported", [False, True])
@pytest.mark.parametrize("target", ["element", "coordinate"])
def test_double_click_button_intent_follows_live_schema(button, button_supported, target):
    properties = {"element_token"}
    if button_supported:
        properties.add("button")
    backend = _backend(properties)
    addressing = {"element": 5} if target == "element" else {"x": 10, "y": 20}

    result = backend.click(**addressing, button=button, click_count=2)

    if button != "left" and not button_supported:
        assert not result.ok
        assert result.code == "button_unsupported"
        backend._session.call_tool.assert_not_called()
    else:
        name, args = backend._session.call_tool.call_args.args
        assert name == "double_click"
        if button_supported:
            assert args["button"] == button
        else:
            assert "button" not in args
        assert args["pid"] == 42 and args["window_id"] == 7
        if target == "element":
            assert args["element_token"] == TOKEN
        else:
            assert (args["x"], args["y"]) == (10, 20)
