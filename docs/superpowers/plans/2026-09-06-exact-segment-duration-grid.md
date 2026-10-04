# 固定分段时长网格实施计划

> 规格：`docs/superpowers/specs/2026-09-06-exact-segment-duration-grid-design.md`

## 全局约束

- 使用百分之一秒整数做全部网格计算；AI 模式向上对齐，固定模式非整数倍报错。
- 28 秒 / 15 秒必须形成 30 秒总长与严格的 `[0,15]`、`[15,30]` 两段。
- 不裁切、不重复、不遗漏母镜头；所有内部网格点必须是母镜头边界。
- 旧非法计划不得静默迁移；确认或分段时要求重新生成。
- 先写失败测试并观察 RED，再做最小实现；保留无关工作区改动。
- 版本与交付物升级到 0.5.68。

## Task 1：总时长网格纯函数及入口接线

文件：`scripts/appEffects.test.ts`、`src/appEffects.ts`、`src/App.tsx`、`scripts/styles.test.ts`

1. 先增加测试：AI 28/15→30、30/15→30、28/7.5→30、百分之一秒临界、3600 上限、固定 28/15 拒绝。
2. 运行 `npm run test:app-effects`，确认新断言失败。
3. 实现统一的有效总时长解析函数，并在 AI 估时首次完成、“采用建议”和创建正式计划时调用。
4. 固定模式非法时给出最近向上合法值；AI 对齐理由保留原建议与有效值。
5. 更新静态集成断言，运行 `npm run test:app-effects`、`npm run test:styles`、`npm run test:typecheck`。

## Task 2：母分镜硬边界生成、解析和确认

文件：`scripts/llm.test.ts`、`scripts/masterTimeline.test.ts`、`scripts/sequencePlan.test.ts`、`src/services/llm.ts`、`src/masterTimeline.ts`、`src/sequencePlan.ts`、`src/App.tsx`

1. 先增加失败测试：请求包含 15 秒硬边界；跨边界输出触发一次修复；修复后仍非法报错；精确镜头数小于段数时报错；编辑母提示词破坏边界不能确认。
2. 分别运行相应测试并确认 RED。
3. 给母分镜请求和校验上下文增加 `requiredSegmentDurationSec`，生成内部边界列表并写入请求/修复提示。
4. 提取/复用网格校验，保证解析、用户确认、计划校验均拒绝跨边界镜头。
5. 在 App 创建及确认路径传入固定段长；运行母时间轴、LLM、计划和类型测试。

## Task 3：严格固定网格分段与旧计划保护

文件：`scripts/storySegmentation.test.ts`、`scripts/llm.test.ts`、`scripts/sequencePlan.test.ts`、`scripts/workflowFeatures.test.ts`、`src/storySegmentation.ts`、`src/services/llm.ts`、`src/sequencePlan.ts`、`src/App.tsx`

1. 先增加失败测试：30/15 仅接受两段 15 秒；拒绝 16/14、15/13、段数变化、跨段移动镜头；保留共享 beat 的真实来源验证。
2. 运行相关测试并确认 RED。
3. 新界面分段请求只允许 `[segmentDurationSec]`，提示 AI 只能补充固定组元数据。
4. 最终解析/计划验证强制段数、起止网格、精确时长与镜头归属；旧 28/15 计划确认或分段时明确要求重新生成。
5. 替换“软目标/尾段可短”文案；运行分段、LLM、计划、工作流、样式与类型测试。

## Task 4：版本、发布文档、构建与交付

文件：`package.json`、`package-lock.json`、`src/updateLog.ts`、`README.md`、`发布说明-0.5.68.md`、交付相关说明/清单

1. 将版本统一提升到 0.5.68，补充固定网格变更说明和兼容性提示。
2. 运行全部相关稳定测试；记录 `test:long-story-regression` 已知外部样本缺失（若仍复现）。
3. 运行 `npm run build`、`npm run pack:win`、交付脚本和隔离数据目录便携包烟雾测试。
4. 生成/核验便携 EXE、恢复源码包和 SHA-256；不得删除历史交付或用户数据。

## Task 5：官方 H3 全局声景与必要拟音修正

文件：`scripts/promptAdapters.test.ts`、`scripts/promptEngine.test.ts`、`scripts/storage.test.ts`、`scripts/llm.test.ts`、`src/promptAdapters.ts`、`src/promptEngine.ts`、`src/storage.ts`、`src/appEffects.ts`、`src/services/llm.ts`

1. 先增加行为测试并观察 RED：`overall_soundscape` 按时间顺序汇总全部镜头的环境层，不能只取末镜，也不能复制脚步、碰撞、衣料等镜内动作声；无明确配乐时严格输出 `non_diegetic_music: N/A`。
2. 每个具体脚步、碰撞和用户明确写出的轻微衣料声只留在对应 Shot；抬头、转身等无明显发声动作不自动补衣料摩擦或呼吸，走跑所需脚步保留但不默认叠加衣料破风。
3. 删除“动作声一律位于前景”的全局混音要求，改为按声源距离和叙事重要性决定层级；远处瀑布保留为空间环境，次要衣料细节不刻意强化。
4. 默认/保护风格声音不得被适配器自动解释成配乐；只有明确的音乐字段或明确的非保护音乐描述才进入 `non_diegetic_music`。同步默认提示规则，并只迁移字节一致的旧内置预设，保留用户自定义规则。
5. 运行适配器、提示引擎、存储、LLM、应用效果、类型检查和生产构建；把本任务与固定时长网格一起打入 0.5.68。

## 最终审查

1. 对本计划相关 diff 做规格与代码质量审查，修复重要问题。
2. 复跑覆盖改动面的测试、类型检查、生产构建与便携包烟雾测试。
3. 汇报 0.5.68 交付物绝对路径、SHA-256、测试结果及已知无关失败。
