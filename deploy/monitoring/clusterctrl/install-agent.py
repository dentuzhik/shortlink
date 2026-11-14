#!/usr/bin/env python3
"""Run as root with the verified node_exporter binary and collector beside this file."""
from pathlib import Path
import os
import shutil
import subprocess
import sys

base = Path(__file__).resolve().parent
node = sys.argv[1]
assert node in ['cbridge', 'p1', 'p2', 'p3', 'p4']
assert Path('/etc/hostname').read_text().strip() == node
assert b'Raspberry Pi' in Path('/proc/device-tree/model').read_bytes()
target = Path('/usr/local/lib/clusterctrl-monitoring')
target.mkdir(parents=True, exist_ok=True)
for name in ['node_exporter', 'collect-hardware.py']:
    shutil.copyfile(base/name, target/name)
    (target/name).chmod(0o755)
    os.chown(target/name, 0, 0)
Path('/var/lib/clusterctrl-node-exporter').mkdir(mode=0o755, exist_ok=True)
listen = '127.0.0.1:9100' if node == 'cbridge' else '0.0.0.0:9100'
collectors = ['cpu', 'cpufreq', 'loadavg', 'meminfo', 'filesystem', 'diskstats', 'netdev', 'netclass', 'netstat', 'stat', 'uname', 'time', 'thermal_zone', 'hwmon', 'vmstat', 'textfile']
flags = ' '.join('--collector.' + c for c in collectors)
Path('/etc/systemd/system/clusterctrl-node-exporter.service').write_text(f'''[Unit]
Description=ClusterCTRL hardware metrics exporter
After=network.target
[Service]
DynamicUser=yes
ExecStart={target}/node_exporter --web.listen-address={listen} --collector.disable-defaults {flags} --collector.textfile.directory=/var/lib/clusterctrl-node-exporter
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
MemoryMax=96M
[Install]
WantedBy=multi-user.target
''')
Path('/etc/systemd/system/clusterctrl-hardware-metrics.service').write_text(f'''[Unit]
Description=Collect Raspberry Pi and ClusterHAT hardware state
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 {target}/collect-hardware.py
TimeoutStartSec=15
''')
Path('/etc/systemd/system/clusterctrl-hardware-metrics.timer').write_text('''[Unit]
Description=Refresh Raspberry Pi hardware metrics
[Timer]
OnBootSec=10
OnUnitActiveSec=10
AccuracySec=1
[Install]
WantedBy=timers.target
''')
for command in [
    ['systemctl', 'daemon-reload'],
    ['systemctl', 'start', 'clusterctrl-hardware-metrics.service'],
    ['systemctl', 'enable', '--now', 'clusterctrl-hardware-metrics.timer', 'clusterctrl-node-exporter.service'],
    ['systemctl', 'restart', 'clusterctrl-node-exporter.service'],
]:
    subprocess.run(command, check=True)
print('Hardware exporter installed:', node, listen)
