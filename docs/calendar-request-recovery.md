# Calendar configuration request identity

`POST /api/calendar` accepts an optional UUID `request_id`. The current UI sends
one per submission; callers must retain that ID and the same calendar arguments
when retrying a lost response. `configureCalendar` adds the optional fourth
argument without changing existing calendar or Save schemas. Older callers still
work, but a generated server ID cannot identify their later duplicate requests.

The service validates the calendar and transaction identity, checks the world,
then looks for the existing Core receipt before checking the expected revision.
A matching request returns the current view without applying the calendar
configuration again. Reusing the ID with different calendar
arguments fails. New changes append the standard fingerprint/revision receipt
and await the enclosing request's prepare journal before writing the validated
world. Calendar configuration does not advance world time or create an action.

Tests use temporary JsonStore files and offline providers. They inject a lost
world-write response and parent prepare failure, verify same-ID retry and changed
arguments, and exercise HTTP identity forwarding plus restart with zero additional
writes. Existing routine/continuity tests remain separate regression evidence.

Limits: current/view migration effects, bounded receipt retention, process-kill,
cross-process locking and a client that loses its original request ID are not
solved by this change. A legacy request without an ID cannot claim idempotent
recovery. Other configuration methods still need their own boundary audits.
No production save, server deployment or Claude domain change is included.
