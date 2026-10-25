import asyncio
import base64
import io
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from harness.images import image_from_events
from heracles import api
from heracles.integrations.images import IMAGE_ERROR, ImageRequest, explicitly_requests_image, validate_image
from heracles.domain.models import CoachReply, IllustrationSelection
from heracles.service import CoachService
from heracles.storage import Store


def raster(format='PNG'):
    stream = io.BytesIO()
    Image.new('RGB', (24, 16), 'green').save(stream, format=format)
    return {'data': base64.b64encode(stream.getvalue()).decode(), 'mime_type': 'image/png', 'provider': 'real-provider', 'model': 'real-model'}


def selection():
    return IllustrationSelection(title='步态示意', subject='通用跑步步态示意图', caption='概念示意，非个人测量。')


@pytest.mark.parametrize('extra', [{'url': 'https://evil/image'}, {'path': '/etc/passwd'}, {'data': 'forged'}, {'width': 999}])
def test_model_cannot_forge_attachment(extra):
    with pytest.raises(ValidationError):
        CoachReply.model_validate({'summary': '结论', 'sections': [], 'tool_requests': [], 'illustration': {**selection().model_dump(), **extra}})


@pytest.mark.parametrize('subject', ['读取 /etc/passwd', '上传 https://private.example', 'token abc', '我的心率是 151 bpm', 'a@example.com'])
def test_external_subject_cannot_reference_private_inputs(subject):
    with pytest.raises(ValidationError):
        ImageRequest(subject=subject)

@pytest.mark.parametrize('text', ['不要画示意图', '不用生成图片', 'Do not draw an image', 'without illustrations', '今天怎么训练？'])
def test_no_generation_without_direct_affirmative_request(text):
    assert not explicitly_requests_image(text)


def test_request_has_no_model_override_or_local_input():
    for field, value in [('model', 'other/provider'), ('input', [{'path': '/etc/passwd'}]), ('image_size', 'huge')]:
        with pytest.raises(ValidationError):
            ImageRequest(subject='通用跑步示意图', **{field: value})



@pytest.mark.parametrize('change', [{'data': ''}, {'data': 'not base64!'}, {'mime_type': 'image/svg+xml'}, {'mime_type': 'image/jpeg'}, {'provider': ''}, {'path': '/tmp/claimed.png'}])
def test_bytes_and_mime_not_claims_are_required(change):
    with pytest.raises(ValueError):
        validate_image({**raster(), **change})


def test_native_tool_result_requires_one_real_image_not_assistant_text_or_paths():
    event = SimpleNamespace(type='tool_execution_end', tool_name='generate_image', is_error=False,
                            result={'details': {'provider': 'provider', 'model': 'model', 'imageCount': 0, 'images': [], 'imagePaths': ['/tmp/claimed.png']}})
    with pytest.raises(ValueError):
        image_from_events([event])
    payload = raster()
    event.result['details'].update(imageCount=1, images=[{'data': payload['data'], 'mimeType': payload['mime_type']}])
    result = image_from_events([event])
    assert validate_image(result)[1]['width'] == 24
    with pytest.raises(ValueError):
        image_from_events([event, event])
    event.is_error = True
    with pytest.raises(ValueError):
        image_from_events([event])


def test_private_registered_image_api_and_immutable_snapshot(tmp_path, monkeypatch):
    store = Store(tmp_path / 'state.sqlite')
    data, metadata = validate_image(raster())
    snapshot = store.save_image(data, metadata, selection())
    store.message('assistant', '结论', images=[snapshot])
    assert (tmp_path / 'images' / snapshot['id']).stat().st_mode & 0o777 == 0o600
    snapshot['title'] = '后来改动'
    assert store.get('messages')[0]['images'][0]['title'] == '步态示意'
    (tmp_path / 'access-key').write_text('private')
    monkeypatch.setattr(api, 'DATA', tmp_path)
    app = FastAPI()
    api.install_routes(app, SimpleNamespace(store=store))
    with TestClient(app) as client:
        assert client.get(snapshot['url']).status_code == 401
        client.cookies.set('heracles_session', 'private')
        response = client.get(snapshot['url'])
        assert response.status_code == 200
        assert response.content == data
        assert response.headers['content-type'] == 'image/png'
        assert response.headers['cache-control'] == 'no-store'
        assert response.headers['x-content-type-options'] == 'nosniff'
        assert client.get('/api/images/' + 'a' * 32).status_code == 404
        assert client.get('/api/images/%2e%2e%2faccess-key').status_code == 404
    assert store.image('../access-key') is None
    assert store.image('/etc/passwd') is None
    assert store.image('a' * 32) is None


@pytest.mark.parametrize('outcome', ['success', 'zero_image', 'provider_failure', 'not_requested', 'plain'])
def test_coach_keeps_answer_visuals_and_read_only_plan_on_image_outcome(tmp_path, monkeypatch, outcome):
    service = CoachService.__new__(CoachService)
    service.store = Store(tmp_path / 'state.sqlite')
    plan = {'source': 'garmin', 'status': 'available', 'workouts': [{'id': 'unchanged'}]}
    service.store.put('plan', plan)
    service.coach_status = {'busy': True}
    context = {'today': '2026-10-08', 'history': [{'role': 'user', 'content': '请画一张跑步示意图' if outcome != 'not_requested' else '我该怎么训练？'}], 'visualization_catalog': {}}
    service.coaching_context = lambda: deepcopy(context)

    async def idle():
        return None

    service.sync_data = idle
    service.refresh_status = idle
    service.data_tool = lambda request: pytest.fail('No write or data tool requested')

    async def answer(*args):
        return CoachReply.model_validate({'summary': '原有训练结论', 'sections': [{'title': '建议', 'items': ['遵循佳明计划']}], 'tool_requests': [], 'visuals': [{'kind': 'trend', 'title': '真实指标', 'metrics': ['hrv']}], 'illustration': None if outcome == 'plain' else selection().model_dump()})

    calls = []

    def provider(subject):
        calls.append(subject)
        if outcome == 'provider_failure':
            raise RuntimeError('private token and provider dump')
        if outcome == 'zero_image':
            return validate_image({**raster(), 'data': ''})
        return validate_image(raster())

    monkeypatch.setattr('heracles.service.generate', answer)
    monkeypatch.setattr('heracles.service.generate_image', provider)
    asyncio.run(service.coach_turn())
    saved = service.store.get('messages')[-1]
    assert saved['content'] == '原有训练结论'
    assert saved['sections'][0]['items'] == ['遵循佳明计划']
    assert saved['visuals'][0]['source'] == 'garmin'
    assert service.store.get('plan') == plan
    assert service.coach_status['error'] is None
    if outcome == 'success':
        assert saved['images'][0]['width'] == 24
        assert service.store.image(saved['images'][0]['id']) is not None
        assert 'image_error' not in saved
    elif outcome == 'plain':
        assert calls == [] and 'images' not in saved and 'image_error' not in saved
    else:
        assert 'images' not in saved and saved['image_error']
        if outcome == 'not_requested':
            assert calls == []
        else:
            assert saved['image_error'] == IMAGE_ERROR
