# System execution failures

System tool execution must not turn a thrown technical failure into an ordinary
successful response. A module write may have committed even when its storage
response throws. The module tool logs its diagnostic and propagates the error;
the enclosing session marks itself failed and propagates it too.

The HTTP input coordinator then uses its existing prepared child transactions and
authoritative Core receipts to report committed progress or a safe failure. It
does not rerun the module operation. Duplicate input and restart retain that
terminal response. The session queue recovers from rejection so a later independent
request can execute. Explicitly returned clarification, confirmation and structured
outcome values continue to use their existing contracts.

The new tests cover world-write before/after failures through real System module
execution and temporary HTTP/Core/JsonStore, duplicate POST and restart. They also
verify that a rejected session does not poison the next request. This is not proof
for every System tool, non-transactional configuration write, process kill or
cross-process concurrency. No public Schema or Claude-side change is required.
