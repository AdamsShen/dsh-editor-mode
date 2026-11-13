# Plans

`/autopilot-on` 在此目录下按 track 生成产物：

```
<slug>/
├── brief.md      需求摘要
├── plan.md       实现方案
└── checklist.md  可勾选清单（进度权威来源）
```

`checklist.md` 中 **行首** 的 `- [ ]` / `- [x]` 是唯一被解析的条目格式；
缩进的补充说明（Paths / Done when / Verify）不会被视为条目。
