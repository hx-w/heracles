"""Garmin read-only payload handling. Raw data remains separate from coach summaries."""
import base64
import hashlib
import io
import zipfile
from copy import deepcopy
from datetime import date, datetime, time
from statistics import median
from uuid import UUID

import fitdecode


ACTIVE_STATUSES = {'scheduled', 'inprogress'}
IDENTITY_KEYS = {'ownerId', 'ownerDisplayName', 'ownerFullName', 'ownerProfileImageUrlSmall', 'ownerProfileImageUrlMedium', 'ownerProfileImageUrlLarge', 'userProfilePK', 'userProfileId', 'userId', 'displayName', 'fullName', 'firstName', 'lastName', 'email', 'author', 'sharedWithUsers', 'userRoles', 'deviceId', 'serialNumber'}


def key_value(value, *keys):
    if isinstance(value, dict):
        return next((value[k] for k in keys if value.get(k) is not None), '')
    return value if value is not None else ''


def source_date(value):
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10]).isoformat()
    except ValueError:
        return None


def sport_kind(sport):
    sport = str(sport or '').lower()
    if 'running' in sport or sport in {'run', 'trail_run'}:
        return 'running'
    if 'cycling' in sport or sport in {'biking', 'bike', 'virtual_ride'}:
        return 'cycling'
    if 'strength' in sport or sport in {'fitness_equipment', 'weight_training'}:
        return 'strength'
    return 'other'


def workout_steps(payload):
    return [step for segment in payload.get('workoutSegments') or [] for step in segment.get('workoutSteps') or []] or payload.get('workoutSteps') or []


def workout_status(value):
    key = str(key_value(value, 'statusKey', 'workoutStatusKey')).upper().replace('_', '')
    if key in {'COMPLETE', 'COMPLETED'}:
        return 'completed'
    if key in {'SKIPPED', 'SKIP'}:
        return 'skipped'
    if key in {'NOTCOMPLETE', 'PLANNED', 'SCHEDULED', 'INPROGRESS'}:
        return 'planned'
    return 'unknown'


def fetch_workout(client, workout_id):
    if str(workout_id).isdigit() and int(workout_id) > 0:
        return client.get_workout_by_id(str(workout_id)), '/workout-service/workout/' + str(workout_id)
    identifier = str(UUID(str(workout_id)))
    # Public live-derived schema: github.com/gordcurrie/waypoint/pull/98.
    # Verified against Garmin China; unlike the numeric workout endpoint this resolves Coach UUIDs.
    endpoint = '/workout-service/fbt-adaptive/' + identifier
    return client.connectapi(endpoint), endpoint


def fetch_record(call, previous, endpoint, at, safe_error, source_at=None, day=None):
    record = deepcopy(previous or {})
    record.update(endpoint=endpoint, attempted_at=at, error_at=None, error=None)
    if day is not None:
        record['requested_date'] = day
    try:
        payload = call()
        record.update(data=payload, fetched_at=at, source_at=source_at(payload) if source_at else None, status='available' if payload else 'missing')
        if day is not None:
            record['data_date'] = day
    except Exception as exc:
        record.update(status='error', error=safe_error(exc), error_at=at)
    return record


def sync_plan(client, old, cache, at, safe_error, number, empty_plan):
    old = old if isinstance(old, dict) and old.get('source') == 'garmin' else empty_plan()
    prior_listing = cache.get('list')
    listing = fetch_record(client.get_training_plans, prior_listing, '/trainingplan-service/trainingplan/plans', at, safe_error)
    cache['list'] = listing
    invalid_list = listing.get('data') is None or (isinstance(listing.get('data'), dict) and not isinstance(listing['data'].get('trainingPlanList'), list))
    if listing['status'] == 'error' or invalid_list:
        if invalid_list and prior_listing and prior_listing.get('data'):
            listing['previous_data'] = deepcopy(prior_listing['data'])
        retained = deepcopy(old)
        retained.update(status='error', sync_error=listing.get('error') or '佳明未返回可确认的计划列表；保留上次佳明计划')
        return retained
    rows = listing.get('data') or {}
    rows = rows.get('trainingPlanList') or [] if isinstance(rows, dict) else rows
    result = empty_plan()
    result['fetched_at'] = at
    errors = []
    details = cache.setdefault('details', {})
    courses = cache.setdefault('workouts', {})
    for row in rows:
        identifier = str(row.get('trainingPlanId') or row.get('id') or '')
        category = str(row.get('trainingPlanCategory') or '')
        status = str(key_value(row.get('trainingStatus'), 'statusKey'))
        sport = str(key_value(row.get('trainingType') or row.get('sportType'), 'typeKey', 'sportTypeKey'))
        metadata = {'id': identifier, 'name': row.get('name') or '', 'category': category, 'status': status, 'sport': sport, 'start_date': source_date(row.get('startDate')), 'end_date': source_date(row.get('endDate'))}
        result['plans'].append(metadata)
        if status.lower().replace('_', '') not in ACTIVE_STATUSES:
            continue
        adaptive = category.upper() == 'FBT_ADAPTIVE'
        endpoint = '/trainingplan-service/trainingplan/' + ('fbt-adaptive/' if adaptive else 'phased/') + identifier
        call = (lambda identifier=identifier: client.get_adaptive_training_plan_by_id(identifier)) if adaptive else (lambda identifier=identifier: client.get_training_plan_by_id(identifier))
        prior_detail = details.get(identifier)
        detail = fetch_record(call, prior_detail, endpoint, at, safe_error)
        if detail['status'] == 'missing' and prior_detail and prior_detail.get('data'):
            detail['previous_data'] = deepcopy(prior_detail['data'])
        details[identifier] = detail
        if detail['status'] in {'error', 'missing'}:
            errors.append(detail.get('error') or '佳明未返回活动计划的详情')
            result['phases'].extend(deepcopy([p for p in old.get('phases', []) if p.get('plan_id') == identifier]))
            result['workouts'].extend(deepcopy([w for w in old.get('workouts', []) if w.get('plan_id') == identifier]))
            continue
        data = detail.get('data') or {}
        phases = data.get('adaptivePlanPhases') or data.get('planPhases') or []
        for phase in phases:
            result['phases'].append({'plan_id': identifier, 'start_date': source_date(phase.get('startDate')), 'end_date': source_date(phase.get('endDate')), 'training_phase': str(key_value(phase.get('trainingPhase'), 'phaseKey')), 'current': bool(phase.get('currentPhase'))})
        for index, task in enumerate(data.get('taskList') or []):
            w = task.get('taskWorkout') or {}
            day = source_date(task.get('calendarDate') or w.get('scheduledDate'))
            if day is None:
                continue
            rest = w.get('restDay') is True
            source_id = w.get('workoutId') if w.get('workoutId') is not None else w.get('workoutUuid')
            course_id = str(source_id) if source_id else f'garmin:{identifier}:{day}:{task.get("workoutOrder", index)}:{index}'
            course_sport = key_value(w.get('sportType'), 'sportTypeKey', 'typeKey') or sport or None
            raw_status = key_value(w.get('adaptiveCoachingWorkoutStatus') or w.get('workoutStatus'), 'statusKey') or None
            normalized = {'id': course_id, 'plan_id': identifier, 'date': day, 'title': w.get('workoutName') or ('休息' if rest else '佳明训练'), 'kind': 'rest' if rest else sport_kind(course_sport), 'sport': course_sport, 'duration_seconds': number(w.get('estimatedDurationInSecs')), 'description': w.get('workoutDescription'), 'status': workout_status(raw_status), 'garmin_status': raw_status, 'training_effect': w.get('trainingEffectLabel'), 'priority': w.get('priorityType'), 'rest_day': rest, 'detail_status': 'not_applicable' if rest else 'summary', 'detail_error': None, 'steps': []}
            if not rest and source_id:
                prior = courses.get(course_id)
                record = fetch_record(lambda source_id=source_id: fetch_workout(client, source_id)[0], prior, ('/workout-service/workout/' if str(source_id).isdigit() else '/workout-service/fbt-adaptive/') + str(source_id), at, safe_error)
                if record['status'] == 'missing' and prior and prior.get('data'):
                    record.update(data=deepcopy(prior['data']), latest_response=None, fetched_at=prior.get('fetched_at'), source_at=prior.get('source_at'), status='error', error='佳明未返回课程详情；保留上次真实步骤', error_at=at)
                courses[course_id] = record
                payload = record.get('data') or {}
                steps = workout_steps(payload)
                normalized['steps'] = deepcopy(steps)
                normalized['duration_seconds'] = number(payload.get('estimatedDurationInSecs')) if payload.get('estimatedDurationInSecs') is not None else normalized['duration_seconds']
                normalized['detail_status'] = 'error' if record['status'] == 'error' else 'available' if steps else 'summary'
                normalized['detail_error'] = record['error']
                if record['status'] == 'error':
                    errors.append(record['error'])
                if not steps and record['status'] != 'error':
                    normalized['detail_error'] = '佳明返回了课程摘要，但未提供训练步骤'
            result['workouts'].append(normalized)
    active_names = [p['name'] for p in result['plans'] if p['status'].lower().replace('_', '') in ACTIVE_STATUSES and p['name']]
    result['name'] = ' / '.join(active_names) or None
    result['workouts'].sort(key=lambda w: (w['date'], w['plan_id']))
    result['status'] = 'error' if errors else 'available' if active_names or result['workouts'] or result['phases'] else 'missing'
    result['sync_error'] = '部分佳明计划或课程接口暂不可用；保留已获取的佳明记录' if errors else None
    comparable = {k: v for k, v in result.items() if k not in {'fetched_at', 'updated_at', 'status', 'sync_error'}}
    previous = {k: v for k, v in old.items() if k not in {'fetched_at', 'updated_at', 'status', 'sync_error'}}
    result['updated_at'] = old.get('updated_at') if comparable == previous else at
    if result['updated_at'] is None and result['status'] == 'available':
        result['updated_at'] = at
    return result


def private_summary(value, keep_locations=False):
    """Omit account/device identity; automatic coach context also omits location."""
    def private_key(key):
        lowered = key.lower()
        return key in IDENTITY_KEYS or lowered.startswith(('ownerprofile', 'userprofile')) or lowered in {'serial_number', 'manufacturer', 'device_index', 'device_info', 'local_device_type'}

    def location_key(key):
        return any(term in key.lower() for term in ('latitude', 'longitude', 'position_lat', 'position_long', 'polyline', 'coordinates'))

    if isinstance(value, dict):
        return {k: private_summary(v, keep_locations) for k, v in value.items() if not private_key(k) and (keep_locations or not location_key(k))}
    if isinstance(value, list):
        return [private_summary(v, keep_locations) for v in value if not (isinstance(v, dict) and isinstance(v.get('name'), str) and (private_key(v['name']) or (not keep_locations and location_key(v['name']))))]
    return value


def compact(value):
    """Keep actual summary/factor objects; high-volume series are available via detail tools."""
    if isinstance(value, dict):
        return {k: compact(v) for k, v in private_summary(value).items() if not (isinstance(v, list) and (len(v) > 32 or k.endswith(('Values', 'ValuesArray', 'DTOs'))))}
    if isinstance(value, list):
        return [compact(v) for v in value]
    return value


def stream_inventory(value, timestamp, path=''):
    result = []
    if isinstance(value, dict):
        descriptors = {key: private_summary(child) for key, child in value.items() if 'descriptor' in key.lower() and child is not None}
        for key, child in value.items():
            streams = stream_inventory(child, timestamp, path + '.' + key if path else key)
            if descriptors and isinstance(child, list) and child and isinstance(child[0], (list, dict)) and 'descriptor' not in key.lower():
                for stream in streams:
                    stream['descriptors'] = descriptors
            result.extend(streams)
    elif isinstance(value, list) and value and (isinstance(value[0], (list, dict))):
        times = []
        if isinstance(value[0], list):
            times = [timestamp(row[0]) for row in value if row and isinstance(row[0], (int, float)) and row[0] > 10**9]
        elif isinstance(value[0], dict):
            times = [timestamp(row.get('timestamp') or row.get('startTimeGMT') or row.get('startGMT')) for row in value]
        times = sorted(t for t in times if t)
        deltas = [(datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() for a, b in zip(times, times[1:])]
        result.append({'path': path, 'count': len(value), 'start_at': times[0] if times else None, 'end_at': times[-1] if times else None, 'median_interval_seconds': median(deltas) if deltas else None, 'units': None, 'sampling': 'Garmin returned samples; interval/units unknown unless payload descriptors specify them'})
    return result


def chart_inventory(payload, timestamp):
    rows = payload.get('activityDetailMetrics') or []
    descriptors = payload.get('metricDescriptors') or []
    time_index = next((d.get('metricsIndex') for d in descriptors if d.get('key') == 'directTimestamp'), None)
    times = [timestamp(r['metrics'][time_index]) for r in rows if time_index is not None and len(r.get('metrics') or []) > time_index]
    times = sorted(t for t in times if t)
    intervals = [(datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() for a, b in zip(times, times[1:])]
    return {'sampling': 'Garmin chart API; maxChartSize=2000, maxPolylineSize=4000, may be decimated; NOT native raw records', 'count': len(rows), 'reported_total_count': payload.get('totalMetricsCount'), 'reported_count': payload.get('metricsCount'), 'descriptors': private_summary(descriptors), 'start_at': times[0] if times else None, 'end_at': times[-1] if times else None, 'median_interval_seconds': median(intervals) if intervals else None, 'pending_data': payload.get('pendingData')}


def json_native(value):
    if isinstance(value, (date, datetime, time)):
        return value.isoformat()
    if isinstance(value, bytes):
        return {'encoding': 'base64', 'value': base64.b64encode(value).decode()}
    if isinstance(value, (list, tuple)):
        return [json_native(v) for v in value]
    return value


class NativeDecodeError(ValueError):
    """An original export was downloaded but its FIT data could not be decoded."""


def decode_native(blob):
    """Preserve all FIT data messages, field units, raw values, and developer definitions."""
    members = []
    if zipfile.is_zipfile(io.BytesIO(blob)):
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            members = [(name, archive.read(name)) for name in archive.namelist() if name.lower().endswith('.fit')]
    else:
        members = [('activity.fit', blob)]
    if not members:
        raise ValueError('Original export contains no FIT data')
    messages = []
    for name, content in members:
        with fitdecode.FitReader(io.BytesIO(content)) as reader:
            for frame in reader:
                if isinstance(frame, fitdecode.FitDataMessage):
                    fields = [{'name': f.name, 'value': json_native(f.value), 'raw_value': json_native(f.raw_value), 'units': f.units, 'definition_number': f.def_num, 'developer_data_index': getattr(f.field_def, 'dev_data_index', None)} for f in frame.fields]
                    messages.append({'file': name, 'type': frame.name, 'fields': fields})
    return {'files': [name for name, _ in members], 'messages': messages, 'sha256': hashlib.sha256(blob).hexdigest(), 'byte_count': len(blob)}


def native_inventory(payload):
    records = [m for m in payload.get('messages', []) if m['type'] == 'record']
    field_units = {}
    times = []
    analysis = {}
    for record in records:
        for field in record['fields']:
            name, value = field['name'], field['value']
            if name in {'position_lat', 'position_long'}:
                continue
            field_units[name] = field['units']
            if name == 'timestamp' and value:
                times.append(value)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                row = analysis.setdefault(name, {'count': 0, 'min': value, 'max': value, 'sum': 0, 'unit': field['units']})
                row.update(count=row['count'] + 1, min=min(row['min'], value), max=max(row['max'], value), sum=row['sum'] + value)
    for row in analysis.values():
        row['sample_mean'] = row.pop('sum') / row['count']
    intervals = [(datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() for a, b in zip(times, times[1:])]
    # Four consecutive recording quarters expose changing HR/speed/cadence/power without
    # mistaking sample means for time-weighted physiological drift or comparing intervals blindly.
    segments = []
    for quarter in range(4):
        selected = records[len(records) * quarter // 4:len(records) * (quarter + 1) // 4]
        measurements = {}
        segment_times = []
        for record in selected:
            for field in record['fields']:
                name, value = field['name'], field['value']
                if name == 'timestamp' and value:
                    segment_times.append(value)
                if name in {'heart_rate', 'enhanced_speed', 'speed', 'cadence', 'fractional_cadence', 'power', 'enhanced_altitude'} and isinstance(value, (int, float)) and not isinstance(value, bool):
                    row = measurements.setdefault(name, {'count': 0, 'sum': 0, 'unit': field['units']})
                    row['count'] += 1
                    row['sum'] += value
        for row in measurements.values():
            row['sample_mean'] = row.pop('sum') / row['count']
        if selected:
            segments.append({'quarter': quarter + 1, 'record_count': len(selected), 'start_at': segment_times[0] if segment_times else None, 'end_at': segment_times[-1] if segment_times else None, 'metrics': measurements})
    return {'sampling': 'native FIT recording; not chart decimation, not assumed per-second; sample means are not time-weighted', 'record_count': len(records), 'message_counts': {name: sum(m['type'] == name for m in payload.get('messages', [])) for name in {m['type'] for m in payload.get('messages', [])}}, 'units': field_units, 'start_at': times[0] if times else None, 'end_at': times[-1] if times else None, 'median_interval_seconds': median(intervals) if intervals else None, 'min_interval_seconds': min(intervals) if intervals else None, 'max_interval_seconds': max(intervals) if intervals else None, 'record_statistics': analysis, 'recording_quarters': segments}
