# Dedicated runtime database roles

[Migration plan](ha-migration.md) · [Handoff rehearsal](database-handoff-rehearsal.md)

**Deployed and qualified at the reduced 25/2 workload on November 15, 2026.**
See [results and remaining gates](experiments/application-roles.md).

Fastify uses a separate `shortlink_app` login on source and HA, with independent
passwords. Database selection remains a separate runtime setting: preparing or
deploying these credentials never selects HA or closes the creation gate.

## Role boundaries

| Account                     | Purpose                                                       | Application pods receive it?                        |
| :-------------------------- | :------------------------------------------------------------ | :-------------------------------------------------- |
| Source `shortener`          | Bootstrap administrator, existing object owner and migrations | Removed when runtime roles are enabled              |
| Source `shortlink_app`      | Runtime link reads and creation                               | Yes, source Secret only                             |
| HA `postgres`               | Operator administration                                       | No                                                  |
| HA `shortlink_lab`          | Existing database/object owner and lab probe                  | Removed from Fastify when runtime roles are enabled |
| HA `shortlink_app`          | Prepared candidate, eventual runtime link reads and creation  | Yes, HA Secret only                                 |
| Source `shortlink_migrator` | Logical publication reader                                    | No                                                  |

The runtime role has CONNECT to `shortener`, USAGE on `public`/`drizzle`,
SELECT/INSERT on `links`, USAGE on its identity sequence, and read-only migration
history access for diagnostics. It owns no database, schema or table; has no
role memberships, administrative attributes, UPDATE, DELETE, TRUNCATE,
permanent DDL, sequence-reset or migration-writing permissions. Grants name the current objects;
future schema migrations must explicitly review any additional runtime grants.
The shared SQL is [application-runtime-role.sql](../deploy/migration/application-runtime-role.sql).

Both databases require TLS/password authentication for this login and reject it
on other databases. Fastify verifies the server certificate against a public CA
and expected DNS name. Database credentials are stored in immutable Kubernetes
Secrets. The source URL includes verified-TLS options; the HA pool receives an
explicit CA and hostname separately. Public CA mounts contain no private key.
Secrets are encoded, not encrypted merely by being Secrets: Kubernetes access
controls and protection of the cluster remain necessary.

The original owner/operator accounts retain their existing privileges and
credentials for maintenance. The source bootstrap superuser cannot be demoted.
Separating the runtime login makes permission fencing possible without changing
ownership or operator access. The HA owner is also removed from application
pods even though it is not a superuser: object ownership permits much more than
runtime INSERT/SELECT.

## Provision, stage, roll out, verify

```sh
# Prepare roles and run read-only/nonmutating permission/authentication probes.
pnpm db:app-roles stage

# After CI publishes the role-aware SHA, stage its native immutable image.
pnpm db:app-roles stage FULL_GIT_SHA

# Run a 90-second rollout qualification at the reduced local workload.
RATE=25 CREATE_RATE=2 REDIRECT_WORKERS=4 CREATE_WORKERS=2 \
  pnpm test:app-role-rollout FULL_GIT_SHA

pnpm db:app-roles verify
```

`stage` creates only owned resources, retains existing passwords on rerun,
reloads source authentication without a Postgres restart, and lets CNPG hot-load
its reviewed authentication rules. CNPG reconciles the HA role/password through
[DatabaseRole](../deploy/db-lab/application-role.yaml) and a private basic-auth
Secret; the operator action applies explicit table/sequence grants separately.
Roles and grants are provisioned independently: logical replication does not
copy role definitions or ACLs. The CNPG role reclaim policy retains the database
role if its Kubernetes object is deleted; deletion is not credential revocation.

`rollout FULL_GIT_SHA` requires a staged published image. One compare-and-swap
Pod-template patch changes the image, both Secret references and public CA
mounts. It removes the source administrator `envFrom` and the old HA owner
Secret. Existing rolling/drain settings are retained. New pods must acknowledge
runtime revision 4, source active, creations accepted and the HA candidate ready.
The command checks actual source and HA sessions use `shortlink_app` over TLS.

The enabled `runtime-application-roles` ConfigMap records nonsecret wiring state.
Local `k8s:up` renders those credential references before applying application
manifests, preventing the base administrator injection from returning on rerun.
The legacy HA-owner preparation command refuses to run once this state exists.
Do not use Kubernetes rollback to a historical Pod template blindly: that can
restore administrator credentials. Roll back application code with an explicitly
reviewed template retaining the dedicated role wiring and compatible HA-user
validation. Old images with a hardcoded `shortlink_lab` candidate check cannot
use the new HA login.

Private evidence is saved under `.kind/db-cluster/application-roles/<UTC>/`.
It compares source Postgres spec/Pod UID, administrator Secret version, HA Pod
UIDs, live sequences and runtime control before/after. It verifies the logical
stream remains active. These commands do not fence the live role, change live
sequences, stop replication, or choose the HA writer.

## Qualification and remaining work

The disposable handoff now uses independent nonsuperuser, nonowner runtime roles
on both databases. It tests real denied operations (including DDL/TRUNCATE and
sequence reset only on disposable databases), demonstrates that an existing
source connection loses INSERT after fencing, and verifies creation/read behavior
after switching to the destination. `HANDOFF_API_IMAGE` may explicitly select a
published SHA-and-digest image to qualify it before changing the live deployment.

The reduced 25/2 workload checks behavior within current Mac memory constraints.
It does not replace the agreed 1,000 redirects/s plus ten creations/s performance
qualification. Live fencing, final catch-up/sequence preparation, an agreed
maintenance window and real writer cutover remain later operator steps.
