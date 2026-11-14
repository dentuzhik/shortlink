#!/usr/bin/env python3
"""Upload a verified ARMv6 exporter and install it on one Pi Zero over SSH."""
import argparse
import io
from pathlib import Path
import subprocess
import tarfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('node', choices=['p1','p2','p3','p4'])
parser.add_argument('host')
parser.add_argument('--binary', type=Path, required=True)
parser.add_argument('--key', type=Path, default=Path.home()/'.ssh/clusterctrl-dentuzhik')
parser.add_argument('--known-hosts', type=Path, default=Path.home()/'.ssh/known_hosts')
parser.add_argument('--host-key-alias')
args = parser.parse_args()
base = Path(__file__).resolve().parent
ssh = ['ssh','-i',str(args.key),'-o','IdentityAgent=SSH_AUTH_SOCK','-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(args.known_hosts)]
if args.host_key_alias:
    ssh += ['-o','HostKeyAlias='+args.host_key_alias]
ssh += ['dentuzhik@'+args.host]
subprocess.run(ssh+['sudo -n mkdir -p /opt/clusterctrl-monitoring-agent'],check=True)
content = io.BytesIO()
with tarfile.open(fileobj=content,mode='w:gz') as tar:
    for path,name in [(args.binary,'node_exporter'),(base/'collect-hardware.py','collect-hardware.py'),(base/'install-agent.py','install-agent.py')]:
        tar.add(path,arcname=name)
subprocess.run(ssh+['sudo -n tar -xzf - -C /opt/clusterctrl-monitoring-agent'],input=content.getvalue(),check=True)
subprocess.run(ssh+['sudo -n python3 /opt/clusterctrl-monitoring-agent/install-agent.py '+args.node],check=True)
