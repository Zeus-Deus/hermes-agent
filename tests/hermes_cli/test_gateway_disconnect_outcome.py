"""Expected keepalive close preserves an honest unknown outcome and no task traceback."""
import argparse
import asyncio
from contextlib import nullcontext
import json

import pytest
from websockets.exceptions import ConnectionClosedError

from hermes_cli.gateway_client import GatewayClient, GatewayClientError


@pytest.mark.asyncio
async def test_keepalive_close_releases_waiters_without_unhandled_reader_exception():
    class Disconnected:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise ConnectionClosedError(None, None)

    client = GatewayClient(Disconnected())
    pending = asyncio.get_running_loop().create_future()
    client.pending[1] = pending
    await client._read()
    with pytest.raises(GatewayClientError, match='outcome is unknown'):
        await pending
    assert 'do not resend' in str(await client.events.get())


@pytest.mark.asyncio
async def test_idle_composer_exits_with_unknown_outcome_when_owner_dies_without_keypress(monkeypatch):
    """The owner dying while the REPL waits for input must end the viewer at once with the
    unknown-outcome hint; the pending line read is cancelled rather than awaited forever."""
    from websockets.asyncio.server import serve

    from hermes_cli import gateway_chat

    snapshot = {"stored_session_id": "stored", "execution_generation": 1, "pending": []}
    attached = asyncio.Event()
    reads = []

    async def peer(ws):
        async for raw in ws:
            request = json.loads(raw)
            result = snapshot if request["method"] == "session.resume" else {}
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}))

    class IdleInput:
        def __init__(self, **_kwargs):
            pass

        async def prompt_async(self, _prompt):
            attached.set()
            try:
                await asyncio.Future()  # nobody ever presses a key
            except asyncio.CancelledError:
                reads.append("cancelled")
                raise

    monkeypatch.setattr("prompt_toolkit.PromptSession", IdleInput)
    monkeypatch.setattr("prompt_toolkit.patch_stdout.patch_stdout", nullcontext)
    async with serve(peer, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        monkeypatch.setenv("HERMES_TUI_GATEWAY_URL", f"ws://127.0.0.1:{port}")
        viewer = asyncio.create_task(gateway_chat.run_gateway_chat(argparse.Namespace(resume="stored")))
        await asyncio.wait_for(attached.wait(), 5)
        server.close(close_connections=True)
        with pytest.raises(GatewayClientError, match="outcome is unknown"):
            await asyncio.wait_for(viewer, 3)
    assert reads == ["cancelled"]


@pytest.mark.asyncio
async def test_a_request_sent_on_a_dropped_socket_is_a_gateway_error():
    """A request made after the gateway hung up, but before the viewer redials, fails at
    ``websocket.send``. That failure is the same unknown-outcome ``GatewayClientError`` the
    reader gives a request already waiting, not a raw ``websockets`` exception: the live-work
    footer's poller catches only gateway errors, and a raw one killed its thread for good."""
    from websockets.asyncio.server import serve

    opened = asyncio.get_running_loop().create_future()

    async def peer(ws):
        opened.set_result(ws)
        await ws.wait_closed()

    async with serve(peer, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        from websockets.asyncio.client import connect
        async with connect(f"ws://127.0.0.1:{port}") as ws, GatewayClient(ws) as client:
            (await asyncio.wait_for(opened, 5)).transport.abort()  # no close frame, as a dead owner
            await asyncio.wait_for(asyncio.shield(client.reader), 5)
            with pytest.raises(GatewayClientError, match="outcome is unknown"):
                await client.rpc("subagent.list", session_id="s")
            assert client.pending == {}


@pytest.mark.asyncio
async def test_a_send_outlived_by_its_reader_leaves_no_unretrieved_future():
    """A keepalive timeout leaves the socket closing: ``send`` waits for the close while the reader
    ends and fails every waiting request. The request whose ``send`` then raises never awaits its
    future, which asyncio would log as "Future exception was never retrieved" on every poll."""
    import gc

    reader_done = asyncio.Event()

    class Closing:
        def __aiter__(self):
            return self

        async def __anext__(self):
            await asyncio.sleep(0)  # let the request register and start sending first
            raise ConnectionClosedError(None, None)

        async def send(self, _raw):
            await reader_done.wait()
            raise ConnectionClosedError(None, None) from TimeoutError("timed out while closing connection")

    unretrieved = []
    loop = asyncio.get_running_loop()
    loop.set_exception_handler(lambda _loop, context: unretrieved.append(context.get("message")))
    try:
        async with GatewayClient(Closing()) as client:
            request = asyncio.ensure_future(client.rpc("process.list", session_id="s"))
            await client.reader
            reader_done.set()
            with pytest.raises(GatewayClientError, match="outcome is unknown"):
                await request
        del request
        gc.collect()
        await asyncio.sleep(0)
    finally:
        loop.set_exception_handler(None)
    assert unretrieved == []
