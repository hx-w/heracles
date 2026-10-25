from copy import deepcopy

from heracles.integrations.garmin import GarminData, empty_plan, number, safe_error, timestamp
from heracles.integrations.garmin_structured import fetch_record, native_inventory, private_summary, sync_plan
from heracles.storage import Store


UUID = '713a2c0a-4db1-47aa-a5af-5990fb8a9a24'
AT = '2026-10-08T12:00:00+08:00'


def plan_row(identifier='1', category='FBT_ADAPTIVE'):
    return {'trainingPlanId': identifier, 'trainingPlanCategory': category, 'trainingStatus': {'statusKey': 'Scheduled'}, 'trainingType': {'typeKey': 'Running'}, 'name': 'Actual Garmin plan'}


def task(workout_id=None, uuid=None, rest=False, duration=None, status='NOT_COMPLETE'):
    return {'calendarDate': '2026-10-08', 'taskWorkout': {'workoutId': workout_id, 'workoutUuid': uuid, 'sportType': {'sportTypeKey': 'running'}, 'workoutName': 'Actual prescription', 'workoutDescription': '151bpm', 'estimatedDurationInSecs': duration, 'restDay': rest, 'adaptiveCoachingWorkoutStatus': status}}


class PlanClient:
    def __init__(self):
        self.rows = [plan_row()]
        self.detail = {'taskList': [task(uuid=UUID), task(workout_id=9, duration=0), task(rest=True)], 'adaptivePlanPhases': [{'startDate': '2026-10-01', 'endDate': '2026-10-18', 'trainingPhase': 'BASE', 'currentPhase': True}]}
        self.calls = []
        self.fail_list = False
        self.fail_detail = set()
        self.fail_course = False

    def get_training_plans(self):
        if self.fail_list:
            raise ConnectionError('must not leak identifiers')
        return {'trainingPlanList': self.rows}

    def get_adaptive_training_plan_by_id(self, identifier):
        self.calls.append(('adaptive', identifier))
        if identifier in self.fail_detail:
            raise ConnectionError('private token')
        return deepcopy(self.detail)

    def get_training_plan_by_id(self, identifier):
        self.calls.append(('phased', identifier))
        return {'taskList': [task(workout_id=19)]}

    def connectapi(self, endpoint):
        self.calls.append(('uuid', endpoint))
        if self.fail_course:
            raise ConnectionError('private request')
        return {'estimatedDurationInSecs': None, 'workoutSegments': [{'workoutSteps': [{'type': 'RepeatGroupDTO', 'numberOfIterations': 3, 'workoutSteps': [{'exerciseName': 'SQUAT_THRUSTS', 'category': 'TOTAL_BODY', 'targetType': {'workoutTargetTypeKey': 'heart.rate.zone'}, 'targetValueOne': 137, 'targetValueTwo': 164, 'targetValueUnit': None}]}]}]}

    def get_workout_by_id(self, identifier):
        self.calls.append(('numeric', identifier))
        return {'estimatedDurationInSecs': 0, 'workoutSegments': [{'workoutSteps': [{'endConditionValue': None, 'targetValueOne': None, 'targetValueTwo': None}]}]}


def synchronize(client, old=None, cache=None):
    return sync_plan(client, old or empty_plan(), cache if cache is not None else {}, AT, safe_error, number, empty_plan)


def test_real_category_uuid_numeric_and_multiple_tasks_are_preserved():
    client = PlanClient()
    client.rows.append(plan_row('2', 'PHASED'))
    result = synchronize(client)
    assert ('adaptive', '1') in client.calls
    assert ('phased', '2') in client.calls
    assert ('uuid', '/workout-service/fbt-adaptive/' + UUID) in client.calls
    assert ('numeric', '9') in client.calls
    assert len(result['workouts']) == 4
    assert {w['date'] for w in result['workouts']} == {'2026-10-08'}
    course = next(w for w in result['workouts'] if w['id'] == UUID)
    assert course['duration_seconds'] is None
    assert course['description'] == '151bpm'
    assert course['steps'][0]['numberOfIterations'] == 3
    assert course['steps'][0]['workoutSteps'][0]['targetValueTwo'] == 164
    assert course['steps'][0]['workoutSteps'][0]['targetValueUnit'] is None
    assert next(w for w in result['workouts'] if w['id'] == '9')['duration_seconds'] == 0
    rest = next(w for w in result['workouts'] if w['rest_day'])
    assert rest['kind'] == 'rest' and rest['detail_status'] == 'not_applicable'
    assert rest['duration_seconds'] is None
    assert result['phases'][0]['current'] is True


def test_plan_list_failure_retains_only_previous_garmin_snapshot():
    client = PlanClient()
    old = synchronize(client)
    client.fail_list = True
    retained = synchronize(client, old)
    assert retained['status'] == 'error'
    assert retained['workouts'] == old['workouts']
    assert retained['fetched_at'] == old['fetched_at']
    legacy = synchronize(client, {'source': 'coach', 'workouts': [{'title': 'generated'}]})
    assert legacy['workouts'] == []
    assert 'private' not in legacy['sync_error']


def test_partial_plan_detail_failure_retains_that_plan_and_refreshes_others():
    client = PlanClient()
    old = synchronize(client)
    client.rows.append(plan_row('2', 'PHASED'))
    client.fail_detail.add('1')
    result = synchronize(client, old)
    assert result['status'] == 'error'
    assert [w for w in result['workouts'] if w['plan_id'] == '1'] == old['workouts']
    assert next(w for w in result['workouts'] if w['plan_id'] == '2')['id'] == '19'


def test_course_failure_keeps_cached_steps_and_explicit_error():
    client, cache = PlanClient(), {}
    old = synchronize(client, cache=cache)
    client.fail_course = True
    result = synchronize(client, old, cache)
    course = next(w for w in result['workouts'] if w['id'] == UUID)
    assert course['detail_status'] == 'error'
    assert course['steps'] == next(w for w in old['workouts'] if w['id'] == UUID)['steps']
    assert course['detail_error'] and 'private' not in course['detail_error']


def test_empty_list_clears_garmin_plan_without_generated_rest():
    client = PlanClient()
    old = synchronize(client)
    client.rows = []
    result = synchronize(client, old)
    assert result['status'] == 'missing'
    assert result['workouts'] == result['phases'] == []


def test_failed_source_retains_values_and_measurement_fetch_error_times():
    previous = {'data': {'value': 0}, 'fetched_at': '2026-10-07T12:00:00+08:00', 'source_at': '2026-10-07T10:00:00+08:00'}
    def failed():
        raise RuntimeError('password=secret')
    result = fetch_record(failed, previous, 'real endpoint', AT, safe_error)
    assert result['data']['value'] == 0
    assert result['fetched_at'] == previous['fetched_at']
    assert result['source_at'] == previous['source_at']
    assert result['error_at'] == AT and result['status'] == 'error'
    assert 'secret' not in result['error']


def test_native_recording_inventory_never_assumes_one_second_or_chart_raw():
    messages = []
    for second, hr in [(0, 120), (3, None), (8, 150)]:
        messages.append({'type': 'record', 'fields': [{'name': 'timestamp', 'value': f'2026-10-08T00:00:0{second}+00:00', 'units': None}, {'name': 'heart_rate', 'value': hr, 'units': 'bpm'}, {'name': 'position_lat', 'value': 1234, 'units': 'semicircles'}]})
    result = native_inventory({'messages': messages})
    assert result['record_count'] == 3
    assert result['median_interval_seconds'] == 4
    assert result['record_statistics']['heart_rate']['count'] == 2
    assert result['record_statistics']['heart_rate']['sample_mean'] == 135
    assert 'position_lat' not in result['units']
    assert result['recording_quarters']


def test_health_details_scope_date_source_and_keep_nulls(tmp_path):
    store = Store(tmp_path / 'private.sqlite')
    store.put('garmin_health_raw', {'2026-10-07': {'sleep': {'data': {'dailySleepDTO': {'sleepTimeSeconds': None}}, 'status': 'available', 'fetched_at': AT, 'source_at': None, 'error': None}}, '2026-10-08': {'heart': {'data': {'restingHeartRate': 0}, 'status': 'available', 'fetched_at': AT, 'source_at': None, 'error': None}}})
    data = GarminData(store)
    data.client = object()
    result = data.health_details('2026-10-07', 'sleep')
    assert set(result['sources']) == {'sleep'}
    assert result['sources']['sleep']['data']['dailySleepDTO']['sleepTimeSeconds'] is None
    assert 'heart' not in result['sources']


def test_private_coach_context_omits_identity_and_locations_but_detail_can_query_location():
    payload = {'ownerId': 5, 'userProfilePK': 6, 'startLatitude': 7, 'fields': [{'name': 'serial_number', 'value': 99}, {'name': 'position_lat', 'value': 1}, {'name': 'heart_rate', 'value': 130}]}
    result = private_summary(payload)
    assert 'ownerId' not in result and 'userProfilePK' not in result and 'startLatitude' not in result
    assert result['fields'] == [{'name': 'heart_rate', 'value': 130}]
    assert private_summary(payload, keep_locations=True)['startLatitude'] == 7


def test_older_own_activity_uses_profile_id_not_absent_owner_display_name(tmp_path):
    class ActivityClient:
        display_name = 'private-account'

        def connectapi(self, endpoint):
            assert endpoint == '/userprofile-service/socialProfile'
            return {'profileId': 42}

        def get_activity(self, identifier):
            # Real get_activity differs from get_activities: userProfileId, summaryDTO,
            # no ownerDisplayName. Requiring the latter blocks all older own activities.
            return {'activityId': int(identifier), 'userProfileId': 42, 'summaryDTO': {'averageHR': 130}}

        def get_activity_splits(self, identifier):
            return {'lapDTOs': [{'distance': None, 'duration': None, 'averageHR': None}]}

        def download_activity(self, *args):
            raise ConnectionError('private native request')

        def __getattr__(self, method):
            assert method.startswith('get_activity_')
            return lambda identifier: {}

    data = GarminData(Store(tmp_path / 'private.sqlite'))
    data.client = ActivityClient()
    result = data.activity_details('123')
    assert result['details_available'] is True
    assert result['summary']['summaryDTO']['averageHR'] == 130
    assert 'userProfileId' not in result['summary']
    assert result['laps'][0]['distance_km'] is None
    assert result['laps'][0]['duration_minutes'] is None
    assert result['native']['status'] == 'error'
    assert 'private' not in result['native']['error']


def test_foreign_activity_never_fetches_streams_or_native_export(tmp_path):
    class ForeignClient:
        display_name = 'private-account'

        def connectapi(self, endpoint):
            return {'profileId': 42}

        def get_activity(self, identifier):
            return {'userProfileId': 99, 'activityName': 'not this account'}

    data = GarminData(Store(tmp_path / 'private.sqlite'))
    data.client = ForeignClient()
    result = data.activity_details('999')
    assert result['details_available'] is False
    assert result['sources'] == {}
    assert 'summary' not in result


def test_context_uses_recent_real_sleep_without_copying_health_series(tmp_path, monkeypatch):
    from datetime import date
    monkeypatch.setattr('heracles.integrations.garmin.today', lambda: date(2026, 10, 8))
    store = Store(tmp_path / 'private.sqlite')
    store.put('garmin_health_raw', {
        '2026-10-07': {'sleep': {'data': {'dailySleepDTO': {'calendarDate': '2026-10-07', 'sleepTimeSeconds': 25000}}, 'data_date': '2026-10-07', 'status': 'available'}},
        '2026-10-08': {'sleep': {'data': {'dailySleepDTO': {'sleepTimeSeconds': None}}, 'status': 'missing'}, 'heart': {'data': {'heartRateValues': [[1791207000000, 120], [1791207010000, 121]], 'restingHeartRate': 50, 'userProfilePK': 42}, 'status': 'available'}},
    })
    context = GarminData(store).coach_context()
    assert context['nearest_available_sleep']['date'] == '2026-10-07'
    assert context['current_body']['heart']['summary']['restingHeartRate'] == 50
    assert 'heartRateValues' not in context['current_body']['heart']['summary']
    assert context['current_body']['heart']['streams'][0]['count'] == 2
    assert 'userProfilePK' not in context['current_body']['heart']['summary']




def test_empty_detail_response_is_not_an_authoritative_empty_plan():
    client, cache = PlanClient(), {}
    old = synchronize(client, cache=cache)
    client.detail = None
    result = synchronize(client, old, cache)
    assert result['status'] == 'error'
    assert result['workouts'] == old['workouts']
    assert cache['details']['1']['previous_data']['taskList']


def test_native_fit_date_and_time_fields_survive_json_storage():
    import json
    from datetime import date, datetime, time, timezone
    from heracles.integrations.garmin_structured import json_native

    fields = [
        {'name': 'time_of_day', 'value': json_native(time(6, 30, 45))},
        {'name': 'date', 'value': json_native(date(2026, 10, 8))},
        {'name': 'timestamp', 'value': json_native(datetime(2026, 10, 8, 6, 30, 45, tzinfo=timezone.utc))},
    ]
    stored = json.loads(json.dumps(fields))
    assert [field['value'] for field in stored] == ['06:30:45', '2026-10-08', '2026-10-08T06:30:45+00:00']
