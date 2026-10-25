"""Interactive Garmin China login; no password in command args, browser or chat."""
from getpass import getpass

from garminconnect import Garmin

from heracles.integrations.garmin import GarminData
from heracles.storage import Store


if __name__ == '__main__':
    data = GarminData(Store())
    account = input('佳明中国账号（手机号或邮箱）: ').strip()
    password = getpass('佳明密码: ')
    client = Garmin(email=account, password=password, is_cn=True, prompt_mfa=lambda: input('佳明验证码: ').strip())
    client.login(str(data.tokenstore))
    print('佳明中国登录成功；认证已保存在本机私有目录，网页无需密码。')
