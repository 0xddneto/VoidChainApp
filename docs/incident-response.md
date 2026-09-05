# Incident response

## Trigger

Treat unexpected ownership, mint supply, VOID custody, oracle freshness,
Paymaster reserve, sponsored-call failures, unrecognized application gateways
or mismatched explorer bytecode as a protocol incident.

The scheduled `testnet-monitor` workflow is the first independent availability
alarm. A failed run must be investigated; rerunning it until green is not an
incident response.

## Immediate actions

1. Stop the public relayer and keeper credentials in the hosting environment.
2. Preserve RPC responses, transaction hashes, blocks, logs and the deployed
   manifest. Never paste keys into the incident record.
3. Keep VoidScan read-only. Publish a clear testnet incident banner; do not hide
   the affected state or silently redirect users to an older deployment.
4. If an administrative change is needed, schedule the exact calldata through
   `VoidProtocolTimelock`. Record the operation ID and its execution time.
5. Reproduce against a fork, add a regression test, run the full suite and have
   the patch reviewed before execution.
6. Inspect `relay_requests` for duplicate or abnormal wallet/client-hash rates.
   Preserve rows as evidence; never publish client hashes or database exports.

## Recovery gate

Recovery requires verified bytecode, a clean V11 audit, reconciled liabilities,
successful sponsored actions from a disposable wallet, healthy RPC fallbacks,
updated manifests and public documentation of what changed. Rotate any secret
that may have been exposed; transferring funds alone does not rotate a key.

There is no promise that testnet state will be permanent. Mainnet must add a
multisig proposer, independent monitoring, an external audit and a documented
user-notification channel.
