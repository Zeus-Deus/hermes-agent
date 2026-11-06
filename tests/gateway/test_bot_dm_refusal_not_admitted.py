"""Every Bot Chat DM refusal the owner answers before anything was admitted is a definite, named
no-send, not "admission could not be confirmed ... Do not resend" (#147949, #148377, #146785).

The owner's door refuses under the mailbox lock that every admission holds, and it pins a receipt
before it admits. So a refusal that leaves no receipt (or only a ``refused`` one) and no FIFO row
committed nothing: a Bot Chat the sender cannot adopt (``not_found``), a full or busy owner, a
refusal of the delivery itself. The tool settles it as never sent and says so with the reason,
like the held-writer refusal it already settled. A refusal after a commit stays ambiguous.
"""
import asyncio
import json

import pytest

from hermes_state_runtime import RuntimeStoreError

from tests.gateway import test_bot_dm_held_by_session_writer as _held

held = _held.held
_send, _admissions, _resubmit, _runner = _held._send, _held._admissions, _held._resubmit, _held._runner


def _foreign_login_bot_chat(held):
    """A Desktop Bot Chat a served login stamped (#140183): kept in place for that login, so no
    delivery may adopt it or move it aside. The door refuses it ``not_found``."""
    held.release()
    held.db._execute_write(lambda conn: conn.execute(
        "UPDATE sessions SET user_id='github:alice' WHERE id=?", (_held.CHAT,)))


@pytest.mark.asyncio
async def test_a_bot_chat_the_sender_cannot_adopt_is_a_named_definite_no_send(held):
    from tools.bot_live_delivery import read_delivery_result
    _foreign_login_bot_chat(held)
    refused = await _send(held, 'ping')
    assert refused.get('reason') == 'not_found' and 'status' not in refused, refused
    assert 'NOT sent' in refused['error'] and 'Do not resend' not in refused['error'], refused
    assert 'cannot adopt' in refused['error'], 'the owner names the check that refused'
    # The intent and payload are gone, and the owner holds the id's terminal not-sent receipt.
    assert sorted(path.name for path in held.dm_dir.iterdir()) == []
    receipt = read_delivery_result(held.home, refused['delivery_id'])
    assert (receipt['refused'], receipt['status'], receipt['reason']) == (True, 'failed', 'not_found'), receipt
    assert not receipt.get('admission_id') and 'not_found' in receipt['error'], receipt
    # A later attempt under the id (a runner retry) gets that disposition, never an admission.
    again = await asyncio.to_thread(_resubmit, held, refused['delivery_id'], 'ping')
    assert again.get('refused') is True and again['status'] == 'failed', again
    assert _admissions(held) == [] and held.executed == []
    # The kept history is never moved aside by the refusal.
    assert held.db.get_session_by_title('Bot Chat')['id'] == _held.CHAT


@pytest.mark.asyncio
async def test_the_runner_settles_a_not_found_refusal_with_its_payload(held, capsys):
    from tools import bot_mode_dm
    _foreign_login_bot_chat(held)
    dm_file = bot_mode_dm._write_dm_file('ping')
    assert await asyncio.to_thread(_runner, held, dm_file) == 1
    refused = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert refused.get('reason') == 'not_found' and 'NOT sent' in refused['error'], refused
    assert sorted(path.name for path in held.dm_dir.iterdir()) == []
    assert _admissions(held) == [] and held.executed == []


@pytest.mark.asyncio
async def test_a_settle_whose_answer_was_lost_is_a_definite_no_send_on_replay(held, monkeypatch, capsys):
    """The owner settled the refusal but its answer never reached the tool: the tool keeps the
    intent (the outcome is unknown to it). Replaying that intent gets the id's terminal refused
    receipt as an ordinary answer, which is the same definite no-send."""
    from tools import bot_live_delivery
    _foreign_login_bot_chat(held)
    settle = bot_live_delivery.authority_settle

    def settled_then_lost(home, params):
        settle(home, params)
        raise ConnectionError('connection closed before the answer')

    monkeypatch.setattr(bot_live_delivery, 'authority_settle', settled_then_lost)
    first = await _send(held, 'ping')
    assert first.get('status') == 'ambiguous', first
    [intent] = held.dm_dir.glob('*.live.json')
    monkeypatch.setattr(bot_live_delivery, 'authority_settle', settle)
    dm_file = str(intent)[:-len('.live.json')]
    assert await asyncio.to_thread(_runner, held, dm_file) == 1
    replayed = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert replayed.get('reason') == 'not_found' and 'NOT sent' in replayed['error'], replayed
    assert sorted(path.name for path in held.dm_dir.iterdir()) == []
    assert _admissions(held) == [] and held.executed == []


@pytest.mark.parametrize('reason, settled', [
    ('queue_full', None),           # an owner-state refusal: the pin is withdrawn
    ('permission_denied', 'agent_blocked'),  # a refusal of the delivery: the pin is settled refused
])
@pytest.mark.asyncio
async def test_a_refusal_before_the_commit_is_a_definite_no_send(held, monkeypatch, reason, settled):
    from tools.bot_live_delivery import read_delivery_result
    held.release()

    async def refused(self, *args):
        raise RuntimeStoreError(reason)

    monkeypatch.setattr(type(held.authority), 'admit_automation', refused)
    answer = await _send(held, 'ping')
    assert answer.get('reason') == reason and 'NOT sent' in answer['error'], answer
    assert 'Do not resend' not in answer['error'], answer
    if reason == 'queue_full':
        assert 'in a moment' in answer['error'], 'an owner-state refusal clears by itself'
    assert sorted(path.name for path in held.dm_dir.iterdir()) == []
    receipt = read_delivery_result(held.home, answer['delivery_id'])
    assert receipt['refused'] is True and not receipt.get('admission_id'), receipt
    assert receipt['reason'] == (settled or reason), receipt
    assert _admissions(held) == []


@pytest.mark.asyncio
async def test_a_refusal_after_the_commit_stays_ambiguous(held, monkeypatch):
    held.release()
    real = type(held.authority).admit_automation

    async def committed_then_refused(self, *args):
        await real(self, *args)
        raise RuntimeStoreError('queue_full')

    monkeypatch.setattr(type(held.authority), 'admit_automation', committed_then_refused)
    held.authority._schedule = lambda ref: None
    result = await _send(held, 'ping')
    assert result.get('status') == 'ambiguous' and 'Do not resend' in result['error'], result
    assert [path.name for path in held.dm_dir.glob('*.live.json')], 'the unknown admission keeps its intent'
    assert _admissions(held) == ['bot:' + result['delivery_id']]


@pytest.mark.asyncio
async def test_a_not_found_refusal_alone_leaves_the_id_open_for_a_same_id_retry(held):
    """Only the Bot DM tool's settle records a not-sent disposition: a producer retrying its record
    under the same id (the cron drain) admits it once the Bot Chat can be resolved."""
    from hermes_cli.gateway_client import GatewayRPCError
    _foreign_login_bot_chat(held)
    delivery_id = 'c' * 64
    with pytest.raises(GatewayRPCError) as refused:
        await asyncio.to_thread(_resubmit, held, delivery_id, 'cron report')
    assert str(refused.value) == 'not_found' and refused.value.data.get('admitted') is False
    assert refused.value.data.get('field') == 'bot_chat', refused.value.data
    held.db._execute_write(lambda conn: conn.execute(
        'UPDATE sessions SET user_id=NULL WHERE id=?', (_held.CHAT,)))
    admitted = await asyncio.to_thread(_resubmit, held, delivery_id, 'cron report')
    assert admitted.get('admission_id') and _admissions(held) == ['bot:' + delivery_id], admitted
