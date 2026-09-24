## Entity assets

按下方 entity block 操作。读用 `read`,写先问用户,引用附 `<evo-asset-citation>` (相对 entity 根)。

- 读: 看完 catalog 再决定开哪个文件,`read` offset/limit 截段。
- 写: 写到 entity block 末尾的 inbox 路径,首行 tag 按 entity 规则。
- 不直写 `craft/` / `standing.md` —— Phase 2 consolidation 改写。
- 工具: `read` / `write` / `replace`。**不要** `experience_*` legacy 工具。
- 找不到 → 停,不硬猜。
