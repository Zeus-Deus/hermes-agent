"""double_click sends ``button`` only when the live driver schema advertises it."""

from unittest.mock import Mock

import pytest

from tools.computer_use.cua_backend import CuaDriverBackend
from tools.computer_use.cua_backend_session import _CuaDriverSession


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
