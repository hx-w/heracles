import asyncio
from copy import deepcopy
from datetime import date

import pytest
from pydantic import ValidationError

from harness import client
from heracles.domain.models import CoachReply
from heracles.domain.visuals import resolve_visuals, visualization_catalog
from heracles.integrations.garmin import empty_health, empty_plan
from heracles.service import CoachService
from heracles.storage import Store

END = date(2026, 10, 8)
FETCHED = '2026-10-08T12:00:00+08:00'


def record(data, day='2026-10-08', status='available', **provenance):
    return {'data': data, 'data_date': day, 'requested_date': day, 'status': status,
            'source_at': None, 'fetched_at': FETCHED, **provenance}


def point(catalog, key, day='2026-10-08'):
    return next(p for p in catalog[key]['points'] if p['date'] == day)


def reply(**overrides):
    return CoachReply.model_validate({'summary': '按佳明计划训练。', 'sections': [], 'tool_requests': [], **overrides})


def test_catalog_preserves_zero_null_errors_and_daily_peak_not_current_battery():
    history = {'2026-10-08': {
        'stats': record({'totalSteps': 0, 'bodyBatteryHighestValue': 91}),
        'heart': record({'restingHeartRate': 0}),
        'battery': record([{'bodyBatteryValuesArray': [[1791421200000, 24]]}]),
        'sleep': record({'dailySleepDTO': {'calendarDate': '2026-10-08', 'sleepTimeSeconds': None, 'sleepScores': None}}),
        'stress': record({'avgStressLevel': 33}, status='error'),
        'spo2': record({'averageSpO2': float('nan')}),
        'respiration': record({'avgWakingRespirationValue': float('inf')}),
    }}
    catalog = visualization_catalog(history, END)
    assert point(catalog, 'steps')['value'] == 0
    assert point(catalog, 'steps')['status'] == 'available'
    assert point(catalog, 'resting_hr')['value'] == 0
    assert point(catalog, 'body_battery_peak')['value'] == 91
    assert point(catalog, 'sleep_hours')['value'] is None
    assert point(catalog, 'sleep_hours')['status'] == 'missing'
    assert point(catalog, 'stress')['value'] == 33
    assert point(catalog, 'stress')['status'] == 'error'
    assert point(catalog, 'spo2')['status'] == 'missing'
    assert point(catalog, 'respiration')['value'] is None
    assert point(catalog, 'steps', '2026-10-07')['value'] is None


def test_old_device_dates_never_become_current_and_latest_readiness_is_per_day():
    history = {'2026-10-08': {
        'hrv': record({'hrvSummary': {'calendarDate': '2026-10-06', 'lastNightAvg': 55}}),
        'sleep': record({'dailySleepDTO': {'calendarDate': '2026-10-07', 'sleepTimeSeconds': 25200, 'sleepScores': {'overall': {'value': 80}}}}),
        'readiness': record([
            {'calendarDate': '2026-10-07', 'timestampLocal': '2026-10-07T07:00:00', 'score': 40, 'recoveryTime': 120, 'acuteLoad': 80},
            {'calendarDate': '2026-10-07', 'timestampLocal': '2026-10-07T20:00:00', 'score': 50, 'recoveryTime': 60, 'acuteLoad': 90},
            {'calendarDate': '2026-10-08', 'timestampLocal': '2026-10-08T07:00:00', 'score': 70, 'recoveryTime': 0, 'acuteLoad': 100},
        ]),
    }}
    catalog = visualization_catalog(history, END)
    assert point(catalog, 'hrv', '2026-10-06')['value'] == 55
    assert point(catalog, 'hrv')['status'] == 'missing'
    assert point(catalog, 'sleep_hours', '2026-10-07')['value'] == 7
    assert point(catalog, 'sleep_hours')['value'] is None
    assert point(catalog, 'readiness', '2026-10-07')['value'] == 50
    assert point(catalog, 'readiness')['value'] == 70
    assert point(catalog, 'recovery_hours')['value'] == 0
    assert point(catalog, 'acute_load')['value'] == 100
    assert point(catalog, 'readiness', '2026-10-07')['source_at'] == '2026-10-07T20:00:00+08:00'
    assert point(catalog, 'readiness')['fetched_at'] == FETCHED
    assert point(catalog, 'hrv', '2026-10-06')['source_at'] is None


def test_failed_fetch_keeps_old_cached_day_and_marks_requested_day_error_gap():
    catalog = visualization_catalog({'2026-10-08': {
        'hrv': record({'hrvSummary': {'calendarDate': '2026-10-07', 'lastNightAvg': 51}}, day='2026-10-07', status='error'),
        'sleep': record({'dailySleepDTO': {'calendarDate': None, 'sleepTimeSeconds': 28800}}),
    }}, END)
    assert point(catalog, 'hrv', '2026-10-07')['value'] == 51
    assert point(catalog, 'hrv', '2026-10-07')['status'] == 'error'
    assert point(catalog, 'hrv')['value'] is None
    assert point(catalog, 'hrv')['status'] == 'error'
    assert point(catalog, 'sleep_hours')['value'] is None
    assert point(catalog, 'sleep_hours')['status'] == 'missing'


@pytest.mark.parametrize('visuals', [
    [{'kind': 'trend', 'title': '趋势', 'metrics': ['hrv'], 'points': [{'value': 999}]}],
    [{'kind': 'trend', 'title': '趋势', 'metrics': ['hrv', 'hrv']}],
    [{'kind': 'trend', 'title': '趋势', 'metrics': ['hrv']}, {'kind': 'table', 'title': '比较', 'metrics': ['hrv']}],
    [{'kind': 'trend', 'title': '趋势', 'metrics': ['invented']}],
    [{'kind': 'trend', 'title': '趋势', 'metrics': []}],
])
def test_model_cannot_forge_numeric_payload_or_duplicate_metric(visuals):
    with pytest.raises(ValidationError):
        reply(visuals=visuals)


def test_visual_titles_count_toward_total_reply_limit():
    with pytest.raises(ValidationError):
        reply(summary='字' * 400, sections=[{'title': '标题', 'items': ['字' * 1200, '字' * 950]}], visuals=[{'kind': 'trend', 'title': '字' * 60, 'metrics': ['hrv']}])


def test_resolved_snapshot_survives_live_catalog_and_store_changes(tmp_path):
    store = Store(tmp_path / 'visuals.sqlite')
    catalog = visualization_catalog({'2026-10-08': {'stats': record({'totalSteps': 1234})}}, END)
    selections = reply(visuals=[{'kind': 'table', 'title': '步数', 'metrics': ['steps']}]).visuals
    snapshots = resolve_visuals(selections, catalog, END)
    store.message('assistant', '查看真实步数。', visuals=snapshots)
    point(catalog, 'steps')['value'] = 9999
    snapshots[0]['series'][0]['points'][-1]['value'] = 8888
    store.put('garmin_health_raw', {'2026-10-08': {'stats': record({'totalSteps': 7777})}})
    saved = store.get('messages')[0]
    assert saved['visuals'][0]['series'][0]['points'][-1]['value'] == 1234
    assert saved['visuals'][0]['source'] == 'garmin'
    store.message('assistant', '旧式纯文本回复。')
    assert 'visuals' not in store.get('messages')[1]
    missing = resolve_visuals(selections, {}, END)[0]['series'][0]
    assert all(p['value'] is None and p['status'] == 'missing' for p in missing['points'])


def test_refresh_final_inference_and_saved_message_use_same_snapshot(tmp_path, monkeypatch):
    service = CoachService.__new__(CoachService)
    service.store = Store(tmp_path / 'visuals.sqlite')
    service.coach_status = {'busy': True}
    service.sync_running = False
    initial = visualization_catalog({'2026-10-08': {'stats': record({'totalSteps': 1})}}, END)
    refreshed = visualization_catalog({'2026-10-08': {'stats': record({'totalSteps': 222})}}, END)
    context = {'today': END.isoformat(), 'health': empty_health(), 'plan': empty_plan(), 'fresh_metrics': {}, 'garmin_context': {}, 'visualization_catalog': initial}
    service.coaching_context = lambda: deepcopy(context)

    async def no_op():
        return None

    service.sync_data = no_op
    service.refresh_status = no_op
    service.data_tool = lambda request: {**context, 'visualization_catalog': deepcopy(refreshed)}
    calls = []

    def infer(path, payload):
        calls.append(deepcopy(payload['context']))
        if len(calls) == 1:
            result = reply(tool_requests=[{'action': 'refresh_data'}])
        else:
            assert point(payload['context']['visualization_catalog'], 'steps')['value'] == 222
            # A later live value must not leak into the selected reply snapshot.
            service.store.put('garmin_health_raw', {'2026-10-08': {'stats': record({'totalSteps': 999})}})
            result = reply(visuals=[{'kind': 'trend', 'title': '每日步数', 'metrics': ['steps']}])
        return {'text': result.model_dump_json()}

    monkeypatch.setattr(client, 'request', infer)
    asyncio.run(service.coach_turn())
    assert len(calls) == 2
    saved = service.state()['messages'][-1]
    assert saved['visuals'][0]['series'][0]['points'][-1]['value'] == 222
    assert service.coach_status['error'] is None


def test_all_catalog_units_and_measurement_provenance_follow_garmin_fields():
    catalog = visualization_catalog({'2026-10-08': {
        'heart': record({'restingHeartRate': 52, 'calendarDate': '2026-10-08'}),
        'sleep': record({'dailySleepDTO': {'calendarDate': '2026-10-08', 'sleepTimeSeconds': 27000, 'sleepScores': {'overall': {'value': 88}}}}),
        'hrv': record({'hrvSummary': {'calendarDate': '2026-10-08', 'lastNightAvg': 59}}),
        'readiness': record([{'timestampLocal': '2026-10-08T08:00:00', 'score': 81, 'recoveryTime': 90, 'acuteLoad': 110}]),
        'stress': record({'avgStressLevel': 23}),
        'respiration': record({'avgWakingRespirationValue': 15}),
        'spo2': record({'averageSpO2': 97}),
        'stats': record({'totalSteps': 3000, 'bodyBatteryHighestValue': 95}),
    }}, END)
    expected = {'resting_hr': 52, 'sleep_hours': 7.5, 'sleep_score': 88, 'hrv': 59, 'readiness': 81, 'recovery_hours': 1.5, 'stress': 23, 'acute_load': 110, 'respiration': 15, 'spo2': 97, 'steps': 3000, 'body_battery_peak': 95}
    assert {key: point(catalog, key)['value'] for key in catalog} == expected
    assert catalog['sleep_hours']['unit'] == '小时'
    assert catalog['hrv']['unit'] == 'ms'
    assert catalog['resting_hr']['unit'] == 'bpm'
    assert all(point(catalog, key)['fetched_at'] == FETCHED for key in catalog)
