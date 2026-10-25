"""Validate historical image event payloads; no image-generation runtime."""
from heracles.integrations.images import validate_image


def image_from_events(events):
    calls = [event for event in events if event.type == 'tool_execution_end']
    if len(calls) != 1 or calls[0].tool_name != 'generate_image' or calls[0].is_error:
        raise ValueError('原生图像工具未完成唯一一次生成')
    result = calls[0].result
    details = result.get('details') if isinstance(result, dict) else None
    if not isinstance(details, dict) or details.get('imageCount') != 1 or not isinstance(details.get('images'), list) or len(details['images']) != 1:
        raise ValueError('原生图像工具未返回唯一图像')
    image = details['images'][0]
    if not isinstance(image, dict):
        raise ValueError('原生图像输出无效')
    payload = {'data': image.get('data'), 'mime_type': image.get('mimeType'), 'provider': details.get('provider'), 'model': details.get('model')}
    validate_image(payload)
    return payload
