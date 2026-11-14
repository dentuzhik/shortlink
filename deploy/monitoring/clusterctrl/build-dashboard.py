#!/usr/bin/env python3
"""Generate the provisioned ClusterCTRL hardware dashboard."""
import json
from pathlib import Path

DS = {'type': 'prometheus', 'uid': 'clusterctrl-prometheus'}
SELECT = 'job="nodes",node=~"$node"'
LIVE = 'max by(node)(up{' + SELECT + '} == 1)'
panels = []
y = 0


def query(expression, legend='{{node}}', instant=False, ref='A'):
    return {'expr': expression, 'legendFormat': legend, 'refId': ref, 'instant': instant, 'range': not instant, 'format': 'time_series'}


def panel(title, kind, x, width, height, targets=None, unit='short', description=''):
    result = {'id': len(panels)+1, 'title': title, 'type': kind, 'datasource': DS,
              'gridPos': {'x': x, 'y': y, 'w': width, 'h': height}, 'description': description,
              'fieldConfig': {'defaults': {'unit': unit, 'color': {'mode': 'palette-classic'}, 'noValue': 'Unavailable'}, 'overrides': []},
              'targets': targets or [], 'options': {}}
    if kind == 'timeseries':
        result['options'] = {'tooltip': {'mode': 'multi', 'sort': 'desc'}, 'legend': {'displayMode': 'table', 'placement': 'bottom', 'calcs': ['lastNotNull', 'max']}}
        result['fieldConfig']['defaults']['custom'] = {'drawStyle': 'line', 'lineInterpolation': 'linear', 'lineWidth': 2, 'fillOpacity': 8, 'spanNulls': False, 'showPoints': 'never'}
    panels.append(result)
    return result


def row(title):
    global y
    panels.append({'id': len(panels)+1, 'title': title, 'type': 'row', 'collapsed': False, 'panels': [], 'gridPos': {'x': 0, 'y': y, 'w': 24, 'h': 1}})
    y += 1


def bounded(p, maximum=100):
    p['fieldConfig']['defaults'].update(min=0, max=maximum)


USB_SELECT = 'job="nodes",node="cbridge",device=~"ethpi[1-4]"'
USB_TELEMETRY = '(max(up{job="nodes",node="cbridge"}) == 1) and on() (max(node_scrape_collector_success{job="nodes",node="cbridge",collector="netclass"}) == 1)'
USB_MAPPINGS = [{'type': 'value', 'options': {
    '0': {'text': 'INTERFACE ABSENT', 'color': 'red'},
    '1': {'text': 'NO CARRIER', 'color': 'orange'},
    '2': {'text': 'CARRIER PRESENT', 'color': 'green'},
}}, {'type': 'special', 'options': {'match': 'null', 'result': {'text': 'NO TELEMETRY', 'color': 'gray'}}}]


def usb_status(number):
    carrier = 'max(node_network_carrier{job="nodes",node="cbridge",device="ethpi'+str(number)+'"})'
    # A missing interface is zero only while the controller and netclass
    # collector are healthy. An unavailable controller produces no sample.
    return '((1 + '+carrier+') and on() ('+USB_TELEMETRY+')) or on() (0 * ('+USB_TELEMETRY+'))'


def usb_metric(name, operation=None, window='$__rate_interval'):
    expression = name+'{'+USB_SELECT+'}'
    if operation:
        expression = operation+'('+expression+'['+window+'])'
    return 'label_replace('+expression+', "usb_node", "P$1", "device", "ethpi([1-4])")'


row('Availability · controller and four Pi Zeros')
for index, name in enumerate(['cbridge', 'p1', 'p2', 'p3', 'p4']):
    p = panel('Controller' if name == 'cbridge' else name.upper(), 'stat', index*4, 4, 4,
              [query('up{job="nodes",node="'+name+'"}', instant=True)], description='A successful metrics scrape means online. A powered node can still be unreachable; see HAT power below.')
    p['fieldConfig']['defaults'].update(color={'mode': 'thresholds'}, min=0, max=1,
        mappings=[{'type': 'value', 'options': {'0': {'text': 'OFFLINE', 'color': 'red'}, '1': {'text': 'ONLINE', 'color': 'green'}}}],
        thresholds={'mode': 'absolute', 'steps': [{'color': 'red', 'value': None}, {'color': 'green', 'value': 1}]})
    p['options'] = {'colorMode': 'background_solid', 'graphMode': 'none', 'reduceOptions': {'calcs': ['last'], 'values': False}, 'textMode': 'value'}
p=panel('Exporters online / 5', 'stat', 20, 4, 4, [query('sum(up{job="nodes"})', instant=True)])
p['options']={'graphMode': 'none', 'reduceOptions': {'calcs': ['last'], 'values': False}}
y += 4

row('Cooling · actual fan output and configured response')
p=panel('Fan speed and hottest temperature over time', 'timeseries', 0, 16, 9, [
    query('clusterhat_fan_duty_percent', 'Fan duty %', ref='A'),
    query('clusterhat_fan_hottest_temperature_celsius', 'Hottest temperature', ref='B'),
    query('clusterhat_fan_filtered_temperature_celsius', 'Smoothed temperature', ref='C')], 'percent',
    'Actual PWM command, not measured RPM. Temperatures use the hottest fresh controller/node reading. This panel always covers the whole cluster. Gaps indicate unavailable fan telemetry.')
bounded(p)
for field in ['Hottest temperature', 'Smoothed temperature']:
    p['fieldConfig']['overrides'].append({'matcher': {'id': 'byName', 'options': field}, 'properties': [{'id': 'unit', 'value': 'celsius'}, {'id': 'custom.axisPlacement', 'value': 'right'}, {'id': 'min', 'value': 25}, {'id': 'max', 'value': 85}]})
target=query('clusterhat_fan_curve_duty_percent', instant=True)
p=panel('Configured temperature → fan curve', 'xychart', 16, 8, 9, [target], 'percent',
    'Live policy breakpoints from /etc/clusterhat-fan.json. Off-temperature hysteresis, startup spin-up, smoothing and ramp-down affect the actual history on the left.')
p['transformations']=[{'id':'labelsToFields','options':{'mode':'columns'}}, {'id':'merge','options':{}},
    {'id': 'filterFieldsByName', 'options': {'include': {'names': ['temperature_c', 'clusterhat_fan_curve_duty_percent']}}},
    {'id':'organize','options':{'renameByName':{'temperature_c':'Temperature','clusterhat_fan_curve_duty_percent':'Fan duty'}}},
    {'id': 'convertFieldType', 'options': {'conversions': [{'targetField': 'Temperature', 'destinationType': 'number'}], 'fields': {}}},
    {'id': 'sortBy', 'options': {'fields': {}, 'sort': [{'field': 'Temperature', 'desc': False}]}}]
p['options']={'mapping': 'manual', 'series': [{'name': {'fixed': 'Fan policy'}, 'frame': {'matcher': {'id': 'byIndex', 'options': 0}}, 'x': {'matcher': {'id': 'byName', 'options': 'Temperature'}}, 'y': {'matcher': {'id': 'byName', 'options': 'Fan duty'}}}], 'tooltip': {'mode': 'single'}, 'legend': {'showLegend': False}}
p['fieldConfig']['defaults'].update(min=0,max=100,custom={'show': 'points+lines', 'lineWidth': 2, 'pointSize': {'fixed': 7}, 'fillOpacity': 0})
p['fieldConfig']['overrides']=[{'matcher': {'id': 'byName','options': 'Temperature'}, 'properties': [{'id': 'unit','value': 'celsius'}, {'id': 'min','value': 35}, {'id': 'max','value': 80}]}]
y += 9

usb_panels_start = len(panels)
row('USB · P1–P4 packet errors and link health')
for number in range(1,5):
    p=panel(f'P{number} · USB link', 'stat', (number-1)*6, 6, 4,
            [query(usb_status(number),f'P{number}',instant=True)],
            description=f'Controller-side ethpi{number}. Carrier present does not establish IP/SSH health. Absent means the network interface is not detected; a raw USB boot device may still exist. No telemetry means controller/netclass collection is unavailable. USB panels always cover all four ports, independently of the general machine/interface filters.')
    p['fieldConfig']['defaults'].update(min=0,max=2,color={'mode':'thresholds'},noValue='NO TELEMETRY',mappings=USB_MAPPINGS,
        thresholds={'mode':'absolute','steps':[{'color':'red','value':None},{'color':'orange','value':1},{'color':'green','value':2}]})
    p['options']={'colorMode':'value','graphMode':'none','reduceOptions':{'calcs':['last'],'values':False},'textMode':'value'}
y += 4
panel('USB packet error rate · controller side', 'timeseries',0,12,8,[
    query(usb_metric('node_network_transmit_errs_total','rate'),'{{usb_node}} TX errors',ref='A'),
    query(usb_metric('node_network_receive_errs_total','rate'),'{{usb_node}} RX errors',ref='B')], 'suffix:errors/s',
    'Current error rate from controller ethpi1–ethpi4. TX is controller → Pi; RX is Pi → controller. Driver error counters are not a packet-loss percentage. Missing counters remain gaps, not healthy zeros. USB enumeration errors before a network interface exists are not counted here.')
panel('USB packet drop rate · controller side', 'timeseries',12,12,8,[
    query(usb_metric('node_network_transmit_drop_total','rate'),'{{usb_node}} TX drops',ref='A'),
    query(usb_metric('node_network_receive_drop_total','rate'),'{{usb_node}} RX drops',ref='B')], 'suffix:drops/s',
    'Driver-reported dropped packets, separate from errors. RX is received from the Pi; TX is transmitted toward it. Missing interfaces produce no samples.')
y += 8
panel('USB errors · cumulative counters', 'timeseries',0,12,7,[
    query(usb_metric('node_network_transmit_errs_total'),'{{usb_node}} TX errors',ref='A'),
    query(usb_metric('node_network_receive_errs_total'),'{{usb_node}} RX errors',ref='B')], 'short',
    'Driver counters since interface creation/reset. Rising values indicate new failures; a flat nonzero value is historical. Counters can reset after device re-enumeration or reboot and can exceed successful packet counts.')
p=panel('USB errors · range increase (estimate)', 'bargauge',12,12,7,[
    query(usb_metric('node_network_transmit_errs_total','increase','$__range'),'{{usb_node}} TX',instant=True,ref='A'),
    query(usb_metric('node_network_receive_errs_total','increase','$__range'),'{{usb_node}} RX',instant=True,ref='B')], 'short',
    'Estimated error increments within the dashboard time range. Prometheus accounts for observed counter resets and extrapolates between scrapes, so values may be fractional. No samples means unknown, not zero.')
p['fieldConfig']['defaults'].update(min=0,decimals=1,color={'mode':'thresholds'},
    thresholds={'mode':'absolute','steps':[{'color':'green','value':None},{'color':'orange','value':1},{'color':'red','value':10}]})
p['options']={'orientation':'horizontal','displayMode':'gradient','showUnfilled':True,'reduceOptions':{'calcs':['last'],'values':False}}
y += 7
panel('USB packets · received / transmitted', 'timeseries',0,12,7,[
    query(usb_metric('node_network_receive_packets_total','rate'),'{{usb_node}} RX',ref='A'),
    query(usb_metric('node_network_transmit_packets_total','rate'),'{{usb_node}} TX',ref='B')], 'pps',
    'Controller-side packet throughput. Compare traffic with the error panels to identify stalls or an otherwise idle link. This is not an end-to-end reachability probe.')
panel('USB traffic · received / transmitted', 'timeseries',12,12,7,[
    query(usb_metric('node_network_receive_bytes_total','rate'),'{{usb_node}} RX',ref='A'),
    query(usb_metric('node_network_transmit_bytes_total','rate'),'{{usb_node}} TX',ref='B')], 'Bps',
    'Only the four USB interfaces are included; bridge and Ethernet traffic are excluded to avoid double counting.')
y += 7
panel('USB carrier transitions · selected time range', 'bargauge',0,12,7,[
    query(usb_metric('node_network_carrier_changes_total','increase','$__range'),'{{usb_node}} changes',instant=True,ref='A'),
    query(usb_metric('node_network_carrier_down_changes_total','increase','$__range'),'{{usb_node}} lost carrier',instant=True,ref='B')], 'short',
    'Observed carrier changes include startup/re-enumeration as well as cable/link changes. Estimates account for counter resets; a missing counter is unavailable.')
panels[-1]['options']={'orientation':'horizontal','displayMode':'gradient','showUnfilled':True,'reduceOptions':{'calcs':['last'],'values':False}}
p=panel('USB link history', 'state-timeline',12,12,7,[query(usb_status(n),f'P{n}',ref=chr(64+n)) for n in range(1,5)], 'short',
    'Interface/carrier status collected on cbridge. Gaps mean controller/netclass telemetry is unavailable. A present carrier is separate from successful packet delivery or SSH.')
p['fieldConfig']['defaults'].update(min=0,max=2,color={'mode':'fixed','fixedColor':'green'},mappings=USB_MAPPINGS,
    custom={'fillOpacity':80,'lineWidth':0,'spanNulls':False})
p['options']={'mergeValues':True,'rowHeight':0.75,'showValue':'auto','alignValue':'left','tooltip':{'mode':'single'},'legend':{'showLegend':False}}
y += 7
for usb_panel in panels[usb_panels_start:]:
    if usb_panel['type']=='timeseries':
        usb_panel['options']['legend'].update(placement='right',width=240)
        if usb_panel['title'] != 'USB errors · cumulative counters':
            usb_panel['options']['legend']['calcs'] = ['lastNotNull']

row('CPU and memory · selected machines')
cpu='100 * (1 - avg by(node)(rate(node_cpu_seconds_total{'+SELECT+',mode="idle"}[$__rate_interval])))'
memory='100 * (1 - max by(node)(node_memory_MemAvailable_bytes{'+SELECT+'}) / max by(node)(node_memory_MemTotal_bytes{'+SELECT+'}))'
root_used='100 * (1 - max by(node)(node_filesystem_avail_bytes{'+SELECT+',mountpoint="/"}) / max by(node)(node_filesystem_size_bytes{'+SELECT+',mountpoint="/"}))'
for title, expression, x in [('CPU busy',cpu,0),('RAM used · excludes reclaimable cache',memory,12)]:
    p=panel(title,'timeseries',x,12,8,[query('('+expression+') and on(node) '+LIVE)],'percent');bounded(p)
y += 8
panel('Load average / CPU cores', 'timeseries',0,12,7,[query('node_load1{'+SELECT+'} / on(node) group_left count by(node)(node_cpu_seconds_total{'+SELECT+',mode="idle"})')], 'short','1.0 means one runnable task per CPU core; sustained values above 1 indicate contention.')
panel('RAM and swap used', 'timeseries',12,12,7,[query('node_memory_MemTotal_bytes{'+SELECT+'} - node_memory_MemAvailable_bytes{'+SELECT+'}','{{node}} RAM',ref='A'),query('node_memory_SwapTotal_bytes{'+SELECT+'} - node_memory_SwapFree_bytes{'+SELECT+'}','{{node}} swap',ref='B')],'bytes')
y += 7

row('Storage · SD-card capacity and I/O')
p=panel('Root filesystem used','timeseries',0,12,7,[query('('+root_used+') and on(node) '+LIVE)],'percent');bounded(p)
disk=SELECT+',device=~"mmcblk[0-9]+|sd[a-z]+|nvme[0-9]+n[0-9]+"'
panel('Disk read / write throughput','timeseries',12,12,7,[query('rate(node_disk_read_bytes_total{'+disk+'}[$__rate_interval])','{{node}} {{device}} read',ref='A'),query('rate(node_disk_written_bytes_total{'+disk+'}[$__rate_interval])','{{node}} {{device}} write',ref='B')],'Bps')
y += 7
p=panel('Disk time busy','timeseries',0,12,7,[query('100 * rate(node_disk_io_time_seconds_total{'+disk+'}[$__rate_interval])','{{node}} {{device}}')],'percent');bounded(p)
panel('Free filesystem capacity','timeseries',12,12,7,[query('node_filesystem_avail_bytes{'+SELECT+',fstype=~"ext4|vfat|xfs|btrfs"}','{{node}} {{mountpoint}}')],'bytes')
y += 7

row('Networking · interface traffic and errors')
net=SELECT+',device=~"$interface",device!="lo"'
panel('Network received / transmitted','timeseries',0,12,8,[query('rate(node_network_receive_bytes_total{'+net+'}[$__rate_interval])','{{node}} {{device}} RX',ref='A'),query('rate(node_network_transmit_bytes_total{'+net+'}[$__rate_interval])','{{node}} {{device}} TX',ref='B')],'Bps','Each interface is shown separately; bridge/member traffic is intentionally not summed.')
panel('Network error and drop rates','timeseries',12,12,8,[query('rate(node_network_receive_errs_total{'+net+'}[$__rate_interval])','{{node}} {{device}} RX errors',ref='A'),query('rate(node_network_transmit_errs_total{'+net+'}[$__rate_interval])','{{node}} {{device}} TX errors',ref='B'),query('rate(node_network_receive_drop_total{'+net+'}[$__rate_interval])','{{node}} {{device}} RX drops',ref='C')],'ops')
y += 8
panel('HAT node power · power does not imply reachability','timeseries',0,24,7,[query('clusterhat_node_power','{{slot}}')],'bool')
y += 7

row('Thermal health and availability')
panel('Processor temperatures','timeseries',0,12,7,[query('rpi_temperature_celsius{'+SELECT+'} and on(node) '+LIVE)],'celsius')
p=panel('Undervoltage / throttling flags','timeseries',12,12,7,[query('rpi_undervoltage{'+SELECT+'}','{{node}} undervoltage',ref='A'),query('rpi_throttled{'+SELECT+'}','{{node}} throttled',ref='B'),query('rpi_undervoltage_since_boot{'+SELECT+'}','{{node}} undervoltage since boot',ref='C')],'bool');bounded(p,1)
y += 7
panel('Node availability history','timeseries',0,12,6,[query('up{'+SELECT+'}')],'bool')
panel('Uptime','timeseries',12,12,6,[query('(time() - node_boot_time_seconds{'+SELECT+'}) and on(node) '+LIVE)],'dtdurations')
y += 6
panel('Fan sensor availability','timeseries',0,12,6,[query('clusterhat_fan_sensor_available','{{sensor}}')],'bool')
panel('Exporter collection time','timeseries',12,12,6,[query('scrape_duration_seconds{'+SELECT+'}')],'s','Collection overhead and scrape timeouts; collection interval is 15 seconds.')

dashboard={'uid':'clusterctrl-hardware','title':'ClusterCTRL · Hardware','description':'Controller and P1–P4 hardware health, SD-card I/O, connectivity, temperature and fan control. Missing measurements remain gaps; exporter health is explicit.','tags':['clusterctrl','hardware','raspberry-pi','local'],'timezone':'browser','schemaVersion':39,'version':1,'refresh':'10s','time':{'from':'now-1h','to':'now'},'editable':False,'graphTooltip':1,
    'templating':{'list':[
        {'name':'node','label':'Machines','type':'query','datasource':DS,'query':{'query':'label_values(up{job="nodes"}, node)','refId':'node-variable'},'refresh':1,'sort':1,'multi':True,'includeAll':True,'allValue':'.*','current':{'text':'All','value':'$__all'},'options':[]},
        {'name':'interface','label':'Interfaces','type':'query','datasource':DS,'query':{'query':'label_values(node_network_receive_bytes_total{job="nodes",node=~"$node",device!="lo"}, device)','refId':'interface-variable'},'refresh':1,'sort':1,'multi':True,'includeAll':True,'allValue':'.*','current':{'text':'All','value':'$__all'},'options':[]}
    ]},'panels':panels}
Path(__file__).with_name('grafana-dashboard.json').write_text(json.dumps(dashboard,indent=2)+'\n')
print(f'Generated {len(panels)} dashboard panels')
