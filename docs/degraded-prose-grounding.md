# Grounded degraded prose — bounded offline review

Continues the interrupted batch from `225bd69`; the existing service change, test and fixed scene manifest were retained. The original twelve-case baseline failed all twelve cases: refusal/content-filter fallback replaced every scene with a save/generation explanation. The interrupted implementation still failed four cases because TALK and WAIT receipts reached the generic resolution sentence. This continuation selects speech/wait from the authoritative registered-action receipt; movement, perception and physical fallback reuse existing Core-grounded renderers. No public schema, settlement, retry budget or provider contract changed.

Fixed criteria: [scene matrix](degraded-prose-acceptance.v1.json). Reproducible developer evidence: [service tests](../tests/degraded-prose-grounding.test.ts), [reviewed exact outputs](../tests/__snapshots__/degraded-prose-grounding.test.ts.snap), and the existing HTTP degradation/replay/UI tests. All generation is an offline controlled fixture, not real-provider or human acceptance. The fixed outputs below were read individually for scene readability and factual limits; a passing string assertion alone is not prose-quality acceptance.

| Scene | Reviewed output | Authoritative limit |
|---|---|---|
| Speech | 你向林舟开了口。 | Identifies the actual addressee; adds no reply, agreement or gesture. |
| Movement | 你从中央广场出发，来到街角商店。这段路用了6分钟。 | Names the settled route and elapsed time. |
| Observation | 树影落在石砖上，来往的居民在长椅旁停下脚步。你仔细观察了一会儿，在这次检查范围内暂时没有发现明显异常或新的线索。 | Public authored scenery plus the settled no-discovery check; no hidden notes. |
| Physical failure | 你对林舟发起了尝试，这一次未能建立接触。 | Failed contact remains failure. |
| Physical success | 你的动作触及了林舟。这次动作确实造成了伤害。 | Contact/harm come from the physical receipt, without inferred emotion or intent. |
| Waiting | 你等了3分钟。 | Uses receipt time, without inventing intervening events. |

Both refusal and content-filter cases yield these same bounded outputs. Physical cases retain the already settled witness utterance in typed scene beats, with the existing language/perception checks. All twelve cases also assert degraded presentation, one revision increment and identical saved state on duplicate request without another Narrator call. The private sentinel is absent from prose. Diagnostics remain in presentation/notices.

Verification: original baseline 12 failed; interrupted implementation 8 passed / 4 failed; resumed 12 passed; adjacent final 9 files / 82 passed. Complete isolated build passed (strict TypeScript, client and server). An initial sandboxed HTTP run failed to connect to its ephemeral loopback listener (EACCES); rerunning the unchanged test with loopback access passed 2/2. No production listener was started.

N8.1 has fixed standards and reviewable samples, and N8.3 has bounded developer acceptance for all four required scene types. N8.2 stays open: general composite scenes and explicit unexecuted portions still need broader prose coverage. N8.4 stays unverified because current real-model composition requires authorization. This does not establish N9/N10, broad naturalness, human experience or a current full-suite pass.
