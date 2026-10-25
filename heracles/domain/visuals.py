"""Bounded, measurement-dated Garmin series and immutable reply snapshots."""
from copy import deepcopy
from datetime import date, timedelta
from math import isfinite

from heracles.integrations.garmin import METRICS, number, source_time
from heracles.integrations.garmin_structured import source_date

# Extraction follows Garmin normalize; daily peak is deliberately not current battery.
FIELDS = {
    'resting_hr': ('heart', 'restingHeartRate'),
    'sleep_hours': ('sleep', 'sleepTimeSeconds'),
    'sleep_score': ('sleep', 'sleepScores'),
    'hrv': ('hrv', 'lastNightAvg'),
    'readiness': ('readiness', 'score'),
    'recovery_hours': ('readiness', 'recoveryTime'),
    'stress': ('stress', 'avgStressLevel'),
    'acute_load': ('readiness', 'acuteLoad'),
    'respiration': ('respiration', 'avgWakingRespirationValue'),
    'spo2': ('spo2', 'averageSpO2'),
    'steps': ('stats', 'totalSteps'),
    'body_battery_peak': ('stats', 'bodyBatteryHighestValue'),
}
LABELS = {key: (label, unit) for key, label, unit in METRICS}
LABELS['body_battery_peak'] = ('每日身体电量峰值', '/100')
DESCRIPTIONS = {
    'resting_hr': '每日静息心率统计，不是即时心率。',
    'sleep_hours': '佳明睡眠记录时长，按睡眠记录日期展示。',
    'sleep_score': '佳明睡眠评分，按睡眠记录日期展示。',
    'hrv': '上一晚平均 HRV，按设备记录日期展示；单次值不能诊断恢复状态。',
    'readiness': '当天最近一次佳明训练准备度测量。',
    'recovery_hours': '当天最近一次恢复时间，分钟换算小时；不是必须静止的时间。',
    'stress': '每日平均压力。',
    'acute_load': '当天最近一次训练准备度记录中的急性训练负荷。',
    'respiration': '每日平均清醒呼吸率。',
    'spo2': '每日平均血氧，不用于医疗诊断。',
    'steps': '每日累计步数。',
    'body_battery_peak': '每日统计中的最高身体电量，不是当前身体电量。',
}


def empty_series(key, dates):
    label, unit = LABELS[key]
    return {'key': key, 'label': label, 'unit': unit, 'description': DESCRIPTIONS[key],
            'points': [{'date': day, 'value': None, 'status': 'missing', 'source_at': None, 'fetched_at': None} for day in dates]}


def measurement_day(payload, record, source_at):
    # Explicit device dates take precedence, including an explicitly null/invalid date.
    if 'calendarDate' in payload:
        return source_date(payload['calendarDate'])
    return source_date(source_at) or source_date(record.get('data_date') or record.get('date'))


def visualization_catalog(history, end: date):
    dates = [(end - timedelta(days=offset)).isoformat() for offset in range(7, -1, -1)]
    catalog = {key: empty_series(key, dates) for key in FIELDS}
    indexes = {key: {point['date']: point for point in series['points']} for key, series in catalog.items()}
    ranks = {}
    for requested_day, records in sorted(history.items()):
        for key, (source, field) in FIELDS.items():
            record = records.get(source)
            # Daily stats also provide resting HR when heart data is absent.
            if key == 'resting_hr' and number(((record or {}).get('data') or {}).get(field)) is None:
                stats = records.get('stats') or {}
                if number((stats.get('data') or {}).get(field)) is not None:
                    record = stats
                    source = 'stats'
            if not record:
                continue
            data = record.get('data')
            rows = data if source == 'readiness' and isinstance(data, list) else [data]
            for row in rows or [None]:
                payload = row if isinstance(row, dict) else {}
                if source == 'sleep':
                    payload = payload.get('dailySleepDTO') or {}
                elif source == 'hrv':
                    payload = payload.get('hrvSummary') or {}
                source_at = source_time(source, row)
                if source != 'readiness':
                    source_at = source_at or record.get('source_at')
                day = source_date(source_at) if source == 'readiness' and source_at else measurement_day(payload, record, source_at)
                value = payload.get(field)
                if key == 'sleep_score':
                    value = ((value or {}).get('overall') or {}).get('value')
                value = number(value)
                value = value if value is not None and isfinite(value) else None
                if value is not None and key == 'sleep_hours':
                    value = round(value / 3600, 2)
                elif value is not None and key == 'recovery_hours':
                    value = round(value / 60, 1)
                status = 'error' if record.get('status') == 'error' else 'available' if value is not None and day else 'missing'
                # An unsuccessful current-day fetch with old cached data also leaves an
                # explicit error gap today; it never repeats yesterday's value today.
                if status == 'error' and requested_day in dates and day != requested_day:
                    point = indexes[key][requested_day]
                    if point['status'] == 'missing':
                        point.update(status='error', fetched_at=record.get('fetched_at'))
                if day not in dates:
                    if requested_day in dates and day is None:
                        indexes[key][requested_day].update(status=status, fetched_at=record.get('fetched_at'))
                    continue
                rank = ((source_at or '') if source == 'readiness' else '', record.get('attempted_at') or record.get('fetched_at') or '')
                if (key, day) not in ranks or rank >= ranks[key, day]:
                    ranks[key, day] = rank
                    indexes[key][day].update(value=value, status=status, source_at=source_at, fetched_at=record.get('fetched_at'))
    return catalog


def resolve_visuals(selections, catalog, end: date):
    dates = [(end - timedelta(days=offset)).isoformat() for offset in range(7, -1, -1)]
    resolved = []
    for selection in selections:
        series = []
        for key in selection.metrics:
            if key not in FIELDS:
                raise ValueError('未知身体指标')
            series.append(deepcopy(catalog.get(key) or empty_series(key, dates)))
        resolved.append({'kind': selection.kind, 'title': selection.title, 'source': 'garmin', 'series': series})
    return resolved
