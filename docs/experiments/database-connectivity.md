# Cross-VM database connectivity: November 14, 2026

[Procedure and network diagram](../database-connectivity.md)
· [Migration plan](../ha-migration.md)

**Result:** the existing application's Kubernetes cluster can connect over the
private VM network to the disposable CloudNativePG primary, validate its TLS
identity, authenticate, write and read a fixture, and observe it on both standbys.
The live application still uses its original database.

The previous switchover work was committed as `dd49f69` before implementation.
Connectivity changes are a separate uncommitted review increment on that baseline.

## Recorded path

- Application VM `default`, context `colima`, private IP `192.168.5.1`.
- Database VM `shortlink-db`, context `colima-shortlink-db`, private IP
  `192.168.5.3`; both already used Lima `user-v2` networking.
- Application Service `db-lab-primary`, ClusterIP `10.96.43.202`, port 5432;
  EndpointSlice targets database VM port 15432.
- HAProxy 3.4.7, pinned to digest
  `sha256:b9fe316f718d5015c5cfebd8ca019591f3e44656f61d93cb8b59a1028961e530`,
  forwards to the three kind workers' NodePort 30432.
- CloudNativePG-managed `shortlink-lab-external` selects the primary. During
  verification that was `shortlink-lab-1`, pod IP `10.246.3.2`.
- Database role `shortlink_lab`, nonsuperuser; verified TLS; synchronous commit
  `on`, requiring one standby.

Neither VM was restarted. No database pod restart was needed for certificate/HBA
reloads: instance restart counts remained 2, 2, 1. No Mac listener on port 15432
was present in the post-setup check. The bridge logs showed the actual permitted
application VM address; no credentials or SQL payloads are logged there.

## Verification

Setup and checks completed successfully:

| Check                                                     | Result                                   |
| :-------------------------------------------------------- | :--------------------------------------- |
| Valid TLS connection to recorded primary                  | Passed                                   |
| Exact fixture write/read                                  | Passed                                   |
| Fixture present on both standbys                          | Passed                                   |
| Plaintext connection                                      | Rejected, `28000`                        |
| Incorrect hostname routed to the same endpoint            | Rejected, `ERR_TLS_CERT_ALTNAME_INVALID` |
| Untrusted CA                                              | Rejected, `SELF_SIGNED_CERT_IN_CHAIN`    |
| Incorrect password                                        | Rejected, `28P01`                        |
| Source Fastify Deployment specification hash before/after | Identical                                |
| Sampled source API readiness and UI responses             | `200`                                    |
| Temporary Pod, ConfigMap and credential Secret cleanup    | Passed                                   |
| Repeat setup with identical configuration                 | Existing bridge reused                   |
| Existing `pnpm db:lab:check` regression check             | Passed                                   |

Two complete connectivity runs passed, at 18:24:07 and 18:26:18 UTC. The latter
followed a repeat setup. The separate healthy-path replication check at
18:26:23 UTC also passed its host/guest resource gates: normal Mac pressure and
about 57% database-VM available memory.

Retained evidence:

- `.kind/db-cluster/connectivity-setup/2026-11-14T18-26-16-554Z/result.json`.
- `.kind/db-cluster/connectivity-checks/2026-11-14T18-24-07-244Z/`.
- `.kind/db-cluster/connectivity-checks/2026-11-14T18-26-18-192Z/`.
- `.kind/db-cluster/checks/2026-11-14T18-26-23-528Z/result.json`.

Initial setup attempts exposed configuration-file permissions and an invalid
EndpointSlice label value; those failures were retained and corrected. The first
probe's hostname-negative case also failed as a test: overriding TLS `servername`
did not change the actual hostname used by the pg driver. The corrected fixture
uses an incorrect hostname mapped to the same endpoint. The original failed
probe remains in `connectivity-checks/2026-11-14T18-23-10-487Z/`; it is not counted
as a passing verification.

## Limits

These checks establish connectivity, TLS/authentication behavior and fixture
replication. They do not demonstrate this path during worker failure, a primary
switchover, bridge replacement, credential rotation or sustained traffic. Static
VM endpoint mapping and the bridge remain lifecycle dependencies.

No existing links were copied and no application pools were redirected. Source
replication preparation and migration remain the next increment.
