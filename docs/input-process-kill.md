# Independent HTTP request process-kill evidence

Product source: `885d1e7`; parent checkpoint: `2d87d8e`. This batch adds tests only.

The missing evidence was an actual independent process interruption, rather than an exception injected into a live service. The first six WAIT cases already passed; this batch reproduces the same interruption matrix for a real purchase and a Core-owned random physical attempt. No production defect was established and no product hook was added.

`tests/input-process-kill.test.ts` forks the offline fixture `tests/fixtures/input-kill-worker.ts`, starts the real `/api/input` HTTP route on an OS-assigned loopback port, and kills only that child with SIGKILL. Each case uses a disposable JsonStore initialized from the public demo. A test-only store subclass pauses immediately before/after pending persistence, before/after the complete canonical write, and before/after the durable HTTP terminal record. It does not replace settlement or write fabricated recovery receipts.

| Actual original request | Checks after kill and restart |
|---|---|
| 等一分钟 | Zero or one minute and WAIT receipt, matching the canonical-write boundary |
| 买一个面包 | Zero or one BUY child receipt; player 100→92 credits, shop 1000→1008, bread stock 10→9, player inventory 0→1 only after commit |
| 尝试打击林舟 | Real Core random rolls in the committed resolution history and receipt agree; the original child transaction identity survives recovery |

Before the canonical write, the complete old image remains authoritative. Status reports `unknown/server_interrupted`; resubmitting the same original request returns 409 with `do_not_replay`. After the write, status reports completed request recovery with the committed receipt identity. This status does not imply every original goal is complete: when the terminal HTTP response is missing, the recovered outcome is bounded committed progress. Resubmission returns the same recovered or saved result. A new JsonStore, GameService and HTTP app perform recovery, with zero model requests, zero new RNG events and byte-identical canonical save after status and replay.

Initial WAIT evidence: 6/6 passed. Resource extension: 12/12 passed. RNG extension: 18/18 passed. First adjacent regression: 69/71, with two BUY cases reporting only `fetch failed`; the original report is retained and the precise cause was not established. The test now closes HTTP connections to killed processes and includes nested error details. Final adjacent regression: 6 files, 71/71 passed; complete isolated strict/client/server build passed. These runs overlap. No paid provider is involved; offline Semantic/Planner proposals are controlled inputs, not general language-quality evidence.

R6.4 remains unverified: this covers three synchronous request paths and six explicit API boundaries, not the full pending/background-job/asynchronous matrix. The pauses surround completed atomic file APIs, not an interruption inside rename or a power-loss/fsync guarantee. R9 multi-writer/migration races, R7 extension child processes, and the unexplained historical native test crash remain separate open boundaries. No acceptance scope or score changes.
