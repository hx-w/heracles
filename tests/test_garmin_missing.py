from heracles.integrations.garmin import normalize


def test_midnight_null_battery_is_missing_without_dropping_other_metrics():
    raw = {
        'battery': {'data': [{
            'bodyBatteryValueDescriptorDTOList': None,
            'bodyBatteryValuesArray': None,
        }]},
        'heart': {'data': {'restingHeartRate': 52}},
    }
    metrics = {metric['key']: metric for metric in normalize(raw, [])}
    assert metrics['body_battery']['value'] is None
    assert metrics['body_battery']['status'] == 'missing'
    assert metrics['resting_hr']['value'] == 52


def test_samples_without_descriptors_keep_two_column_battery_value():
    raw = {'battery': {'data': [{
        'bodyBatteryValueDescriptorDTOList': None,
        'bodyBatteryValuesArray': [[1791207000000, 24]],
    }]}}
    metrics = {metric['key']: metric for metric in normalize(raw, [])}
    assert metrics['body_battery']['value'] == 24
    assert metrics['body_battery']['status'] == 'available'


def test_explicit_zero_remains_zero_but_null_sleep_fields_remain_missing():
    raw = {
        'battery': {'data': [{'bodyBatteryValuesArray': [[1791207000000, 0]]}]},
        'sleep': {'data': {'dailySleepDTO': {'sleepTimeSeconds': None, 'sleepScores': None}}},
        'training': {'data': {'mostRecentVO2Max': None}},
        'hrv': {'data': {'hrvSummary': None}},
        'respiration': {'data': {'avgWakingRespirationValue': 0}},
        'spo2': {'data': {'averageSpO2': None}},
    }
    metrics = {metric['key']: metric for metric in normalize(raw, [])}
    assert metrics['body_battery']['value'] == 0
    assert metrics['respiration']['value'] == 0
    assert metrics['sleep_hours']['value'] is None
    assert metrics['sleep_score']['value'] is None
    assert metrics['vo2max']['status'] == 'missing'
    assert metrics['spo2']['status'] == 'missing'


def test_failed_threshold_retains_real_value_but_not_available_status():
    raw = {'threshold': {'data': {'speed_and_heart_rate': {'heartRate': 168}}, 'fetched_at': '2026-10-07T12:00:00+08:00'}}
    metrics = {metric['key']: metric for metric in normalize(raw, [{'key': 'threshold', 'status': 'error'}])}
    assert metrics['lactate_hr']['value'] == 168
    assert metrics['lactate_hr']['status'] == 'error'
    assert metrics['lactate_hr']['fetched_at'] == '2026-10-07T12:00:00+08:00'
