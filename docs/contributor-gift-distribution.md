# TokenTracker Merged PR 贡献者 1 年云服务兑换码落地方案

## 1. 方案背景与核心目标

### 1.1 背景
TokenTracker 新增了多端同步与云端一体化服务（TokenTracker Cloud），将原有的多端同步功能升级为云服务。系统内置了基于 InsForge 数据库与加密哈希机制的安全兑换码（Gift Code）体系。

为了真诚回馈开源社区，项目决定向所有向 TokenTracker 提交过 Pull Request 并成功被合并（Merged）的代码贡献者，免费发放为期 **1 年（365 天）** 的 TokenTracker Cloud 兑换码。

### 1.2 目标与约束
1. **精准去重与资格界定**：精准统计所有成功合并代码的真实贡献者，排除机器人与仓库所有者，一人一码。
2. **私密与资产安全**：兑换码属于真实高价值权益资产，原码绝对不入库、不公开、不落地未受保护的文件，严格遵循 `docs/pro-gift-codes.md` 的 0600 权限与 SHA-256 单向哈希规范。
3. **安全分发渠道**：由于 GitHub 无内置私信系统，且明文码不可在公开 PR / Issue 中张贴，方案必须兼顾**邮件直发**与**无公开邮箱者的安全防冒领认领**双轨机制。
4. **即开即用（SOP Ready）**：本阶段暂不向贡献者发送，但全套工程脚本、分发配置、分配算法与文案模板均已就绪，未来需要发送时可一键执行。

---

## 2. 贡献者资格界定与现网数据核算

### 2.1 筛选规则
- **准入条件**：在 `xiufengsun/TokenTracker` 仓库中，PR 状态为 `state=merged`。
- **排除对象**：
  - 仓库 Owner（`xiufengsun`）；
  - 自动化依赖升级与 CI 机器人（`app/dependabot`、`dependabot[bot]`、`github-actions[bot]` 及所有 `is_bot=true` 账户）。
- **去重规则**：无论单个贡献者被合并了多少个 PR（从 1 个到 22 个不等），统一分配 1 个为期 1 年的兑换码。

### 2.2 现网统计大盘（截至 2026-10-11）
- **合并 PR 总数**：352 个
- **合格独立贡献者**：**82 位**
- **联系渠道覆盖分布**：
  - **具有有效 Git 提交邮箱**：**50 位**（占比 61.0%，可直接由邮件系统私密触达，附带专属明文码）；
  - **使用 GitHub 隐私代理邮箱（noreply）**：**29 位**（占比 35.4%，需通过 PR 留言引导或公开认领通道触达）；
  - **历史提交无直接关联邮箱**：**3 位**（占比 3.6%，需通过 GitHub ID 认领渠道触达）。

### 2.3 核心贡献者概览（Top 10）
| 排名 | GitHub 账户 | 贡献者姓名 | Merged PR 数量 | 代表性 PR | 优先联系渠道 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | @Hu9956 | Hu9956 | 22 | #755, #567, #549 | Git 提交邮箱直达 |
| 2 | @LceAn | LceAn | 22 | #615, #583 | noreply / 公开认领通道 |
| 3 | @fflake33 | Jian Gong | 21 | #478 | noreply / 公开认领通道 |
| 4 | @paveezheng | Pavee Zheng | 19 | #561, #558, #553 | Git 提交邮箱直达 |
| 5 | @lamther | lamther | 18 | #373 | Git 提交邮箱直达 |
| 6 | @Hasasasa | Phil | 13 | #731 | 公开认领通道 / PR 引导 |
| 7 | @minh-tg | Minh Truong | 12 | #767, #579 | 公开认领通道 / PR 引导 |
| 8 | @Roomen | habitable | 9 | #501 | noreply / 公开认领通道 |
| 9 | @csmashe | csmashe | 8 | #574, #573 | Git 提交邮箱直达 |
| 10 | @eteen12 | Ethan Breitkreutz | 7 | #708 | Git 提交邮箱直达 |

---

## 3. 兑换码生成机制与安全规范

### 3.1 权益参数规格
- **单码时长 (`--days`)**：`365`（服务端自动发放 365 天完整 Cloud 会员期）。
- **批次总量 (`--count`)**：建议生成 **92 个**（82 个分配给当前已合并 PR 贡献者，10 个备用码预留给近期新合并贡献者或补发）。
- **兑换截止时间 (`--expires`)**：建议设置为生成之日起 1 年有效（如 `2027-10-11T23:59:59Z`），即贡献者在收到码后有足足 1 年的时间在客户端或网页内完成激活。
- **批次标识 (`--label`)**：`github-contributors-pr-merged-1y`。
- **环境 (`--environment`)**：正式生产环境 `live`（演练测试可先使用 `sandbox`）。

### 3.2 存储与安全基线
1. **原码绝不上库**：兑换码明文只保存在本地私有文件（如 `.tmp/contributor-gift-codes.json`，已受 `.gitignore` 保护，权限 `0600`，只允许当前 macOS/Linux 用户读写）。
2. **服务端单向哈希**：数据库及 RPC `cloud_create_gift_batch` 仅接收 SHA-256 哈希值与 8 位防伪后缀，云端不保存明文码，即使数据库被拖库也无法反解原码。
3. **断线安全恢复**：若执行网络超时，直接使用 `--resume` 参数重试同一份本地 JSON 文件，服务端会幂等识别相同哈希集合，绝不会生成重复批次或泄露多余权益。

---

## 4. 自动化编排工具（`scripts/contributor-gift-distribution.cjs`）

本方案已配套编写了专属编排脚本 `scripts/contributor-gift-distribution.cjs`，提供从贡献者提取、批次推荐、1:1 专属绑定到文案生成的完整闭环。

### 4.1 支持命令一览
```sh
# 1. 查看贡献者统计与完整名单
node scripts/contributor-gift-distribution.cjs list-contributors

# 2. 输出推荐的发码命令与参数
node scripts/contributor-gift-distribution.cjs recommend-batch

# 3. 将真实生成的兑换码批次与 82 位贡献者进行 1:1 映射绑定并保存私有分配表
node scripts/contributor-gift-distribution.cjs bind-codes \
  --batch-file .tmp/contributor-gift-codes.json \
  --out-file .tmp/contributor-allocation.json

# 4. 校验映射结果的唯一性与无遗漏性
node scripts/contributor-gift-distribution.cjs verify \
  --allocation-file .tmp/contributor-allocation.json

# 5. 导出定制化的邮件文案与公告模板
node scripts/contributor-gift-distribution.cjs format-messages \
  --allocation-file .tmp/contributor-allocation.json \
  --out-file .tmp/contributor-messages.json
```

---

## 5. 触达渠道矩阵与防泄露机制

由于 GitHub 平台没有对普通用户的直接私信机制，且**兑换码是可转移、任何人输入即可激活的不记名凭据**，严禁直接在 GitHub PR 评论或公开 Issue 中张贴明文兑换码！

方案采用“**三级分发矩阵**”：

```
                ┌────────────────────────────────────────────────────────┐
                │        82 位 TokenTracker Merged PR 贡献者             │
                └───────────────────────────┬────────────────────────────┘
                                            │
                    ┌───────────────────────┴───────────────────────┐
                    ▼                                               ▼
         【渠道一：邮件私密直发】                        【渠道二与三：引导认领】
            50 位有公开提交邮箱                           32 位 noreply 或无邮箱
                    │                                               │
                    ▼                                               ▼
     直接发送包含专属兑换码的感谢信                 1. 在最新合并 PR 留言致谢引导
     （最私密、防冒领、体验最佳）                   2. 发布社区公开致谢公告与认领指南
                                                    3. 贡献者通过邮件或 Issue 凭 ID 认领
```

### 渠道一：邮件直达（优先）
- **适用对象**：50 位在 Git Commit 中登记了有效真实邮箱的贡献者。
- **执行方式**：脚本自动导出的 `emailTemplates` 包含每位贡献者的邮箱、代表性 PR 编号、专属兑换码与使用指南。维护者可通过个人常用邮箱批量发送或逐一发送。

### 渠道二：PR 留言通知引导（无邮箱贡献者）
- **适用对象**：29 位使用 noreply 邮箱或无邮箱的贡献者。
- **执行方式**：在每位贡献者最新被合并的 PR 页面留言。**留言中绝不包含明文兑换码**，仅说明已为其预留 1 年会员，请通过邮件或 GitHub 登录认领。

### 渠道三：社区发布公告与认领通道（Discussions / Issue / Release）
- **适用对象**：全体贡献者与开源社区。
- **执行方式**：在 GitHub Release 说明或 Pin 住的 Issue 中发布《致 TokenTracker 开源贡献者：1 年 Cloud 会员感恩计划》，列出 82 位贡献者的 GitHub 账户致谢名单，并给出标准认领步骤。

---

## 6. 标准文案模版

### 6.1 专属感谢邮件文案模版（适用于渠道一）
**邮件主题**：
```text
[TokenTracker] 感谢你的开源贡献：为你送上 1 年 Cloud 会员兑换码
```
**邮件正文**：
```text
Hi @{{login}} ({{name}}),

感谢你对 TokenTracker 的开源贡献！你在 PR #{{latestPrNumber}} ({{latestPrTitle}}) 中贡献的代码，一直稳定运行在许许多多开发者的终端与桌面上。

如你可能已经注意到的，我们近期将原本免费的多端同步功能升级为了收费的 TokenTracker Cloud 云服务。在这里，我想坦诚地与你同步这个决策背后的原因：

随着 TokenTracker 用户规模的迅速扩大，多端高频同步与云端聚合分析的数据用量呈现出爆发式增长。随之而来的服务器计算、数据库存储与边缘带宽成本急剧攀升，每月的账单开销已经远远超出了我个人自费能够承受的极限。为了保证服务的可用性与稳定性，让项目能够长久、健康、可持续地走下去，而不是因为高昂的基础设施开销而被迫停服，我们最终不得不将多端同步升级为商业化的云服务模式。

但无论后续如何发展，我都绝不会忘记一路走来为 TokenTracker 贡献过代码、提交过 PR 的开源伙伴。没有大家的共同维护与付出，TokenTracker 绝不可能成长为今天的样子。因此，我无论如何都要为每一位成功合并过代码的贡献者，免费送上为期 1 年（365 天）的 TokenTracker Cloud 会员权益：

- 专属兑换码: {{code}}
- 权益时长: 365 天（自兑换成功起计算）
- 兑换截止日: {{redeemBefore}} 前有效

兑换方式:
1. 打开 TokenTracker 桌面客户端或登录 Web 控制台;
2. 进入「设置」->「云服务」页面，登录你的账号;
3. 点击「兑换云服务码」，输入上方专属兑换码即可立即激活。

再次由衷感谢你对 TokenTracker 的支持与陪伴。希望全新升级的云服务能够为你的日常编码带来便利，也期待未来能与你在开源社区继续同行！

TokenTracker 维护者 / Rocky
```

### 6.2 PR 留言引导文案模版（适用于渠道二，严禁粘贴明文码）
```text
Hi @{{login}}，再次感谢你为 TokenTracker 贡献的 PR #{{latestPrNumber}}！

如你所见，近期由于用量激增导致服务器成本超出了个人承担极限，我们将多端同步升级为了收费的 Cloud 云服务。但无论如何，我都非常感谢一路为项目贡献代码的开发者。
我们已为你预留了一份专属的 1 年 Cloud 会员兑换码。为防止公开泄露，兑换码未直接贴在此处：
- 若你在 Git 提交中登记了有效邮箱，我们已尝试发送至你的邮箱 ({{preferredEmail}})；
- 若你使用的是隐私邮箱或未收到，欢迎邮件联系我或直接在此回复确认，我们将安全交付你的专属兑换码。
```

### 6.3 社区公开致谢公告模版（适用于渠道三）
```markdown
# 致 TokenTracker 开源贡献者：1 年 Cloud 会员感恩计划

TokenTracker 现已正式推出 Cloud 多端同步与云端服务。在此，我们想坦诚地与大家分享做出收费决定的初衷，并向所有开源贡献者送上专属回馈。

## 为什么云服务会收费？
自 TokenTracker 发布以来，用户规模与多端高频同步用量爆发式增长。随之而来的是高昂的云端数据库、边缘网络与服务器运维开销，账单成本已经远远超出了维护者个人能够无偿承受的范围。为了保证多端同步服务的稳定性与高可用，让项目能够长久、健康、可持续地运转下去，而不是因为资金断裂而关停，我们最终决定将多端同步升级为商业化的 Cloud 会员服务。

## 专属回馈：向所有代码贡献者赠送 1 年会员
开源是 TokenTracker 的立足之本。无论商业化走向何方，我们都绝不会忘记在每一个版本中提交 PR、修复 bug、增添特性的贡献者们。

我们特别为历史上所有提交过 PR 并被合并的代码贡献者准备了专属回馈：**每人免费赠送 1 年 TokenTracker Cloud 会员（365 天时长）**。

### 贡献者致谢名单（共 82 位）
@Hu9956, @LceAn, @fflake33, @paveezheng, @lamther, @Hasasasa, @minh-tg, @Roomen, @csmashe, @eteen12, @D-sudoasd, @obsesivegamer, @Flowm, @kvyb, @arvakme, @duibaix, @shixiaogaoya, @liusaisaia, @omsd512-W, @EncodeTS, @PinkR1ver, @sailesh, @CiprianSpiridon, @wp-x, @pengpengzi, @HandSonic, @LinYYY, @Nemoljy, @wen-shion, @rbatkins, @Fryuni, @fguizc, @FLC-niko, @xiarunjie, @FenjuFu, @kucheryavenkovn, @Aclguh, @san-ren, @carljborg, @Vocllum, @jonasfroeller, @micooz, @GreenNa717, @SayAMDYES, @Albert-Lsk, @FengKeXiang66, @Kooooojun, @lie5860, @Alaric-L, @hygao1024, @JunWeiUp, @The-Minion-oOo, @mohui666, @ingyeomnote, @kymonr, @schalkiii, @xyzs996, @azaleta, @tcvieira, @Gyarados4157, @evolv3ai, @x7peeps, @ZainCheung, @RyoSXu, @Wayneoween, @haixing23, @Freedomziko, @Jacobinwwey, @dxc19961118, @snxq, @singularitti, @lhandal, @sxryadipta, @lbbc-lh, @optiplex331, @Williamhiller, @season179, @ztybyass, @ddnio, @DianP, @EricGrill, @oTTa

### 领取与兑换说明
1. **已登记公开邮箱的贡献者**：专属兑换码已发送至你在 Git 提交中记录的邮箱，请查收；
2. **未收到或使用隐私邮箱的贡献者**：请直接发送邮件至维护者邮箱（注明你的 GitHub ID 与 PR 编号），核验后即可获取专属兑换码；
3. **兑换方式**：登录客户端后进入「设置」->「云服务」，输入兑换码即可立即开通 365 天会员时长。
```

---

## 7. 未来启动发码的完整执行 SOP（步骤清单）

当维护者决定正式启动发放时，只需按以下四步操作：

### 第一步：生成真实批次兑换码（配置生产凭据）
在终端中注入 InsForge 密钥并运行：
```sh
INSFORGE_BASE_URL="https://srctyff5.us-east.insforge.app" \
INSFORGE_SERVICE_ROLE_KEY="<YOUR_SERVICE_ROLE_KEY>" \
node scripts/pro-gift-codes.cjs generate \
  --environment live \
  --days 365 \
  --count 92 \
  --expires "2027-10-11T23:59:59Z" \
  --label "github-contributors-pr-merged-1y" \
  --out ".tmp/contributor-gift-codes.json"
```

### 第二步：执行 1:1 专属分配绑定
```sh
node scripts/contributor-gift-distribution.cjs bind-codes \
  --batch-file .tmp/contributor-gift-codes.json \
  --out-file .tmp/contributor-allocation.json
```
此步骤将生成严密的 1:1 绑定清单，保存在受忽略的本地安全文件 `.tmp/contributor-allocation.json` 中。

### 第三步：校验无重复、无遗漏
```sh
node scripts/contributor-gift-distribution.cjs verify \
  --allocation-file .tmp/contributor-allocation.json
```

### 第四步：导出文案并触达
```sh
node scripts/contributor-gift-distribution.cjs format-messages \
  --allocation-file .tmp/contributor-allocation.json \
  --out-file .tmp/contributor-messages.json
```
根据导出的 `contributor-messages.json`：
- 对 50 位邮箱用户通过邮件发送专属码；
- 对其余 32 位用户发布致谢引导。
