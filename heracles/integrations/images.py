"""Only real bounded raster bytes cross the private image boundary."""
import base64
import binascii
import io
import re
import warnings

from PIL import Image
from pydantic import Field, field_validator

from heracles.domain.models import ShortText, StrictModel

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000
FORMATS = {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'WEBP': 'image/webp'}
IMAGE_ERROR = '示意图未能生成；文字分析和真实指标已保留。请稍后重试。'


class ImageRequest(StrictModel):
    subject: ShortText = Field(max_length=2000)

    @field_validator('subject')
    @classmethod
    def generic_subject(cls, value):
        # No references, credentials or personal measurements can become provider inputs.
        if re.search(r'https?://|\w+://|[/\\]|@|\b(?:token|password|secret|account)\b|身份证|手机号|账户|姓名|住址|经纬度|我的|本人|今日|今天|昨天', value, re.I):
            raise ValueError('示意图主题必须是无身份、位置或个人测量值的通用概念')
        return value


def explicitly_requests_image(text):
    if re.search(r'(?:不要|不用|无需|别|禁止|不需要|不想).{0,24}(?:图|画|illustrat|image)|(?:do not|don.t|no|without).{0,24}(?:image|illustrat|draw)', text, re.I):
        return False
    return bool(re.search(r'(?:画|绘制|生成|制作|给|提供|来|看|展示).{0,24}(?:图|插画|示意)|(?:图解|illustrat|draw|generate.{0,20}image)', text, re.I))


def validate_image(payload):
    if not isinstance(payload, dict) or set(payload) != {'data', 'mime_type', 'provider', 'model'}:
        raise ValueError('无有效图像输出')
    encoded = payload['data']
    if not isinstance(encoded, str) or not encoded or len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
        raise ValueError('图像输出超过限制或为空')
    if any(not isinstance(payload[key], str) or not payload[key].strip() or len(payload[key]) > 200 for key in ('provider', 'model')):
        raise ValueError('缺少真实图像来源')
    try:
        data = base64.b64decode(encoded, validate=True)
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise ValueError('图像输出超过限制或为空')
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                media_type = FORMATS.get(image.format)
                width, height = image.size
                if not media_type or payload['mime_type'] != media_type or not (0 < width <= 4096 and 0 < height <= 4096) or width * height > MAX_IMAGE_PIXELS or getattr(image, 'n_frames', 1) != 1:
                    raise ValueError('不支持的图像格式或尺寸')
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                image.load()
        return data, {'width': width, 'height': height, 'media_type': media_type, 'provider': payload['provider'], 'model': payload['model']}
    except (binascii.Error, OSError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError('图像字节无效') from exc


def generate_image(subject):
    raise RuntimeError('DeepSeek Flash 不提供图像生成；历史图片仍可查看')
