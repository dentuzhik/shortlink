#!/usr/bin/env python3
"""Read Raspberry Pi/ClusterHAT state; atomically publish Node Exporter metrics."""
import json
import math
import os
from pathlib import Path
import subprocess
import time


def collect(root=Path('/'), runner=subprocess.run, now=None):
    now = time.time() if now is None else now
    lines = []

    def metric(name, value, labels=None):
        if value is None or not math.isfinite(float(value)):
            return
        suffix = ''
        if labels:
            suffix = '{' + ','.join(k + '=' + json.dumps(str(v)) for k, v in labels.items()) + '}'
        lines.append(f'{name}{suffix} {float(value):.17g}')

    try:
        metric('rpi_temperature_celsius', int((root/'sys/class/thermal/thermal_zone0/temp').read_text()) / 1000)
    except (OSError, ValueError):
        pass
    try:
        result = runner(['/usr/bin/vcgencmd', 'get_throttled'], capture_output=True, text=True, timeout=3, check=True)
        bits = int(result.stdout.strip().split('=')[1], 16)
        for name, bit in [('undervoltage', 0), ('frequency_capped', 1), ('throttled', 2), ('soft_temperature_limit', 3)]:
            metric('rpi_' + name, bool(bits & (1 << bit)))
            metric('rpi_' + name + '_since_boot', bool(bits & (1 << (bit + 16))))
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        pass

    status_path = root/'run/clusterhat-fan/status.json'
    if status_path.exists():
        try:
            state = json.loads(status_path.read_text())
            age = max(0, now - state['updated_unix'])
            metric('clusterhat_fan_status_age_seconds', age)
            metric('clusterhat_fan_status_fresh', age < 15)
            if age < 15:
                metric('clusterhat_fan_duty_percent', state.get('duty_percent'))
                metric('clusterhat_fan_hottest_temperature_celsius', state.get('temperature_c'))
                metric('clusterhat_fan_filtered_temperature_celsius', state.get('filtered_temperature_c'))
                metric('clusterhat_fan_fault', bool(state.get('fault')))
                for node, value in state.get('temperatures_c', {}).items():
                    metric('clusterhat_fan_sensor_available', value is not None, {'sensor': node})
                    metric('clusterhat_fan_sensor_temperature_celsius', value, {'sensor': node})
        except (OSError, ValueError, KeyError, TypeError):
            metric('clusterhat_fan_status_fresh', 0)

    policy_path = root/'etc/clusterhat-fan.json'
    if policy_path.exists():
        try:
            policy = json.loads(policy_path.read_text())
            for temperature, duty in policy['curve']:
                metric('clusterhat_fan_curve_duty_percent', duty, {'temperature_c': temperature})
            metric('clusterhat_fan_full_temperature_celsius', policy['full_temperature_c'])
        except (OSError, ValueError, KeyError, TypeError):
            pass
    tool = root/'usr/sbin/clusterctrl'
    if tool.exists() and policy_path.exists():
        try:
            result = runner([str(tool), 'status'], capture_output=True, text=True, timeout=5, check=True)
            values = dict(line.split(':', 1) for line in result.stdout.splitlines() if ':' in line)
            for node in ['p1', 'p2', 'p3', 'p4']:
                if node in values:
                    metric('clusterhat_node_power', int(values[node]), {'slot': node})
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    metric('clusterctrl_hardware_collection_timestamp_seconds', now)
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    directory = Path('/var/lib/clusterctrl-node-exporter')
    directory.mkdir(mode=0o755, exist_ok=True)
    temporary = directory/'hardware.prom.tmp'
    temporary.write_text(collect())
    temporary.chmod(0o644)
    os.replace(temporary, directory/'hardware.prom')
