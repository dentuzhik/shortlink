#!/usr/bin/env python3
"""Provision the standalone ClusterCTRL monitoring stack over SSH."""
import argparse
import io
from pathlib import Path
import subprocess
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--host',default='cbridge.local')
parser.add_argument('--binary',type=Path,required=True)
parser.add_argument('--key',type=Path,default=Path.home()/'.ssh/clusterctrl-dentuzhik')
parser.add_argument('--known-hosts',type=Path,default=Path.home()/'.ssh/known_hosts')
parser.add_argument('--install-packages',action='store_true')
args = parser.parse_args()
base = Path(__file__).resolve().parent
ssh = ['ssh','-i',str(args.key),'-o','IdentityAgent=SSH_AUTH_SOCK','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(args.known_hosts),'dentuzhik@'+args.host]
if args.install_packages:
    code = '''from pathlib import Path
import subprocess,urllib.request
Path('/etc/apt/keyrings').mkdir(exist_ok=True)
key=Path('/etc/apt/keyrings/grafana.asc')
key.write_bytes(urllib.request.urlopen('https://apt.grafana.com/gpg-full.key',timeout=30).read())
key.chmod(0o644)
subprocess.run(['gpg','--show-keys',str(key)],check=True)
Path('/etc/apt/sources.list.d/grafana.list').write_text('deb [signed-by=/etc/apt/keyrings/grafana.asc] https://apt.grafana.com stable main\\n')
subprocess.run(['apt-get','update'],check=True)
subprocess.run(['env','DEBIAN_FRONTEND=noninteractive','apt-get','install','-y','--no-install-recommends','grafana','prometheus'],check=True)
'''
    subprocess.run(ssh+['sudo -n python3 -'],input=code.encode(),check=True)
subprocess.run(ssh+['sudo -n mkdir -p /opt/clusterctrl-monitoring'],check=True)
content = io.BytesIO()
with tarfile.open(fileobj=content,mode='w:gz') as tar:
    for name in ['collect-hardware.py','install-agent.py','build-dashboard.py','grafana-dashboard.json','prometheus.yml','targets.json','install-controller.py']:
        tar.add(base/name,arcname=name)
    tar.add(args.binary,arcname='node_exporter')
subprocess.run(ssh+['sudo -n tar -xzf - -C /opt/clusterctrl-monitoring'],input=content.getvalue(),check=True)
for command in ['sudo -n python3 /opt/clusterctrl-monitoring/install-agent.py cbridge','sudo -n python3 /opt/clusterctrl-monitoring/install-controller.py']:
    subprocess.run(ssh+[command],check=True)
