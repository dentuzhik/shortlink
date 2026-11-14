# ClusterCTRL hardware monitoring

Standalone Grafana and Prometheus on the Raspberry Pi 4 controller (`cbridge`).
This complements the Shortlink application's existing monitoring deployment.
The controller and Pi Zero W nodes P1–P4 each run Node Exporter and a small
Raspberry Pi textfile collector. All services start at boot.

Open <http://cbridge.local:3000/d/clusterctrl-hardware> or
<http://192.168.24.113:3000/d/clusterctrl-hardware>.
The login is `admin`; the bootstrap password lives on the controller in
`/etc/grafana/clusterctrl-admin-password` and locally in the Git-ignored,
owner-readable `.kind/clusterctrl/grafana-admin.env`. Do not commit credentials.
If the password is changed in Grafana, the bootstrap file is not updated.

## Dashboard

- Exporter availability for all five machines, with explicit offline states.
- CPU busy/load, available RAM, swap usage and uptime.
- SD-card space, reads/writes and time busy.
- Per-interface RX/TX traffic, errors and drops, plus cumulative USB TX errors.
- A dedicated USB section for P1–P4: interface/carrier status, RX/TX error and
  drop rates, cumulative errors, error increases over the selected time range,
  packet/byte throughput, carrier transitions and link-status history.
- CPU temperatures and current/historical undervoltage and throttling flags.
- Actual fan PWM duty over time, with hottest and smoothed temperatures.
- An XY plot of live temperature/duty breakpoints from `/etc/clusterhat-fan.json`.
- HAT slot power and fan sensor availability, separately from exporter health.

Fan output is commanded PWM duty, not RPM: this fan has no measured tachometer
feed. Startup, hysteresis, smoothing and ramp-down can make the historical duty
differ from the steady-state breakpoints. Fan metrics are read-only; these files
do not modify fan policy. Unavailable sensor readings are omitted, never zeroed.

### Reading the USB panels

USB panels always cover all four controller interfaces independently of the
general machine/interface filters. They work for both RNDIS and NCM images and
remain useful when a node's exporter or SSH stops responding:

| Interface | Pi  | RX direction    | TX direction    |
| --------- | --- | --------------- | --------------- |
| `ethpi1`  | P1  | P1 → controller | Controller → P1 |
| `ethpi2`  | P2  | P2 → controller | Controller → P2 |
| `ethpi3`  | P3  | P3 → controller | Controller → P3 |
| `ethpi4`  | P4  | P4 → controller | Controller → P4 |

The link cards distinguish **INTERFACE ABSENT**, **NO CARRIER**, and **CARRIER
PRESENT**. An interface can have carrier while packets/SSH still fail. Raw USB
boot enumeration can also exist without an Ethernet interface. If the controller
exporter or its netclass collector is unavailable, the cards show **NO
TELEMETRY** rather than an apparently absent or healthy link.

Use error/drop **rates** to see ongoing failures. Cumulative counters include
past failures and can reset on reboot or interface re-creation. The selected
range panels use Prometheus `increase()` and account for observed resets;
estimates can be fractional because samples are extrapolated to range bounds.
Missing interface counters remain gaps/unavailable, never fabricated zeroes.
These are driver-reported errors, not a measured packet-loss percentage; error
counts can exceed successful packet counts. Carrier changes include startup and
re-enumeration, so compare them with the link timeline and traffic.
USB descriptor/address/enumeration failures that occur before an `ethpi*`
interface exists, and unrelated kernel faults, are outside these network packet
counters. Check the kernel journal for their detailed causes.

Metrics start when collection is installed; historical data is not backfilled.
Scrapes occur every 15 seconds; Pi-specific metrics update every 10 seconds.
Prometheus keeps up to **30 days / 4 GB**, whichever limit is reached first.
Prometheus listens on loopback only; authenticated Grafana serves the local IPv4
network on port 3000. Node exporters serve local IPv4 interfaces on port 9100;
the controller exporter is loopback-only. There is no external telemetry service.

## Deploy or update

Use an SSH agent containing the existing `dentuzhik` key, passwordless sudo on the
Pis, and independently verified SSH host keys. Scripts use strict host-key
checking and the normal `SSH_AUTH_SOCK`, bypassing a per-host 1Password agent.
Use `--known-hosts` and `--key` if your paths differ from their defaults.

```sh
cd deploy/monitoring/clusterctrl
python3 build-dashboard.py
pnpm exec biome format --write grafana-dashboard.json targets.json
python3 test-hardware.py
python3 fetch-exporter.py arm64
python3 deploy-controller.py --binary .cache/arm64/node_exporter --install-packages
python3 fetch-exporter.py armv6
python3 deploy-agent.py p1 p1.local --binary .cache/armv6/node_exporter
python3 deploy-agent.py p2 p2.local --binary .cache/armv6/node_exporter
python3 deploy-agent.py p3 p3.local --binary .cache/armv6/node_exporter
python3 deploy-agent.py p4 p4.local --binary .cache/armv6/node_exporter
```

Original Pi Zero W boards require the ARMv6 exporter, not ARM64 or ARMv7. The
downloader verifies the official release's SHA-256 before extracting its binary.
The `.cache` binaries are ignored by Git. The controller needs Debian's
`curl`, `gnupg`, and `ca-certificates` packages before initial package setup.

`targets.json` records the observed USB DHCP addresses. Reserve those leases on
the router or update the file if addresses change. Prometheus reloads file-based
targets automatically. For example P2's target is currently `192.168.24.114:9100`.
The `node` and `role` labels remain stable independently of the address.

To update just the dashboard, copy `grafana-dashboard.json` to
`/var/lib/grafana/dashboards/clusterctrl/hardware.json` on the controller;
Grafana polls provisioning files every 30 seconds. The generator and generated
JSON are both committed. Service/config changes can use the deployment scripts;
omit `--install-packages` on subsequent controller deployments. Existing
Prometheus and Grafana configuration files are backed up once with the suffix
`.before-clusterctrl`.

## Inspect and troubleshoot

```sh
ssh dentuzhik@cbridge.local
systemctl status grafana-server prometheus clusterctrl-node-exporter
systemctl status clusterctrl-hardware-metrics.timer
curl -fsS http://127.0.0.1:9090/api/v1/targets
curl -fsS http://127.0.0.1:9100/metrics
sudo journalctl -k --since '10 minutes ago'
```

An offline exporter can mean a node is off, a USB link has failed, or its
collector is not installed/reachable. A HAT power LED alone does not establish
OS/network health. Existing RNDIS/USB enumeration and transmit stalls are
visible in availability gaps and controller `ethpi*` error counters; installing
this dashboard does not repair that underlying hardware/network issue.

The controller runs `collect-hardware.py` as a brief root oneshot for
`vcgencmd`/HAT status access. Node Exporter itself uses a systemd dynamic user and
a 96 MB memory limit; Prometheus has a 768 MB limit. The custom collector only
reads fan state/policy and writes atomic `.prom` files.
