# 大进车贷助手｜工程交接

## 1. 当前生产状态

- 正式 URL：<https://hckleodj.github.io/late-fee-calculator-cn/>
- 当前 release commit：`e63ac63a328a07bba8e5783c4b4ed81eb5c3eff3`
- 发布前/回滚基线：`43fa129a8303f4aa0ef619c167f91755a6184ebd`
- 备份分支：`backup/pre-rc1-release-20260828`
- 状态：稳定生产 / 已归档

## 2. 唯一正式使用环境

正式经营数据只在 **OPPO 系统浏览器**维护。微信内置浏览器已停止作为正式数据源，只可临时查看或计算。禁止在微信与 OPPO 浏览器同时维护两套正式客户数据。

## 3. 正式 localStorage keys

- `lateFeePaymentPlansV1`：客户、合同、还款进度、`payments`、`allocations` 等主业务数据。
- `lateFeeBackupDirtyV1`：旧版未备份标记，升级时继续兼容读取。
- `dajinBackupStateV1`：备份时间、dirty、revision、hash、确认方式及30分钟宽限状态。
- `dajinLocalSnapshotsV1`：当前浏览器内最近10份本地历史快照。

不得擅自改名、迁移或自动初始化这些 key。

## 4. 核心数据保护规则

- 主数据 key 不存在、空白、JSON损坏或结构异常时，进入只读保护；不得自动写入 `[]`、覆盖或清空。
- 客户数据写入必须走现有 revision、dirty、hash 与快照逻辑。
- 下载、复制、分享面板或 API 返回成功，不代表备份已经真实落盘。
- JSON备份必须由用户确认已在文件管理中看到文件，并进行二次确认。
- 最终确认时必须重新核对当前 revision/hash 与备份生成时一致；不一致则拒绝确认。
- 最近10份本地快照与主数据同处一个浏览器，只能用于误删、误改恢复，不能替代外部JSON备份。

## 5. 24小时备份机制

只有 `dirtySinceBackup=true`，并且距上次人工确认备份已满24小时或从未确认备份时，才强提醒并阻断正常业务。没有业务数据变化时，不得仅因时间超过24小时而阻断。

“紧急进入30分钟”只临时解除阻断：不得清除 dirty，不得修改 `lastBackupAt`、备份hash或已备份revision；到期后重新检查。

## 6. 正式备份方案

- 主流程：OPPO系统浏览器下载完整紧凑JSON。
- 文件名：`大进车贷助手备份_YYYY-MM-DD_HHmm.json`。
- 内容至少包含：`app`、`version`、`exportedAt`、`dataRevision`、`checksum`、`plans`。
- `checksum` 使用主业务数据稳定JSON的 SHA-256。
- 下载后由用户在文件管理中确认文件存在，再回到工具人工确认；系统随后复核 revision/hash，只有一致才清除 dirty。

## 7. 历史迁移兼容

- 新迁移格式：`DJINMIG2`，紧凑原始JSON分段。
- 完整单段目标不超过3900个JavaScript字符，硬上限4000；payload容量按实际头部动态计算。
- 每段包含 migrationId、段号/总段数、revision、完整checksum和单段checksum。
- 已通过 OPPO N6 微信复制及 OPPO 浏览器导入实机验收。
- `DJINMIG1`只用于恢复旧 Base64URL 迁移分段，不再作为新迁移默认格式。
- 真实微信→OPPO迁移已经完成；迁移功能现在属于兼容/应急能力，不是日常业务流程。

## 8. 金融公式保护

### 固定月息 / 平息

- `monthlyPayment = loan / terms + loan * monthlyRate`
- `totalInterest = loan * monthlyRate * terms`
- `totalRepayment = loan + totalInterest`

关键回归：`loan=100000`、`monthlyRate=1.29%`、`terms=36`，必须得到：

- `totalInterest=46440.00`
- `totalRepayment=146440.00`
- `monthlyPayment=4067.78`

标准等额本息继续使用现有剩余本金递减公式，并保留月供与本金倒推互逆断言。

### 滞纳金

- `lateFee = due * dailyRate * overdueDays`
- `total = due + lateFee`

关键回归：`due=8222.50`、`dailyRate=0.5%`、`overdueDays=40`，必须得到：

- `lateFee=1644.50`
- `total=9867.00`

任何金融公式修改都必须重新运行上述回归值并完成真机验收。

## 9. 已废弃方案

以下仅为历史记录，不得默认重新启用：

- 微信 WebView 作为正式数据库
- 微信直接下载JSON
- 一次性完整文本复制
- 8KiB Base64URL主迁移方案
- Cloudflare Worker、Durable Objects
- 一次性token云中转、自定义域名中转
- `chatgpt.site`
- 各类测试、压力测试、debug、模拟数据及诊断入口

## 10. 以后升级的强制开发门禁

固定流程：

`需求 → 技术预检 → GO / GO WITH CHANGES / NO-GO → 隔离开发 → 自动化测试 → 主力真机实测 → 发布前审查 → 正式发布`

涉及以下内容时禁止直接修改正式版：localStorage、客户数据结构、数据迁移、备份/恢复、删除、金融公式、云同步、第三方API、登录、支付或架构变化。

发布必须保留可验证回滚点，实际diff只能包含已验收内容；禁止顺手重构或扩展功能。

## 11. 主力验收设备

OPPO N6 是当前正式经营主力设备。移动端文件下载、剪贴板、浏览器存储、恢复和迁移等关键能力，不得仅依据桌面模拟器、API返回或规范判断，必须以 OPPO N6 实机验收结果为最终依据。
