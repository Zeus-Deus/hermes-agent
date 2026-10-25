"""One-turn overrides resolve only in current code; ordinary turns stay usable."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from gateway import code_skew
from gateway.session_cli_turn import admit_cli_turn, cli_turn_scope, one_turn_route
from hermes_cli import model_switch


@pytest.mark.parametrize('state', ['skew', 'fresh', 'non-git'])
def test_one_turn_override_refuses_stale_resolution_without_changing_admitted_intent(monkeypatch, state):
    calls = []

    def resolve(**kwargs):
        calls.append(kwargs['raw_input'])
        return model_switch.ModelSwitchResult(success=True, new_model=kwargs['raw_input'],
                                              target_provider='custom')

    monkeypatch.setattr(model_switch, 'switch_model', resolve)
    monkeypatch.setattr(code_skew, '_boot_fingerprint', None if state == 'non-git' else 'git:main:aaaaaaaaaaaa')
    monkeypatch.setattr(code_skew, '_fingerprint', lambda: {
        'skew': 'git:main:bbbbbbbbbbbb', 'fresh': 'git:main:aaaaaaaaaaaa', 'non-git': None}[state])
    admitted = admit_cli_turn({'model_override': {'model': 'picked', 'provider': 'custom'}})
    original = deepcopy(admitted)
    runtime = {'provider': 'custom', 'base_url': 'http://127.0.0.1:9/v1', 'api_key': 'inert'}
    turn = SimpleNamespace(_ctx=SimpleNamespace(inbound_message_id='owned-turn', user_config={}))
    # Neither ordinary turns nor another admission inherit the override or need a fresh-code gate.
    assert one_turn_route(turn, None, 'frozen', runtime) == ('frozen', runtime)
    with cli_turn_scope('other-turn', admitted['cli_turn_v1']):
        assert one_turn_route(turn, None, 'frozen', runtime) == ('frozen', runtime)
    with cli_turn_scope('owned-turn', admitted['cli_turn_v1']):
        if state == 'skew':
            with pytest.raises(RuntimeError) as error:
                one_turn_route(turn, None, 'frozen', runtime)
            assert 'hermes gateway restart' in str(error.value)
            assert 'aaaaaaaaaa' in str(error.value) and 'bbbbbbbbbb' in str(error.value)
            assert calls == []
        else:
            model, selected = one_turn_route(turn, None, 'frozen', runtime)
            assert model == 'picked' and selected['base_url'] == runtime['base_url']
            assert calls == ['picked']
    assert admitted == original  # execution guard never rewrites admission/retry identity
    assert runtime == {'provider': 'custom', 'base_url': 'http://127.0.0.1:9/v1', 'api_key': 'inert'}
    assert one_turn_route(turn, None, 'frozen', runtime) == ('frozen', runtime)
