#!/usr/bin/env python3
"""Download one official Node Exporter binary and verify its published checksum."""
import argparse
import hashlib
import io
from pathlib import Path
import tarfile
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('architecture', choices=['arm64','armv6'])
parser.add_argument('--version', default='1.12.1')
args = parser.parse_args()
name = f'node_exporter-{args.version}.linux-{args.architecture}.tar.gz'
base = f'https://github.com/prometheus/node_exporter/releases/download/v{args.version}/'
checks = urllib.request.urlopen(base+'sha256sums.txt',timeout=30).read().decode()
expected = next(line.split()[0] for line in checks.splitlines() if line.split()[-1].lstrip('*')==name)
content = urllib.request.urlopen(base+name,timeout=120).read()
assert hashlib.sha256(content).hexdigest()==expected, 'Release checksum mismatch'
with tarfile.open(fileobj=io.BytesIO(content),mode='r:gz') as tar:
    member = next(m for m in tar.getmembers() if m.isfile() and m.name.endswith('/node_exporter'))
    binary = tar.extractfile(member).read()
directory = Path(__file__).resolve().parent/'.cache'/args.architecture
directory.mkdir(parents=True,exist_ok=True)
p = directory/'node_exporter'; p.write_bytes(binary);p.chmod(0o755)
print('Verified exporter:',p)
