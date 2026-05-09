## ADDED Requirements

### Requirement: 短信通知能力抽象
系统 SHALL 提供 `SmsNotifier` 接口与默认实现，暴露方法 `sendPredictionSms(predictions: PredictionResult[])`。实现 SHALL 通过环境变量配置短信网关凭据，禁止将 AccessKey 等敏感信息硬编码到源码。

必备环境变量：`SMS_PROVIDER`（如 `aliyun`）、`SMS_ACCESS_KEY_ID`、`SMS_ACCESS_KEY_SECRET`、`SMS_SIGN_NAME`、`SMS_TEMPLATE_CODE`、`SMS_PHONE`。

#### Scenario: 缺少凭据时启动报错
- **WHEN** 进程启动且未配置 `SMS_ACCESS_KEY_ID`
- **THEN** 系统在初始化阶段抛出明确错误，不进入 cron 调度

### Requirement: 短信内容覆盖两个标的
短信内容 MUST 同时包含上证指数与创业板指的下一交易日方向（"买涨" / "买跌"）、置信度（百分比）以及生成时间，并提示"仅供个人参考，非投资建议"。

发送目标手机号 MUST 来自环境变量 `SMS_PHONE`，且默认值与需求一致（`15136489941`）。

#### Scenario: 预测完成后推送短信
- **WHEN** `predictAllTargets()` 返回两条结果且短信网关可用
- **THEN** 用户在 60 秒内收到一条短信，内容含两个指数名称与各自的方向、置信度以及风险提示

### Requirement: 短信发送失败的容错
当短信网关返回失败时，系统 SHALL 在本地日志记录详细错误（含 `requestId`、错误码），并在内存中重试至多 2 次；连续 3 次失败 MUST 触发降级：将预测结果落盘到 `.memory/stock_agent_failed_sms.log` 以便人工查看。

#### Scenario: 短信网关连续失败
- **WHEN** 阿里云短信连续 3 次返回限流错误
- **THEN** 系统不再继续重试，写入失败日志并继续后续 cron 周期，不导致进程退出
