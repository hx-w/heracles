# Architecture

```text
Phone PWA → HTTPS reverse proxy → FastAPI
                                  ├─ Garmin China → snapshots / raw activity files
                                  ├─ official DeepSeek Harness → deepseek-flash
                                  └─ SQLite → profile / check-in / chat / proposals
```

一个应用进程、一个数据卷，不需要独立队列或代理服务。React 负责交互，HTTP API 负责访问控制；`service.py` 编排同步和教练回合；`domain/planning.py` 验证并保存独立的训练调整；`integrations/garmin*.py` 保留来源与原始数据。`harness/client.py` 通过官方 Python SDK 启动隔离的 `sdk-minimal` 运行时，并通过 `coach.patch.yml` 禁用可执行工具。

Garmin 快照和 Heracles 提案是两类记录。提案包含原课程快照、基线哈希、状态反馈哈希及已采用方案版本。生成不等于采用；采用在 SQLite 写事务内核对当前状态。重复操作幂等，旧版本不能覆盖新版本。日期和课程 ID 共同标识一次安排，同一天其他课程不会被替换。原课变化仅暂停受影响课程的覆盖，不移除无关安排。

时间步骤用秒、距离步骤用米，必须二选一。佳明原步骤保留嵌套重复与实际目标；速度按 m/s 处理。主观反馈每天保存；疼痛反馈阻止生成当天训练处方。读取时间不等于测量时间，缺失不填零。计划列表、指标、图像与原始数据都受同一私人会话保护。

`/healthz`、安装 manifest、图标和 service worker 是无个人数据的公开资源。业务页面与 API 需要私人链接换取的会话 cookie，同源写入检查阻止跨站变更。公开仓库不包含运行数据或凭证。

当前图片生成功能关闭；已有私有图片仍可读取。没有自动知识发布，也没有 Garmin 写回。未来若加入写回，必须先区分普通课程和自适应教练课程，再实现变更预览、明确确认与真实接口读回验证。
