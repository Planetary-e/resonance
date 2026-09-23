# v0.3 volunteer churn harness

Run from the repository root:

```sh
npm run test:churn
```

The command runs three local integration scenarios in one Vitest worker. The main scenario starts a directly reachable controller and five `outbound-only` volunteers. Each volunteer initiates an authenticated relay link, and the controller selects all five over those reverse links. A TCP proxy carries one volunteer's link so the test can sever it without taking that volunteer's client mailbox offline.

The main schedule is deterministic even though ports and relay identities vary between runs:

1. Publish a matching pair and wait for five current signed replica receipts and one encrypted notice on every volunteer.
2. Partition one volunteer's controller link. Stop a second volunteer abruptly. Confirm that three links remain and an isolated volunteer still serves its existing notice.
3. Publish another record and confirm three signed receipts. Search from the isolated volunteer and confirm it cannot see the new record. Acknowledge the first notice on that volunteer.
4. Erase the stopped volunteer's operation journal, restart it with the same infrastructure identity, and wait for publication and mailbox repair.
5. Heal the partition. Confirm five receipts for the later record, search success, and convergence of the acknowledgement across the controller and all five volunteers.
6. Stop the controller abruptly. Search the retained record directly on a volunteer while the controller is offline. Restart the controller from its journal and confirm all five links and receipt-confirmed placements return.

The `volunteer_churn_measurement` JSON log records milliseconds for partition detection, repair after the empty-journal restart, repair after the link heals, controller-offline search, controller restart, and search after recovery. It also records `minimumReceiptsDuringOutage`, which must be three in this schedule. A missing search during isolation is expected and its latency is recorded. The assertions require convergence within the test's bounded waits and a healed search under five seconds; the reported timings are observations, not service-level guarantees.

The other two scenarios verify reverse-link placement against five approved volunteers while excluding a sixth, and replacement of an unavailable target by an eligible spare. All sockets run on loopback. This harness does not model real NAT devices, independent operators, Internet latency, prolonged power loss, or statistically representative churn. Repeat it across machines and realistic volunteer networks before using its timing observations as availability evidence.
