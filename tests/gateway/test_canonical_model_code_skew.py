"""Canonical model admission must not select through a hot-updated owner.

Real authority, dispatch, policy and SQLite receipts; only inventory/provider work
is substituted. No model endpoint or live profile is used.
"""
import asyncio
from dataclasses import replace
from types import SimpleNamespace

import pytest
import pytest_asyncio

from gateway import code_skew
from tests.gateway import test_session_mutation_model_busy as busy
from tests.waiting import async_wait_until


_BOOT = 'git:refs/heads/main:aaaaaaaaaaaa'
_DISK = 'git:refs/heads/main:bbbbbbbbbbbb'


def _revision(monkeypatch, state):
    monkeypatch.setattr(code_skew, '_boot_fingerprint', None if state in {'non-git', 'unrecorded'} else _BOOT)
    monkeypatch.setattr(code_skew, '_fingerprint', lambda: {
        'skew': _DISK, 'fresh': _BOOT, 'non-git': None,
        'unrecorded': _DISK, 'unreadable': None}[state])


def _restart_error(reply):
    from agent.i18n import t
    assert 'error' in reply, reply
    assert reply['error']['code'] == 5098, reply
    assert reply['error']['data']['reason'] == 'code_skew', reply
    assert reply['error']['message'] == t('gateway.model.error_prefix', error=t(
        'gateway.model.err_skew', boot_rev='aaaaaaaaaa', disk_rev='bbbbbbbbbb'))
    assert 'hermes gateway restart' in reply['error']['message']


async def _denials(owner, request):
    actor = owner.actor
    try:
        for changed, reason in (
            (replace(actor, profile_id='foreign'), 'profile_mismatch'),
            (replace(actor, capabilities=frozenset()), 'permission_denied'),
        ):
            owner.actor = changed
            reply = await owner.dispatch(request)
            assert reply.get('error', {}).get('data', {}).get('reason') == reason, reply
            assert reply['error']['code'] != 5098, reply
    finally:
        owner.actor = actor


def _request(db, ref, rid='pick'):
    row = db.get_session(ref.session_id)
    return {'id': 1, 'method': 'session.mutate', 'params': {
        'session_id': ref.session_id, 'request_id': rid,
        'expected_revision': row['runtime_revision'], 'expected_generation': row['runtime_generation'],
        'operation': 'model', 'payload': {'model': 'picked'}}}


def _durable(db, ref):
    with db._read_ctx() as conn:
        meta = [tuple(row) for row in conn.execute('SELECT key,value FROM state_meta ORDER BY key')]
    return db.get_session(ref.session_id), meta


@pytest_asyncio.fixture
async def owner_state(tmp_path, monkeypatch):
    from hermes_cli import inventory, model_selection_guards, model_switch
    monkeypatch.chdir(tmp_path)  # the shared fixture's relative profile id stays task-private
    started, release = asyncio.Event(), asyncio.Event()

    async def handle(event):
        started.set()
        await release.wait()
        return 'ok'

    store, db, authority, owner, ref = busy._owner(tmp_path, monkeypatch, handle)
    calls, events = [], []
    switch = model_switch.switch_model

    def resolve(**kwargs):
        calls.append('resolve')
        return switch(**kwargs)

    def context():
        calls.append('inventory')
        return SimpleNamespace(with_overrides=lambda **kwargs: kwargs)

    def options(ctx, **kwargs):
        calls.append('options')
        return {'providers': [], 'provider': ctx['current_provider'] or '', 'model': ctx['current_model']}

    monkeypatch.setattr(model_switch, 'switch_model', resolve)
    monkeypatch.setattr(model_selection_guards, 'selection_warnings', lambda *a, **k: [])
    monkeypatch.setattr(inventory, 'load_picker_context', context)
    monkeypatch.setattr(inventory, 'build_model_options_payload', options)
    stream = authority.sessions[ref.session_id].event_stream
    publish = stream.publish
    monkeypatch.setattr(stream, 'publish', lambda sid, payload, **kwargs: (
        events.append((kwargs.get('event_type'), payload)), publish(sid, payload, **kwargs))[1])
    _revision(monkeypatch, 'fresh')
    try:
        yield SimpleNamespace(db=db, authority=authority, owner=owner, ref=ref, calls=calls,
                              events=events, started=started, release=release)
    finally:
        release.set()
        await owner.close()
        store.close_all_db_handles()


@pytest.mark.asyncio
@pytest.mark.parametrize('state', ['skew', 'fresh', 'non-git', 'unrecorded', 'unreadable'])
async def test_model_options_admission_preserves_auth_and_read_access(owner_state, monkeypatch, state):
    s = owner_state
    _revision(monkeypatch, state)
    request = {'id': 1, 'method': 'model.options', 'params': {'session_id': s.ref.session_id}}
    await _denials(s.owner, request)
    before = _durable(s.db, s.ref)
    result = await s.owner.dispatch(request)
    if state == 'skew':
        _restart_error(result)
        assert s.calls == []  # refuse before inventory lazy imports/builds
        # The global picker is guarded too, without needing a mounted session.
        _restart_error(await s.owner.dispatch({'id': 2, 'method': 'model.options', 'params': {}}))
    else:
        assert result['result']['model'] == 'frozen', result
        assert s.calls == ['inventory', 'options']
    assert _durable(s.db, s.ref) == before
    assert s.events == []
    for method, params in (
        ('session.info', {'session_id': s.ref.session_id}),
        ('config.get', {'session_id': s.ref.session_id, 'key': 'profile'}),
    ):
        assert 'result' in await s.owner.dispatch({'id': 3, 'method': method, 'params': params})


@pytest.mark.asyncio
@pytest.mark.parametrize('state', ['skew', 'fresh', 'non-git'])
@pytest.mark.parametrize('phase', ['idle', 'busy', 'retry-idle', 'retry-busy', 'apply-pending'])
async def test_model_mutation_admission_preserves_receipts_and_turn_safety(owner_state, monkeypatch, state, phase):
    from gateway.session_contract import Submission
    from gateway.session_deferred_pick import apply_deferred_pick, defer_pick, _PREFIX
    from hermes_state_mutation_retirement import has_mutation_receipt

    s = owner_state
    if phase in {'busy', 'retry-busy'}:
        await s.authority.submit(s.owner.actor, Submission('held', s.ref, {'text': 'RUNNING'}, 'queue'))
        await async_wait_until(s.started.is_set, timeout=10, what='the real turn is held')
    request = _request(s.db, s.ref)
    original = None
    if phase.startswith('retry'):
        original = await s.owner.dispatch(request)
        assert 'result' in original, original
    elif phase == 'apply-pending':
        defer_pick(s.authority, s.owner.actor, s.ref, request['params'])
    _revision(monkeypatch, state)
    # Receipt existence must not bypass current principal/profile/capability authorization.
    if not phase.startswith('retry'):
        await _denials(s.owner, request)
    else:
        actor = s.owner.actor
        s.owner.actor = replace(actor, capabilities=frozenset({'session:read'}))
        try:
            denied = await s.owner.dispatch(request)
            assert denied['error']['data']['reason'] == 'permission_denied', denied
        finally:
            s.owner.actor = actor
    before = _durable(s.db, s.ref)
    s.calls.clear()
    s.events.clear()
    if phase == 'apply-pending':
        await apply_deferred_pick(s.authority, s.ref, s.authority.sessions[s.ref.session_id])
        row, meta = _durable(s.db, s.ref)
        assert not any(key == _PREFIX + s.ref.session_id for key, _ in meta)
        if state == 'skew':
            refused = [p for _, p in s.events if p.get('status') == 'refused']
            assert refused and refused[0]['reason'] == 'code_skew', s.events
            assert row == before[0]
            assert s.calls == []
            assert not has_mutation_receipt(s.db, s.owner.actor.subject, s.ref.session_id, 'deferred-pick:pick')
        else:
            assert row['model'] == 'picked'
            assert s.calls == ['resolve']
        return
    reply = await s.owner.dispatch(request)
    if original is not None:
        assert reply['result'] == original['result'], reply
        assert _durable(s.db, s.ref) == before
        assert s.calls == []
        assert not [p for kind, p in s.events if kind == 'session.updated']
    elif state == 'skew':
        _restart_error(reply)
        assert _durable(s.db, s.ref) == before
        assert s.calls == []
        assert s.events == []
        assert not has_mutation_receipt(s.db, s.owner.actor.subject, s.ref.session_id, 'pick')
        # Unrelated metadata writes still work on a stale process.
        rename = _request(s.db, s.ref, 'rename')
        rename['params'].update(operation='rename', payload={'title': 'still editable'})
        assert 'result' in await s.owner.dispatch(rename)
    elif phase == 'busy':
        assert reply['result']['status'] == 'deferred', reply
        assert s.db.get_session(s.ref.session_id) == before[0]
        assert s.calls == []
    else:
        assert reply['result']['model'] == 'picked', reply
        assert s.db.get_session(s.ref.session_id)['model'] == 'picked'
        assert s.calls == ['resolve']
    if phase in {'busy', 'retry-busy'}:
        assert busy._running_model(s.authority, s.ref) == 'frozen'
