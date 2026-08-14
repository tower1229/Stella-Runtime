---
status: accepted
---

# Generation Consumption is Runtime, not instance glue

Runtime 0.2.0 owns the coherent `/v2` Contract Set, Generation Builder, Binding
Compiler, Markdown Projection, public State mutation interfaces, Authority
Admission protocol, OpenClaw Consumption Adapter, and complete `sync` Barrier.
These capabilities close the generic path from Active Generation to an Eligible
Run and must not be reimplemented by a consumer.

CangHai remains a thin Instance Integration: it owns private Authority and
legacy normalization, Instance Runtime Config and paths, its independent Public
Corpus Adapter, Git Publishing Adapter, host version pin, Instance Cutover Plan,
and real-instance acceptance. Runtime supplies the deterministic Bootstrap
Projection renderer; CangHai's migration plan requires deployment of `USER.md`
and `MEMORY.md` matching the target Generation, and those files never become a
second Authority.
