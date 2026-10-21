下列场景未通过校验。只修改列出的场景，其他场景保持不变。
逐条解决问题，不要引入新问题。只输出修改后的场景（YAML 列表），不要输出整个批次，不要解释。

[问题单]
{{problems}}

[原场景]
{{scenes}}

[硬规则]（每一条都曾经让整批失败，改完逐条自查）
- comic 每格最多 2 个气泡；每个 panel 必须有 shot / actors / bubbles。
- pick 与 chat 的选项里恰好一个 correct: true；干扰项不得与答案是同一条目的不同形式。
- pick 必须有 feedback.on_correct 与 feedback.on_wrong；chat 必须有 reply（含选项与 on_correct / on_wrong）。
- evidence 只能写在有交互的场景上（pick / swipe / chat），不得写 exposure；chat 带 evidence 时必须同时有 reply。
- 具名 effect 一旦在 effects 里声明，就必须在本场景的 ink 或交互里被引用。
- 素材引用必须存在于素材清单；组合角色键值必须在角色规格表内。
- 世界状态改变只能写在 effects 里；canon 事实不可改写。
- 新条目在 brief 里标记为 introduce 时，本批只能以 uses 出现，不能出现在 evidence 里。

[相关约束]
- avoid_before_test（检测之前不得出现的形式）：{{avoid_before_test}}
