#!/usr/bin/env python3
"""Provision the local Grafana/Prometheus services after package installation."""
from pathlib import Path
import grp
import json
import os
import pwd
import secrets
import shutil
import subprocess

base = Path(__file__).resolve().parent
assert Path('/etc/hostname').read_text().strip() == 'cbridge'
for path in [Path('/etc/prometheus/prometheus.yml'), Path('/etc/grafana/grafana.ini')]:
    backup = path.with_suffix(path.suffix + '.before-clusterctrl')
    if path.exists() and not backup.exists():
        shutil.copy2(path, backup)
shutil.copyfile(base/'prometheus.yml', '/etc/prometheus/prometheus.yml')
subprocess.run(['promtool', 'check', 'config', '/etc/prometheus/prometheus.yml'], check=True)
prometheus = pwd.getpwnam('prometheus')
data = Path('/var/lib/prometheus/clusterctrl'); data.mkdir(exist_ok=True)
os.chown(data, prometheus.pw_uid, prometheus.pw_gid)
dropin = Path('/etc/systemd/system/prometheus.service.d'); dropin.mkdir(exist_ok=True)
(dropin/'clusterctrl.conf').write_text('''[Service]
ExecStart=
ExecStart=/usr/bin/prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/var/lib/prometheus/clusterctrl --storage.tsdb.retention.time=30d --storage.tsdb.retention.size=4GB --storage.tsdb.wal-compression --web.listen-address=127.0.0.1:9090
MemoryMax=768M
''')
password = Path('/etc/grafana/clusterctrl-admin-password')
if not password.exists():
    password.write_text(secrets.token_urlsafe(32))
password.chmod(0o640); os.chown(password, 0, grp.getgrnam('grafana').gr_gid)
dashboard_dir = Path('/var/lib/grafana/dashboards/clusterctrl'); dashboard_dir.mkdir(parents=True, exist_ok=True)
shutil.copyfile(base/'grafana-dashboard.json', dashboard_dir/'hardware.json')
Path('/etc/grafana/grafana.ini').write_text('''[server]
http_addr = 0.0.0.0
http_port = 3000
domain = cbridge.local
[security]
admin_user = admin
admin_password = $__file{/etc/grafana/clusterctrl-admin-password}
[users]
allow_sign_up = false
[auth.anonymous]
enabled = false
[analytics]
reporting_enabled = false
[dashboards]
default_home_dashboard_path = /var/lib/grafana/dashboards/clusterctrl/hardware.json
''')
for kind in ['datasources','dashboards']:
    (Path('/etc/grafana/provisioning')/kind).mkdir(parents=True, exist_ok=True)
Path('/etc/grafana/provisioning/datasources/clusterctrl.yaml').write_text(json.dumps({'apiVersion':1,'datasources':[{'name':'ClusterCTRL Prometheus','uid':'clusterctrl-prometheus','type':'prometheus','access':'proxy','url':'http://127.0.0.1:9090','isDefault':True,'editable':False,'jsonData':{'timeInterval':'15s','httpMethod':'POST'}}]},indent=2))
Path('/etc/grafana/provisioning/dashboards/clusterctrl.yaml').write_text(json.dumps({'apiVersion':1,'providers':[{'name':'clusterctrl','folder':'ClusterCTRL','type':'file','disableDeletion':False,'allowUiUpdates':False,'updateIntervalSeconds':30,'options':{'path':str(dashboard_dir)}}]},indent=2))
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now','prometheus','grafana-server'],check=True)
subprocess.run(['systemctl','restart','prometheus','grafana-server'],check=True)
print('Grafana: http://cbridge.local:3000/d/clusterctrl-hardware')
print('Admin password is stored in /etc/grafana/clusterctrl-admin-password; never commit it.')
