import asyncio
from types import SimpleNamespace

import pytest

from harness import client


def test_official_runtime_is_closed_even_if_initialization_fails(tmp_path, monkeypatch):
    import deepseek_harness
    calls = []
    class Runtime:
        def __init__(self, **options):
            assert options['model'] == 'deepseek-flash'
            assert options['profile'] == 'sdk-minimal'
        def start(self):
            calls.append('start')
            raise TimeoutError('private provider diagnostics')
        def close(self): calls.append('close')
    monkeypatch.setattr(deepseek_harness, 'DeepSeekHarness', Runtime)
    monkeypatch.setattr(client, 'DATA', tmp_path)
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'test-only')
    with pytest.raises(RuntimeError, match='超时'):
        client.request('/turn', {'context': {}})
    assert calls == ['start', 'close']
    assert not client.LOCK.locked()


def test_refresh_updates_context_used_to_validate_final_proposal(monkeypatch):
    contexts = []
    def request(path, body):
        contexts.append(body['context']['plan']['name'])
        return {'text': '{"summary":"核实数据","sections":[],"tool_requests":[{"action":"refresh_data"}]}' if len(contexts) == 1 else '{"summary":"完成","sections":[],"tool_requests":[]}'}
    monkeypatch.setattr(client, 'request', request)
    context = {'plan': {'name': 'old'}}
    snapshot = {key: {} for key in ('health', 'fresh_metrics', 'garmin_context', 'visualization_catalog')}
    snapshot.update(plan={'name': 'new', 'status': 'available'}, checkin={'fatigue': 3}, active_sessions=[])
    asyncio.run(client.generate(context, lambda tool: snapshot))
    assert contexts == ['old', 'new']
    assert context['plan']['name'] == 'new'
    assert context['checkin']['fatigue'] == 3


def test_provider_diagnostics_are_not_exposed_in_chat(tmp_path, monkeypatch):
    import deepseek_harness
    class Runtime:
        def __init__(self, **kwargs): pass
        def start(self): pass
        def run(self, *args, **kwargs): raise ValueError('SECRET diagnostic')
        def close(self): pass
    monkeypatch.setattr(deepseek_harness, 'DeepSeekHarness', Runtime)
    monkeypatch.setattr(client, 'DATA', tmp_path)
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'test-only')
    with pytest.raises(RuntimeError) as error:
        client.request('/turn', {'context': {}})
    assert 'SECRET' not in str(error.value)
