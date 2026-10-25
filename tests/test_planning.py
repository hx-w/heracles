from copy import deepcopy
from datetime import timedelta

import pytest
from pydantic import ValidationError

from heracles.domain.models import CheckIn, TrainingProposal
from heracles.domain.planning import Planning
from heracles.integrations.garmin import empty_plan
from heracles.storage import Store, today


@pytest.fixture
def setup(tmp_path):
    store = Store(tmp_path / 'training.sqlite')
    plan = {**empty_plan(), 'status': 'available', 'workouts': [
        {'id': 'run:1', 'date': today().isoformat(), 'title': '基础跑', 'status': 'planned', 'duration_seconds': 2400, 'steps': []},
        {'id': 'core:1', 'date': today().isoformat(), 'title': '核心训练', 'status': 'planned', 'duration_seconds': 600, 'steps': []},
    ]}
    store.put('plan', plan)
    return store, Planning(store), plan


def proposed(base='run:1', day=None, kind='running'):
    return TrainingProposal(title='今天减量', rationale='按可用时间缩短，保持轻松体感。', sessions=[{
        'date': day or today().isoformat(), 'base_workout_id': base, 'title': '轻松跑', 'kind': kind,
        'reason': '缩短主训练。', 'stop_conditions': '出现影响步态的疼痛则停止。',
        'steps': [] if kind == 'rest' else [{'phase': 'work', 'title': '轻松跑', 'duration_seconds': 1200,
                                          'target': '能完整交谈', 'instructions': '放慢速度，保持轻松。'}],
    }])


def draft(planning, plan, proposal=None, **context):
    return planning.draft(proposal or proposed(), {'plan': deepcopy(plan), 'active_sessions': planning.active(plan), **context})


def test_adopt_revert_and_restart_never_change_garmin_snapshot(setup):
    store, planning, plan = setup
    record = draft(planning, plan)
    assert planning.active() == []
    planning.decide(record['id'], 'accept')
    assert Planning(Store(store.path)).active()[0]['title'] == '轻松跑'
    assert store.get('plan') == plan
    assert planning.decide(record['id'], 'accept')['status'] == 'active'  # idempotent retry
    planning.decide(record['id'], 'revert')
    assert planning.active() == []
    assert store.get('plan') == plan


@pytest.mark.parametrize('change', ['status', 'steps', 'date', 'removed'])
def test_original_changed_after_inference_blocks_acceptance(setup, change):
    store, planning, plan = setup
    record = draft(planning, plan)
    if change == 'removed': plan['workouts'].pop(0)
    elif change == 'date': plan['workouts'][0]['date'] = (today() + timedelta(days=1)).isoformat()
    elif change == 'status': plan['workouts'][0]['status'] = 'completed'
    else: plan['workouts'][0]['steps'] = [{'targetValueOne': 125}]
    store.put('plan', plan)
    with pytest.raises(ValueError): planning.decide(record['id'], 'accept')
    assert planning.state()[0]['invalid_reason']
    assert planning.active() == []


def test_late_model_reply_preserves_both_new_snapshot_and_stale_proposal(setup):
    store, planning, plan = setup
    newer = deepcopy(plan)
    newer['workouts'][0]['status'] = 'completed'
    store.put('plan', newer)
    record = draft(planning, plan)
    assert record['status'] == 'stale'
    assert store.get('plan') == newer


def test_checkin_change_invalidates_pending_and_suspends_active(setup):
    store, planning, plan = setup
    record = draft(planning, plan)
    planning.decide(record['id'], 'accept')
    store.put('checkin:' + today().isoformat(), {'fatigue': 5, 'soreness': 'pain', 'available_minutes': 20})
    assert planning.active() == []
    assert '状态' in planning.state()[0]['sessions'][0]['invalid_reason']


def test_revisions_preserve_unrelated_same_day_session(setup):
    store, planning, plan = setup
    first = proposed()
    first.sessions += proposed('core:1').sessions
    record = draft(planning, plan, first)
    planning.decide(record['id'], 'accept')
    newer = draft(planning, plan, proposed(kind='rest'))
    planning.decide(newer['id'], 'accept')
    assert len(planning.active()) == 2
    assert {s['base_workout_id']: s['kind'] for s in planning.active()} == {'run:1': 'rest', 'core:1': 'running'}
    planning.decide(newer['id'], 'revert')
    assert [s['base_workout_id'] for s in planning.active()] == ['core:1']
    assert store.get('plan') == plan


def test_conflicting_parallel_proposals_cannot_both_be_adopted(setup):
    _, planning, plan = setup
    first, second = draft(planning, plan), draft(planning, plan)
    planning.decide(first['id'], 'accept')
    with pytest.raises(ValueError, match='方案发生变化'): planning.decide(second['id'], 'accept')


def test_no_added_session_over_existing_garmin_course(setup):
    _, planning, plan = setup
    with pytest.raises(ValueError, match='已有佳明课程'): draft(planning, plan, proposed(None))


def test_independent_plan_on_empty_day(setup):
    _, planning, plan = setup
    day = (today() + timedelta(days=1)).isoformat()
    record = draft(planning, plan, proposed(None, day))
    planning.decide(record['id'], 'accept')
    assert planning.active()[0]['baseline'] is None


@pytest.mark.parametrize('offset', [-1, 14])
def test_invalid_date_horizon(setup, offset):
    _, planning, plan = setup
    with pytest.raises(ValueError, match='14天'): draft(planning, plan, proposed(None, (today() + timedelta(days=offset)).isoformat()))


def test_time_budget_and_pain_guard(setup):
    store, planning, plan = setup
    checkin = {'fatigue': 4, 'soreness': 'pain', 'available_minutes': 30}
    store.put('checkin:' + today().isoformat(), checkin)
    with pytest.raises(ValueError, match='疼痛'): draft(planning, plan, checkin=checkin)
    assert draft(planning, plan, proposed(kind='rest'), checkin=checkin)['status'] == 'pending'
    checkin.update(soreness='none', available_minutes=10)
    store.put('checkin:' + today().isoformat(), checkin)
    with pytest.raises(ValueError, match='可用时间'): draft(planning, plan, checkin=checkin)


def test_source_failure_suspends_active_until_successful_sync(setup):
    store, planning, plan = setup
    record = draft(planning, plan)
    planning.decide(record['id'], 'accept')
    plan['status'] = 'error'; store.put('plan', plan)
    assert planning.active() == []
    plan['status'] = 'available'; store.put('plan', plan)
    assert len(planning.active()) == 1


def test_invalid_steps_and_checkin_rejected():
    with pytest.raises(ValidationError):
        CheckIn(fatigue=0, soreness='none', available_minutes=25)
    data = proposed().model_dump()
    data['sessions'][0]['steps'][0]['distance_meters'] = 500
    with pytest.raises(ValidationError): TrainingProposal.model_validate(data)


def test_private_api_requires_owner_and_rejects_cross_origin(setup, tmp_path, monkeypatch):
    from types import SimpleNamespace
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from heracles import api
    store, planning, plan = setup
    record = draft(planning, plan)
    monkeypatch.setattr(api, 'DATA', tmp_path)
    service = SimpleNamespace(store=store, coach_status={'busy': False}, sync_running=False)
    app = FastAPI(); api.install_routes(app, service)
    with TestClient(app) as client:
        path = '/api/proposals/' + record['id'] + '/accept'
        assert client.post(path).status_code == 401
        client.cookies.set('heracles_session', (tmp_path / 'access-key').read_text())
        assert client.post(path, headers={'Origin': 'https://untrusted.example'}).status_code == 403
        assert client.post(path).status_code == 200
        assert client.post('/api/checkin', json={'fatigue': 4, 'soreness': 'none', 'available_minutes': 25}).status_code == 200
        assert store.get('plan') == plan


def test_one_changed_session_does_not_remove_future_sessions(setup):
    store, planning, plan = setup
    proposal = proposed()
    tomorrow = (today() + timedelta(days=1)).isoformat()
    proposal.sessions += proposed(None, tomorrow).sessions
    record = draft(planning, plan, proposal)
    planning.decide(record['id'], 'accept')
    plan['workouts'][0]['status'] = 'completed'; store.put('plan', plan)
    assert [s['date'] for s in planning.active()] == [tomorrow]


def test_reused_workout_id_on_another_date_is_independent(setup):
    store, planning, plan = setup
    tomorrow = (today() + timedelta(days=1)).isoformat()
    plan['workouts'].append({**plan['workouts'][0], 'date': tomorrow}); store.put('plan', plan)
    first = draft(planning, plan)
    planning.decide(first['id'], 'accept')
    second = draft(planning, plan, proposed('run:1', tomorrow))
    planning.decide(second['id'], 'accept')
    assert len(planning.active()) == 2


def test_active_plan_survives_many_subsequent_drafts(setup):
    _, planning, plan = setup
    first = draft(planning, plan)
    planning.decide(first['id'], 'accept')
    for _ in range(101): draft(planning, plan)
    assert len(planning.active()) == 1
    assert planning.decide(first['id'], 'revert')['status'] == 'reverted'
