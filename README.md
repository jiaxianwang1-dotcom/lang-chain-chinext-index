# langgraph-agent

## 指数预测智能体（stock-index-agent）

基于 LangGraph 的 A 股指数（上证指数 / 创业板指）预测智能体，每个交易日 14:00 自动采集行情、用 LLM + 联网搜索分析涨跌原因，并对下一交易日方向（买涨 / 买跌）输出预测，最终通过短信推送到 `SMS_PHONE`。

### 一、配置环境变量

复制 `.env.example` 为 `.env` 并填写以下字段（仅与短信相关，其余沿用现有配置）：

```
SMS_PROVIDER=aliyun                # 当前仅支持阿里云
SMS_ACCESS_KEY_ID=...              # 阿里云 AccessKey
SMS_ACCESS_KEY_SECRET=...
SMS_SIGN_NAME=...                  # 已审核通过的签名
SMS_TEMPLATE_CODE=SMS_xxx          # 已审核通过的模板 CODE
SMS_PHONE=15136489941              # 接收短信的手机号
```

短信模板需要包含两个变量占位符 `${content}`、`${time}`，例如：

> 【签名】指数预测：${content}（${time}）。仅供参考，非投资建议。

### 二、运行

```bash
# 一次性跑通：采集 + 归因 + 预测 + 短信（首次会自动回填近 1 年历史）
npm run stock:once

# Dry-run：只打印短信内容，不真正调用阿里云
npm run stock:dry-run

# 自检：仅初始化数据库与表结构，验证依赖可用
npm run stock:self-check

# 常驻：启动后注册 cron（北京时间每个交易日 14:00 触发完整流程）
npm run stock
```

数据存放在 `.memory/stock_agent.db`（与通用 agent 的 `web_agent.db` 隔离）。

### 三、Web UI（Tab 化版）

`npm run web` 启动 Express 服务（默认 `http://localhost:3000`），新版前端把页面拆为两个 Tab：

- **智能咨询**：保留对话气泡，新增**时间范围选择器**（近 3 天 / 10 天 / 1 月 / 2 月 / 3 月 / 1 年 / 自定义）。当用户提问命中大盘关键词（"大盘 / 上证 / 创业板 / 000001 / 399006 / 指数 / A股 / 盘面 / 沪指 / 创指"）时，服务端按所选窗口（默认 30 天）实时拉取上证 + 创业板 OHLCV，用与 `index_quotes` 同字段的 JSON 注入 LLM；超过 90 个交易日自动按 5 个交易日做周聚合。
- **大盘指数**：上证指数 + 创业板指双卡片，含相同的时间范围选择器、收盘折线图与 9 列明细表（`trade_date / open_value / high_value / low_value / close_value / change / change_pct / volume / turnover`）。当所选窗口包含**今日**且当前判定为交易日时，自动每 5 分钟调一次 `/api/stock/quotes/today` 就地刷新今日那一行（页面隐藏 / 切到其他 Tab 时自动暂停）。

#### 后端 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/stock/chat` | SSE 流式问答；`{ message, range, from?, to?, thread_id? }` |
| `GET`  | `/api/stock/quotes` | 窗口内日线行情；`?indexCode=&range=&from=&to=` |
| `GET`  | `/api/stock/quotes/today` | 当日实时点位；`?indexCode=` |
| `GET`  | `/api/stock/trading-day` | 交易日判定（DB ∪ 时段启发式）；`?date=` |

实时数据全部走 `realtime-quote-service`（`src/agent/stock/realtime/`），不写 SQLite；既有 cron 14:00 入库 + 短信链路保持不变。`fetchQuoteWindow` 5 秒 LRU、`fetchTodayIntraday` 30 秒 LRU，前端轮询固定 5 分钟，避免数据源被打爆。

### 四、风险声明

- 本智能体仅基于公开行情数据 + 联网搜索 + LLM 启发式分析，**不构成投资建议**。
- 个人本地部署，需要进程常驻。建议用 PM2 / systemd / 服务器托管以避免笔记本休眠导致 cron 漏触发。
- LLM 与免费行情接口都可能不稳定，所有预测结果均带"置信度"，请自行评估后再做投资决策。

更多细节见 [`openspec/changes/add-stock-index-agent/`](./openspec/changes/add-stock-index-agent/)、[`openspec/changes/realtime-quotes-tabbed-web-ui/`](./openspec/changes/realtime-quotes-tabbed-web-ui/) 与 `docs/stock-index-agent.md`。

---

## Getting started

To make it easy for you to get started with GitLab, here's a list of recommended next steps.

Already a pro? Just edit this README.md and make it your own. Want to make it easy? [Use the template at the bottom](#editing-this-readme)!

## Add your files

- [ ] [Create](https://docs.gitlab.com/ee/user/project/repository/web_editor.html#create-a-file) or [upload](https://docs.gitlab.com/ee/user/project/repository/web_editor.html#upload-a-file) files
- [ ] [Add files using the command line](https://docs.gitlab.com/ee/gitlab-basics/add-file.html#add-a-file-using-the-command-line) or push an existing Git repository with the following command:

```
cd existing_repo
git remote add origin http://git.dev.sh.ctripcorp.com/jiaxianwang/langgraph-agent.git
git branch -M main
git push -uf origin main
```

## Integrate with your tools

- [ ] [Set up project integrations](http://git.dev.sh.ctripcorp.com/jiaxianwang/langgraph-agent/-/settings/integrations)

## Collaborate with your team

- [ ] [Invite team members and collaborators](https://docs.gitlab.com/ee/user/project/members/)
- [ ] [Create a new merge request](https://docs.gitlab.com/ee/user/project/merge_requests/creating_merge_requests.html)
- [ ] [Automatically close issues from merge requests](https://docs.gitlab.com/ee/user/project/issues/managing_issues.html#closing-issues-automatically)
- [ ] [Enable merge request approvals](https://docs.gitlab.com/ee/user/project/merge_requests/approvals/)
- [ ] [Set auto-merge](https://docs.gitlab.com/ee/user/project/merge_requests/merge_when_pipeline_succeeds.html)

## Test and Deploy

Use the built-in continuous integration in GitLab.

- [ ] [Get started with GitLab CI/CD](https://docs.gitlab.com/ee/ci/quick_start/index.html)
- [ ] [Analyze your code for known vulnerabilities with Static Application Security Testing (SAST)](https://docs.gitlab.com/ee/user/application_security/sast/)
- [ ] [Deploy to Kubernetes, Amazon EC2, or Amazon ECS using Auto Deploy](https://docs.gitlab.com/ee/topics/autodevops/requirements.html)
- [ ] [Use pull-based deployments for improved Kubernetes management](https://docs.gitlab.com/ee/user/clusters/agent/)
- [ ] [Set up protected environments](https://docs.gitlab.com/ee/ci/environments/protected_environments.html)

***

# Editing this README

When you're ready to make this README your own, just edit this file and use the handy template below (or feel free to structure it however you want - this is just a starting point!). Thanks to [makeareadme.com](https://www.makeareadme.com/) for this template.

## Suggestions for a good README

Every project is different, so consider which of these sections apply to yours. The sections used in the template are suggestions for most open source projects. Also keep in mind that while a README can be too long and detailed, too long is better than too short. If you think your README is too long, consider utilizing another form of documentation rather than cutting out information.

## Name
Choose a self-explaining name for your project.

## Description
Let people know what your project can do specifically. Provide context and add a link to any reference visitors might be unfamiliar with. A list of Features or a Background subsection can also be added here. If there are alternatives to your project, this is a good place to list differentiating factors.

## Badges
On some READMEs, you may see small images that convey metadata, such as whether or not all the tests are passing for the project. You can use Shields to add some to your README. Many services also have instructions for adding a badge.

## Visuals
Depending on what you are making, it can be a good idea to include screenshots or even a video (you'll frequently see GIFs rather than actual videos). Tools like ttygif can help, but check out Asciinema for a more sophisticated method.

## Installation
Within a particular ecosystem, there may be a common way of installing things, such as using Yarn, NuGet, or Homebrew. However, consider the possibility that whoever is reading your README is a novice and would like more guidance. Listing specific steps helps remove ambiguity and gets people to using your project as quickly as possible. If it only runs in a specific context like a particular programming language version or operating system or has dependencies that have to be installed manually, also add a Requirements subsection.

## Usage
Use examples liberally, and show the expected output if you can. It's helpful to have inline the smallest example of usage that you can demonstrate, while providing links to more sophisticated examples if they are too long to reasonably include in the README.

## Support
Tell people where they can go to for help. It can be any combination of an issue tracker, a chat room, an email address, etc.

## Roadmap
If you have ideas for releases in the future, it is a good idea to list them in the README.

## Contributing
State if you are open to contributions and what your requirements are for accepting them.

For people who want to make changes to your project, it's helpful to have some documentation on how to get started. Perhaps there is a script that they should run or some environment variables that they need to set. Make these steps explicit. These instructions could also be useful to your future self.

You can also document commands to lint the code or run tests. These steps help to ensure high code quality and reduce the likelihood that the changes inadvertently break something. Having instructions for running tests is especially helpful if it requires external setup, such as starting a Selenium server for testing in a browser.

## Authors and acknowledgment
Show your appreciation to those who have contributed to the project.

## License
For open source projects, say how it is licensed.

## Project status
If you have run out of energy or time for your project, put a note at the top of the README saying that development has slowed down or stopped completely. Someone may choose to fork your project or volunteer to step in as a maintainer or owner, allowing your project to keep going. You can also make an explicit request for maintainers.
