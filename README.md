![Heracles — A little wisdom. A stronger training plan.](docs/assets/banner.webp)

# Heracles

**佳明训练计划的 AI 增强教练。大力神也有恢复日。**

A self-hosted, mobile-first AI coach that makes your Garmin training plan more personal, detailed, and adaptable.

佳明负责长期训练节奏，Heracles 帮你处理今天的变化：只有半小时、昨晚没睡好、身体酸痛，或不知道一堂课具体该怎么执行。手机打开 PWA，记录状态，和教练讨论，然后查看并确认调整。

## 能做什么

- **读懂真实记录**：同步佳明中国区的训练计划、课程步骤、活动、睡眠、HRV、训练准备度和恢复记录。保留数据时间，缺失不补造。
- **细化到执行**：热身、主训练、恢复、冷身，每一步都有时间或距离、强度说明、执行要点和停止条件。
- **按今天调整**：结合疲劳、不适、可用时间和设备记录提出方案。查看佳明原课与建议的差异后采用，也可以撤销。
- **保留长期基线**：佳明原计划与 Heracles 调整分别保存。原课变化或当天状态更新后，相关调整需要重新评估。
- **移动端优先**：今日训练、教练对话、训练计划三个入口，适配安全区域与软键盘。HTTPS 下可添加到手机主屏幕。
- **自己部署**：一个 Docker 容器、一个 SQLite 数据卷。教练使用官方 DeepSeek Harness 与 `deepseek-flash`，不依赖桌面代理或 Tailscale。

目前以个人自托管使用为目标，不包含多人账户、社交、动作素材库或自动知识发布。

## 训练计划边界

**调整在 Heracles 内生效，目前不会覆盖 Garmin Connect，也不会下发到手表。** 佳明自适应教练课程使用特殊接口，不能把普通课程编辑接口当作对它的可靠写回支持。执行调整前，请留意手表仍可能显示佳明原课。

没有佳明课程时，教练可以根据你的明确目标和经验提出独立的 Heracles 方案。同步失败保留原始快照；不会用模拟数据充当真实记录。训练建议不是医疗诊断；疼痛、胸痛、眩晕或异常气短时应停止训练并寻求专业帮助。

## Docker 启动

需要 Docker Engine 和 Compose。DeepSeek API 密钥仅保存在服务器上。

```sh
git clone https://github.com/hx-w/heracles.git
cd heracles
cp .env.example .env
# 编辑 .env，填写 DEEPSEEK_API_KEY
docker compose up -d --build
```

默认监听 `127.0.0.1:8791`。数据、账号令牌、私人访问密钥和教练会话保存在 `heracles_data` 命名卷内。容器以非 root 用户运行。

生成私人访问链接：

```sh
docker compose exec heracles python -m heracles.access --url http://localhost:8791
```

在浏览器打开命令输出的完整链接。首次访问设置 HttpOnly 会话 cookie，随后移除地址里的密钥。不要分享这条链接或提交 `.env`。

### 连接佳明

先在终端完成一次佳明中国区登录，验证码也在终端输入：

```sh
docker compose run --rm heracles python login.py
```

回到页面点击“同步佳明”。每轮教练对话会先同步，后台每 15 分钟同步一次；这不表示手表每 15 分钟上传一次。

当前使用非官方 [`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect)，只支持已经验证过的中国区接入。接口可能变化，不冒充佳明官方服务。国际区尚未验证。

### 服务器 HTTPS 与手机安装

将域名解析到服务器，在 `.env` 中设置 `HERACLES_DOMAIN`，开放 80/443：

```sh
docker compose -f compose.yaml -f compose.production.yaml up -d --build
docker compose exec heracles python -m heracles.access --url https://your-domain.example
```

生产配置使用 Caddy 自动申请证书。手机打开私人 HTTPS 链接，iOS 通过 Safari 分享菜单“添加到主屏幕”，Android 通过浏览器安装。手机不需要加入任何私有网络。

若已有反向代理，只需把 HTTPS 流量转发到 `127.0.0.1:8791` 并保留 Host 与协议转发头。个人训练数据不会进入 service worker 缓存；断网时显示离线页，教练需要联网。

### 直接部署 CI 产物

仓库只配置 **Docker image** 一条 CI：拉取请求验证镜像可构建；主分支、版本标签和手动触发还会产出可下载的 Linux amd64 镜像包。没有测试、静态扫描或其他 CI 工作流。

从 [Actions](https://github.com/hx-w/heracles/actions/workflows/docker-image.yml) 下载 `heracles-linux-amd64` artifact 并解压，然后在服务器加载：

```sh
docker load -i heracles-image.tar.gz
docker compose up -d --no-build
# 使用生产 HTTPS 时，继续带上 -f compose.yaml -f compose.production.yaml
```

Compose 使用 `heracles:latest`。ARM 主机可从源码本地构建。升级前备份数据卷；回退时加载之前的镜像，再运行 `up -d --no-build`。不要用 `docker compose down -v` 升级，它会删除数据卷。

## 开发

Python 3.12、uv、Bun：

```sh
uv venv --python 3.12
uv pip install --python .venv/bin/python -r requirements.txt -r requirements-dev.txt
bun install --frozen-lockfile
bun --bun run build
# 设置服务器环境变量 DEEPSEEK_API_KEY 后启动
.venv/bin/python server.py
```

`bun run dev` 仅用于前端开发，`/api` 代理到本地后端。运行检查：

```sh
.venv/bin/python -m pytest -q
bun --bun run build
```

详见 [贡献指南](CONTRIBUTING.md)、[架构与数据边界](docs/architecture.md) 和 [安全说明](SECURITY.md)。

## 致谢与许可

交互设计参考 [Moshi](https://getmoshi.app/) 的移动操作方式，训练提案参考 [openGym](https://github.com/DuarteSantos8/openGym) 的显式确认与基线校验思路；没有复制其代码或运动媒体素材。教练采用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方 Python SDK，目前固定最新 SDK/runtime 发布版 `0.2.1rc2`，模型 ID `deepseek-flash` 对应 V4.1 Flash。更新依赖时需重新验证工具禁用与协议。

[MIT](LICENSE)。README 横幅由 ImageGen 生成。Heracles 与 Garmin、DeepSeek 没有关联或官方背书。
