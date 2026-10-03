# 2026-10-03 正式发布预检与回滚记录

用户在本轮 N6 隔离测试链接反馈“可以用”，随后明确指令“可以上线用了”。本次授权限定已验收工具箱及车辆出租、收款渠道版本，不涉及新的金融公式或云同步。

- 正式仓库：hckleodj/late-fee-calculator-cn。
- 发布前 main：de65808e051663ac54282d0aa60ce0a792cc5fbc。
- 发布前 Pages 工作流：36994175636，completed/success；对应上述提交。
- 页面 HTTP 状态：当前环境请求正式 URL 返回403，不能独立核验线上内容；使用仓库基线、成功部署记录及完整运行文件校验作可核实证据。
- 发布候选来源：开发仓库 feature/toolbox-workflow-v1，功能提交21aea9fd41a210fe98de40811b187a1f46137d4c（文档后续提交f24fdc7）；N6测试仓库a956f12395ce97db42f088e13faff0caca22cbfa，Pages工作流37110234383已成功。
- 相对正式基线：仅8个已验收运行文件变化。原formal-migration.html及formal-migration-preflight.html逐字节保留，未执行其中的独立迁移操作，未纳入云功能分支。
- 正式存储键不改名、不初始化、不导入测试数据；正式产物无N6前缀、横幅或虚构样例。
- 回滚原版：backup/pre-toolbox-workflow-20261003，指向de65808；仅供尚未产生新业务包/新字段时的审查或恢复，不能写入新数据后切回旧页面继续经营。
- 安全维护回退：backup/toolbox-workflow-maintenance-20261003，a57bfa245d82a1188a59b8ea875682acc6899905。index为既有无脚本的维护页面，不读写浏览器数据，暂停经营写入；数据不回退，修复后发布支持全部新字段的页面。
- 原版与维护分支均已远端fetch核验。维护浏览器加载未改变任何localStorage项。
- 回归：9个Node测试文件全部通过；此前7个浏览器流程覆盖渠道/租电/自动抵扣/减免撤销/出租/证件照片/延期还车/PNG-PDF/隔离存储。正式候选本地390×844虚构浏览器通过旧数组不改写、正式键、客户全额还款、手续费、刷新、实际JSON下载及维护页面无写入。
- 用户真机反馈按“测试版可用及允许上线”记录；未声称逐项旁观全部真机操作，也未代用户确认手机内真实JSON备份落盘。
- 本次发布只替换代码，不读取或上传真实客户/车辆/照片，不替用户执行恢复、迁移或清空。

## 运行文件 SHA-256

- `index.html`：`b99c19c8c494d7a9ce203e188ea582e346616d484d0e9d09b2d45cb229ccdc3e`
- `installment-ledger.js`：`f5a52f82864887faaf676646a41956e4777ca1353f460267d9fb7fc6490e4302`
- `local-snapshots.js`：`00871e97a3f726437f441a5eb04645360b5b72c8ddb724e473ec778af3b5357c`
- `migration-transfer.js`：`b0a57beecb10c783061c7e26efaed05abfb0dddd171acdd1ff065b7bd773372f`
- `rental-document.js`：`6d39c262aba3744d53f1762b65d7d301b8ba3e229424cfa0cdc959e99a52fe5f`
- `rental-export.js`：`243adcc4072e1452e43df218ec7dab91c2adaea3dc353d633ae7afb5a724e25e`
- `rental-ledger.css`：`273d28a0768ae5d867230ac3d3f62107d94cc73d6dbca697ca7627ea5882637f`
- `rental-ledger.js`：`eae9c9b4ffed4aa100e9e3d2dc9452c1b61003b2652c51d758d8a40dbffa6399`
