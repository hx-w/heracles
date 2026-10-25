import asyncio
from datetime import timedelta

import pytest
from pydantic import ValidationError

from heracles.domain.models import CoachReply
from heracles.domain.metrics import fresh_metrics
from heracles.integrations.garmin import empty_plan, normalize, source_time
from heracles.service import CoachService
from heracles.storage import Store, now, today


def test_garmin_battery_uses_declared_column_not_assumed_third_value():
    raw = {'battery': {'date': today().isoformat(), 'fetched_at': now(), 'data': [{'bodyBatteryValueDescriptorDTOList': [{'bodyBatteryValueDescriptorIndex': 0, 'bodyBatteryValueDescriptorKey': 'timestamp'}, {'bodyBatteryValueDescriptorIndex': 1, 'bodyBatteryValueDescriptorKey': 'bodyBatteryLevel'}], 'bodyBatteryValuesArray': [[1791207000000, 24]]}]}}
    metrics = normalize(raw, [{'key': 'battery', 'status': 'available', 'source_at': None}])
    battery = next(m for m in metrics if m['key'] == 'body_battery')
    assert battery['value'] == 24
    assert battery['source_at'] == '2026-10-05T21:30:00+08:00'


def test_readiness_utc_field_does_not_shift_measurement_eight_hours():
    record = [{'timestamp': '2026-10-05T11:19:47.0', 'timestampLocal': '2026-10-05T19:19:47.0'}]
    assert source_time('readiness', record) == '2026-10-05T19:19:47+08:00'


def test_fresh_fetch_does_not_make_old_body_state_current():
    old = (today() - timedelta(days=2)).isoformat() + 'T21:30:00+08:00'
    metrics = [{'key': 'body_battery', 'status': 'available', 'value': 93, 'source_at': old, 'fetched_at': now(), 'detail': 'device history'}, {'key': 'hrv', 'status': 'available', 'value': 60, 'source_at': None, 'fetched_at': now(), 'detail': '设备日期 ' + today().isoformat()}]
    health = {'account': {'connected': True}, 'metrics': metrics}
    assert fresh_metrics(health) == {'hrv': 60}
    health['account']['connected'] = False
    assert fresh_metrics(health) == {}


def test_generated_legacy_plan_is_not_presented_as_garmin(tmp_path):
    service = CoachService.__new__(CoachService)
    service.store = Store(tmp_path / 'training.sqlite')
    service.store.put('plan', {'revision': 5, 'workouts': [{'date': today().isoformat(), 'title': '教练生成课程'}]})
    assert service.ensure_plan()['status'] == 'missing'
    assert service.store.get('plan')['workouts'] == []


def test_coach_cannot_submit_generated_workouts():
    with pytest.raises(ValidationError):
        CoachReply.model_validate({'summary': '已经调整', 'sections': [], 'profile_update': None, 'tool_requests': [], 'workouts': [{'title': '额外训练'}]})


def test_structured_reply_rejects_blank_sections_and_monolithic_summary():
    with pytest.raises(ValidationError):
        CoachReply(summary='结论', sections=[{'title': '身体状态', 'items': [' ']}], tool_requests=[])
    with pytest.raises(ValidationError):
        CoachReply(summary='长' * 401, sections=[], tool_requests=[])


def test_new_garmin_snapshot_survives_coach_turn(tmp_path, monkeypatch):
    import heracles.service as module

    service = CoachService.__new__(CoachService)
    service.store = Store(tmp_path / 'training.sqlite')
    service.sync_running = False
    service.coach_status = {'busy': True, 'phase': None, 'error': None}
    original = {**empty_plan(), 'status': 'available', 'name': '佳明计划', 'workouts': [{'id': 'uuid:one', 'date': today().isoformat(), 'title': '基础训练', 'status': 'planned'}]}
    newer = {**original, 'workouts': [{**original['workouts'][0], 'status': 'completed'}]}
    service.store.put('plan', original)

    async def sync():
        return None

    async def refresh():
        return None

    service.sync_data = sync
    service.refresh_status = refresh
    service.coaching_context = lambda: {'plan': service.ensure_plan()}

    async def generate(context, tools, progress):
        service.store.put('plan', newer)
        return CoachReply(summary='以佳明原计划为准。', sections=[{'title': '执行建议', 'items': ['今天的训练已同步完成，不追加课程。']}], tool_requests=[])

    monkeypatch.setattr(module, 'generate', generate)
    asyncio.run(service.coach_turn())
    assert service.store.get('plan') == newer
    message = service.store.get('messages')[-1]
    assert message['sections'][0]['items'] == ['今天的训练已同步完成，不追加课程。']
    assert service.coach_status['busy'] is False


def test_failed_coach_does_not_replace_garmin_snapshot(tmp_path, monkeypatch):
    import heracles.service as module

    service = CoachService.__new__(CoachService)
    service.store = Store(tmp_path / 'training.sqlite')
    service.sync_running = False
    service.coach_status = {'busy': True, 'phase': None, 'error': None}
    plan = {**empty_plan(), 'status': 'available', 'name': '佳明原计划'}
    service.store.put('plan', plan)

    async def sync():
        return None

    async def refresh():
        return None

    async def fail(*args):
        raise RuntimeError('推理不可用')

    service.sync_data = sync
    service.refresh_status = refresh
    service.coaching_context = lambda: {'plan': plan}
    monkeypatch.setattr(module, 'generate', fail)
    asyncio.run(service.coach_turn())
    assert service.store.get('plan') == plan
    assert service.coach_status['error'] == '推理不可用'


def test_profile_save_and_retired_workout_action_cannot_modify_garmin(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import heracles.api as api

    monkeypatch.setattr(api, 'DATA', tmp_path)
    service = CoachService.__new__(CoachService)
    service.store = Store(tmp_path / 'training.sqlite')
    service.coach_status = {'busy': False}
    plan = {**empty_plan(), 'status': 'available', 'workouts': [{'id': 'uuid:one', 'date': today().isoformat(), 'title': '基础训练', 'status': 'planned'}]}
    service.store.put('plan', plan)
    app = FastAPI()
    api.install_routes(app, service)
    with TestClient(app) as client:
        client.cookies.set('heracles_session', (tmp_path / 'access-key').read_text().strip())
        response = client.post('/api/profile', json={'goal': '提高越野耐力', 'target_date': None, 'weekly_days': 4, 'experience': '已有跑步基础', 'notes': ''})
        assert response.status_code == 200
        assert service.store.get('plan') == plan
        response = client.post('/api/workouts/' + today().isoformat(), json={'status': 'completed'})
        assert response.status_code == 404
        assert service.store.get('plan')['workouts'][0]['status'] == 'planned'


def test_failed_sync_keeps_courses_and_marks_body_measurements_stale(tmp_path):
    from types import SimpleNamespace

    service = CoachService.__new__(CoachService)
    service.store = Store(tmp_path / 'training.sqlite')
    service.sync_running = False
    plan = {**empty_plan(), 'status': 'available', 'workouts': [{'id': 'uuid:one', 'title': '基础训练'}]}
    health = {'account': {'connected': True}, 'metrics': [{'key': 'body_battery', 'value': 40, 'status': 'available', 'fetched_at': now(), 'source_at': now(), 'detail': ''}]}
    service.store.put_many({'plan': plan, 'health': health})

    def fail():
        raise RuntimeError('数据读取失败')

    service.garmin = SimpleNamespace(sync=fail)
    result = asyncio.run(service.sync_data())
    assert service.store.get('plan')['workouts'] == plan['workouts']
    assert service.store.get('plan')['status'] == 'error'
    assert result['metrics'][0]['value'] == 40
    assert fresh_metrics(result) == {}
    assert service.sync_running is False


def test_native_metric_window_preserves_units_and_reports_omitted_records():
    from datetime import datetime, timezone
    from heracles.domain.models import ToolRequest
    from heracles.service import activity_for_coach

    beginning = datetime(2026, 10, 8, 0, 0, tzinfo=timezone.utc)
    records = [{'type': 'record', 'fields': [
        {'name': 'timestamp', 'value': (beginning + timedelta(seconds=i)).isoformat(), 'units': None},
        {'name': 'heart_rate', 'value': 120 + i, 'units': 'bpm'},
        {'name': 'power', 'value': 200, 'units': 'watts'},
    ]} for i in range(260)]
    payload = {'native': {'data': {'messages': records}}, 'sources': {}, 'streams': {}}
    request = ToolRequest(action='activity_details', activity_id='1', metrics=['heart_rate'], start_at=(beginning + timedelta(seconds=1)).isoformat(), end_at=(beginning + timedelta(seconds=258)).isoformat())
    result = activity_for_coach(payload, request)
    assert result['native_window']['total_records'] == 258
    assert result['native_window']['omitted_records'] == 2
    assert result['native_window']['next_record_at'] == (beginning + timedelta(seconds=257)).isoformat()
    assert result['native_records'][0]['fields'] == [{'name': 'heart_rate', 'value': 121, 'units': 'bpm'}]
    assert result['native_records'][-1]['fields'][0]['value'] == 376
    assert len(payload['native']['data']['messages']) == 260


def test_activity_window_requires_unambiguous_time_order():
    from heracles.domain.models import ToolRequest

    with pytest.raises(ValidationError):
        ToolRequest(action='activity_details', activity_id='1', start_at='2026-10-08T08:00:00')
    with pytest.raises(ValidationError):
        ToolRequest(action='activity_details', activity_id='1', start_at='2026-10-08T08:00:00+08:00', end_at='2026-10-07T08:00:00+08:00')
