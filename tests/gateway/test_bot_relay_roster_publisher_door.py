"""The canonical gateway's ``bot_relay.roster.sync`` door takes the pushing Desktop's ``publisher``
(#139219): each Desktop's push replaces only its own slice, as on the tui_gateway door."""
import json
from types import SimpleNamespace

import pytest

from gateway import session_bot
from hermes_state_runtime import RuntimeStoreError
from tests.gateway.test_profile_retire_stops_turns import _Agent, _authority
from tests.gateway.test_retired_authority_cron_fence import CRON
from tools import bot_relay


def _push(authority, params):
    return session_bot.relay_operation(SimpleNamespace(authority=authority, actor=CRON), 'roster', params)


def test_session_door_merges_publishers(tmp_path):
    db, authority, _execute, _returned = _authority(tmp_path, _Agent())
    try:
        home = tmp_path
        assert _push(authority, {'publisher': 'local-aaaaaaaaaaaa', 'agents': [
            {'profile': 'alice', 'handle': 'alice', 'connection_id': 'lan'}]}) == {'count': 1}
        assert _push(authority, {'publisher': 'local-bbbbbbbbbbbb', 'agents': [
            {'profile': 'bob', 'handle': 'bob', 'connection_id': 'vps'}]}) == {'count': 1}
        assert [r['profile'] for r in bot_relay.read_remote_roster(home)] == ['alice', 'bob']
        with pytest.raises(RuntimeStoreError, match='invalid_params'):
            _push(authority, {'agents': [], 'other': 1})
    finally:
        db.close()


def test_session_door_drains_for_the_named_publisher(tmp_path):
    db, authority, _execute, _returned = _authority(tmp_path, _Agent())
    try:
        door = SimpleNamespace(authority=authority, actor=CRON)
        env = bot_relay.enqueue_envelope(tmp_path, target={'connection_id': 'lan', 'profile': 'scout', 'handle': 'scout'},
                                         message='hi', sender_profile='ops', sender_handle='ops')
        path = bot_relay.relay_root(tmp_path) / 'outbox' / f"{env['id']}.json"
        path.write_text(json.dumps({**env, 'target_publishers': ['desktop-aaaaaaaaaaaa']}))
        assert session_bot.relay_operation(door, 'outbox', {}) == {'envelopes': []}
        drained = session_bot.relay_operation(door, 'outbox', {'publisher': 'desktop-aaaaaaaaaaaa'})
        assert [e['id'] for e in drained['envelopes']] == [env['id']]
    finally:
        db.close()
