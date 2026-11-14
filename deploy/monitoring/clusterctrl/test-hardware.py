import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('hardware', Path(__file__).with_name('collect-hardware.py'))
hardware = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hardware)


class HardwareMetricsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)

    def put(self, name, value):
        p = self.root/name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(value)

    def runner(self, argv, **kwargs):
        return subprocess.CompletedProcess(argv, 0, 'throttled=0x10001\n')

    def test_missing_hardware_and_full_precision_timestamp(self):
        result = hardware.collect(self.root, self.runner, 1794683516)
        self.assertIn('clusterctrl_hardware_collection_timestamp_seconds 1794683516\n', result)
        self.assertNotIn('rpi_temperature_celsius', result)

    def test_voltage_history_is_separate_from_current_flags(self):
        result = hardware.collect(self.root, self.runner, 100)
        self.assertIn('rpi_undervoltage 1\n', result)
        self.assertIn('rpi_undervoltage_since_boot 1\n', result)
        self.assertIn('rpi_throttled 0\n', result)

    def test_stale_fan_output_is_not_presented_as_live(self):
        self.put('run/clusterhat-fan/status.json', json.dumps({'updated_unix': 10, 'duty_percent': 50}))
        result = hardware.collect(self.root, self.runner, 100)
        self.assertIn('clusterhat_fan_status_fresh 0\n', result)
        self.assertNotIn('clusterhat_fan_duty_percent', result)

    def test_unavailable_sensor_is_not_zero_temperature(self):
        self.put('run/clusterhat-fan/status.json', json.dumps({'updated_unix': 100, 'duty_percent': 55, 'temperatures_c': {'p1': None, 'p2': 52}}))
        result = hardware.collect(self.root, self.runner, 102)
        self.assertIn('clusterhat_fan_sensor_available{sensor="p1"} 0\n', result)
        self.assertNotIn('clusterhat_fan_sensor_temperature_celsius{sensor="p1"}', result)
        self.assertIn('clusterhat_fan_sensor_temperature_celsius{sensor="p2"} 52\n', result)

    def test_curve_follows_policy_file(self):
        self.put('etc/clusterhat-fan.json', json.dumps({'curve': [[45, 40], [75, 100]], 'full_temperature_c': 75}))
        result = hardware.collect(self.root, self.runner, 100)
        self.assertIn('clusterhat_fan_curve_duty_percent{temperature_c="45"} 40\n', result)
        self.assertIn('clusterhat_fan_curve_duty_percent{temperature_c="75"} 100\n', result)


if __name__ == '__main__':
    unittest.main()
