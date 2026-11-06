"""The Bots roster's registry lookup (``session.list title="Bot Chat"``) never strands a healthy
profile on ``not_found`` (#146785).

When the canonical title is held by a conversation no FIFO can own (an API or messaging row, an
unbound local row the caller cannot adopt), the deliver door moves it aside and mints the local
Bot Chat on the first DM. The Desktop asks the registry first and fails closed on a refusal
("Could not check <bot>'s Bot Chat registry (not_found)"), so the bot could not be opened at all
until another bot happened to message it. The lookup now takes the door's step itself.
"""
import pytest

from tests.gateway import test_peer_dm_bot_chat_headless as _headless_gateway
from tests.gateway.test_bot_chat_unadoptable_local_title import _deliver, _squatter

headless = _headless_gateway.headless
_local_owner = _headless_gateway._local_owner


async def _lookup(connection):
    return await connection.dispatch({'id': 1, 'method': 'session.list', 'params': {
        'title': 'Bot Chat', 'include_hidden': True, 'limit': 50}})


@pytest.mark.parametrize('source, column, value', [
    ('api_server', None, None),                              # a plain POST /api/sessions row
    ('telegram', 'session_key', 'agent:main:telegram:dm:42'),  # a messaging row
    ('tui', 'session_key', 'agent:main:tui:dm:stale'),       # a crash's route, never bound
    ('gui', 'user_id', 'uid:1001'),                          # another OS user's stamp
])
@pytest.mark.asyncio
async def test_the_registry_lookup_moves_an_unownable_holder_aside_and_answers_the_bot_chat(
        headless, monkeypatch, source, column, value):
    import gateway.session_worker_reservation as reservation
    monkeypatch.setattr(reservation, 'owner_worker_subject', lambda: 'uid:1000')
    db = headless.authority.db
    old = _squatter(db, 'old_bot_chat_holder', column=column, value=value, source=source)
    db.append_message(old, 'user', 'earlier')
    local = _local_owner(headless.authority)
    reply = await _lookup(local)
    assert 'result' in reply, reply
    [row] = reply['result']['sessions']
    new = row['session_id']
    assert new != old and str(db.get_session(new)['chat_id']).startswith('local-'), row
    assert db.get_session_by_title('Bot Chat')['id'] == new
    moved = db.get_session(old)
    assert moved['title'].startswith('Bot Chat (') and moved['message_count'] == 1, 'history is kept'
    # The next lookup and the next delivery both find that chat: nothing else is minted.
    assert [r['session_id'] for r in (await _lookup(local))['result']['sessions']] == [new]
    assert (await _deliver(headless.authority, 'a', local))['session_id'] == new
    assert len(db._read_all('SELECT id FROM sessions')) == 2


@pytest.mark.asyncio
async def test_kept_history_another_login_owns_still_fails_closed(headless):
    # A served login's own Desktop Bot Chat (#140183) is never moved aside: the lookup still refuses.
    db = headless.authority.db
    old = _squatter(db, 'desktop_bot_chat', column='user_id', value='github:alice', source='desktop')
    reply = await _lookup(_local_owner(headless.authority))
    assert reply.get('error', {}).get('data', {}).get('reason') == 'not_found', reply
    assert db.get_session_by_title('Bot Chat')['id'] == old and len(db._read_all('SELECT id FROM sessions')) == 1


@pytest.mark.asyncio
async def test_a_reader_that_cannot_create_never_moves_the_holder(headless):
    from gateway.session_controls import AuthorityConnection
    db = headless.authority.db
    old = _squatter(db, 'api_holder', column=None, value=None, source='api_server')
    reader = AuthorityConnection(headless.authority, object(), {
        'user_id': 'uid:1000', 'provider': 'local', 'profile_id': headless.authority.profile_id,
        'instance_id': headless.authority.instance_id, 'capabilities': ['session:read', 'session:submit']})
    reply = await _lookup(reader)
    assert reply.get('error', {}).get('data', {}).get('reason') == 'not_found', reply
    assert db.get_session_by_title('Bot Chat')['id'] == old and len(db._read_all('SELECT id FROM sessions')) == 1


@pytest.mark.asyncio
async def test_another_title_is_never_healed(headless):
    db = headless.authority.db
    sid = 'api_titled'
    db.create_session(sid, 'api_server')
    db.set_session_title(sid, 'Notes')
    reply = await _local_owner(headless.authority).dispatch({'id': 1, 'method': 'session.list', 'params': {
        'title': 'Notes', 'include_hidden': True, 'limit': 50}})
    assert reply.get('error', {}).get('data', {}).get('reason') == 'not_found', reply
    assert db.get_session(sid)['title'] == 'Notes' and len(db._read_all('SELECT id FROM sessions')) == 1
