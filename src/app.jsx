/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2017 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */

import cockpit from 'cockpit';
import React from 'react';
import moment from "moment";
import { EmptyStatePanel } from "../lib/cockpit-components-empty-state.jsx";
import {
    Alert,
    Button,
    Card, CardTitle, CardBody, Gallery,
    Page, PageSection,
    Progress, ProgressVariant,
} from '@patternfly/react-core';
import { Table, TableHeader, TableBody, TableVariant, RowWrapper } from '@patternfly/react-table';
import { ExclamationCircleIcon } from '@patternfly/react-icons';
import './app.scss';

import * as machine_info from "../lib/machine-info.js";

const MSEC_PER_H = 3600000;
const INTERVAL = 5000;
const SAMPLES_PER_H = MSEC_PER_H / INTERVAL;
const SAMPLES_PER_MIN = SAMPLES_PER_H / 60;
const SVG_YMAX = (SAMPLES_PER_MIN - 1).toString();
const LOAD_HOURS = 12;
const _ = cockpit.gettext;

moment.locale(cockpit.language);

// keep track of maximum values for unbounded data, so that we can normalize it properly
// pre-init them to avoid inflating noise
var scaleSatCPU = 4;
var scaleUseDisks = 10000; // KB/s
var scaleUseNetwork = 100000; // B/s

// round up to the nearest number that has all zeroes except for the first digit
// avoids over-aggressive scaling, but needs scaling more often
const scaleForValue = x => {
    const scale = Math.pow(10, Math.floor(Math.log10(x)));
    // this can be tweaked towards "less rescaling" with an additional scalar, like "x * 1.5 / scale"
    return Math.ceil(x / scale) * scale;
};

const RESOURCES = {
    use_cpu: {
        name: _("CPU usage"),
        event_description: _("CPU spike"),
        // all in msec/s
        normalize: ([nice, user, sys]) => (nice + user + sys) / 1000,
        format: ([nice, user, sys]) => `${_("nice")}: ${Math.round(nice / 10)}%, ${_("user")}: ${Math.round(user / 10)}%, ${_("sys")}: ${Math.round(sys / 10)}%`,
    },
    sat_cpu: {
        name: _("Load"),
        event_description: _("Load spike"),
        // unitless, unbounded, dynamic scaling for normalization
        normalize: load => Math.min(load, scaleSatCPU) / scaleSatCPU,
        format: load => cockpit.format_number(load),
    },
    use_memory: {
        name: _("Memory usage"),
        event_description: _("Memory spike"),
        // assume used == total - available
        normalize: ([total, avail]) => 1 - (avail / total),
        format: ([total, avail]) => `${cockpit.format_bytes((total - avail) * 1024)} / ${cockpit.format_bytes(total * 1024)}`,
    },
    sat_memory: {
        name: _("Swap out"),
        event_description: _("Swap"),
        // page/s, unbounded, and mostly 0; just categorize into "nothing" (most of the time),
        // "a litte" (< 1000 pages), and "a lot" (> 1000 pages)
        normalize: swapout => swapout > 1000 ? 1 : (swapout > 1 ? 0.3 : 0),
        format: swapout => cockpit.format(_("$0 pages"), Math.floor(swapout)),
    },
    use_disks: {
        name: _("Disk I/O"),
        event_description: _("Disk I/O spike"),
        // kB/s, unbounded, dynamic scaling for normalization
        normalize: kBps => kBps / scaleUseDisks,
        format: kBps => cockpit.format_bytes_per_sec(kBps * 1024),
    },
    use_network: {
        name: _("Network I/O"),
        event_description: _("Network I/O spike"),
        // B/s, unbounded, dynamic scaling for normalization
        normalize: bps => bps / scaleUseNetwork,
        format: bps => cockpit.format_bytes_per_sec(bps),
    },
};

const CURRENT_METRICS = [
    { name: "cpu.basic.user", derive: "rate" },
    { name: "cpu.basic.system", derive: "rate" },
    { name: "cpu.basic.nice", derive: "rate" },
    { name: "memory.used" },
    { name: "disk.all.read", units: "bytes", derive: "rate" },
    { name: "disk.all.written", units: "bytes", derive: "rate" },
    { name: "network.interface.rx", units: "bytes", derive: "rate" },
    { name: "network.interface.tx", units: "bytes", derive: "rate" },
];

const CURRENT_METRICS_INIT = [null, null, null, null, null, null, [], []];

const HISTORY_METRICS = [
    // CPU utilization
    { name: "kernel.all.cpu.nice", derive: "rate" },
    { name: "kernel.all.cpu.user", derive: "rate" },
    { name: "kernel.all.cpu.sys", derive: "rate" },

    // CPU saturation
    { name: "kernel.all.load" },

    // memory utilization
    { name: "mem.physmem" },
    // mem.util.used is useless, it includes cache
    { name: "mem.util.available" },

    // memory saturation
    { name: "swap.pagesout", derive: "rate" },

    // disk utilization
    { name: "disk.all.total_bytes", derive: "rate" },

    // network utilization
    { name: "network.interface.total.bytes", derive: "rate", "omit-instances": ["lo"] },
];

// metrics with instances, which need special treatment
const LOAD_INDEX = 3;
const NET_TOTAL_INDEX = 8;

class CurrentMetrics extends React.Component {
    constructor(props) {
        super(props);

        this.metrics_channel = null;
        this.samples = CURRENT_METRICS_INIT.slice();
        this.netInterfacesNames = [];

        this.state = {
            memTotal: 0, // GiB
            memUsed: 0, // GiB
            numCpu: 1, // number
            cpuUsed: 0, // percentage
            disksRead: 0, // B/s
            disksWritten: 0, // B/s
            mounts: [], // [{ target (string), use (percent), avail (bytes) }]
            netInterfacesRx: [],
            netInterfacesTx: [],
        };

        machine_info.cpu_ram_info().done(info => this.setState({
            memTotal: Number((info.memory / (1024 * 1024 * 1024)).toFixed(1)),
            numCpu: info.cpus,
        }));

        this.onVisibilityChange = this.onVisibilityChange.bind(this);
        this.onMetricsUpdate = this.onMetricsUpdate.bind(this);
        this.getMounts = this.getMounts.bind(this);

        cockpit.addEventListener("visibilitychange", this.onVisibilityChange);
        this.onVisibilityChange();

        // regularly update info about file systems
        this.getMounts();
        window.setInterval(this.getMounts, 10000);
    }

    onVisibilityChange() {
        if (cockpit.hidden && this.metrics_channel !== null) {
            this.metrics_channel.removeEventListener("message", this.onMetricsUpdate);
            this.metrics_channel.close();
            this.metrics_channel = null;
            return;
        }

        if (!cockpit.hidden && this.metrics_channel === null) {
            this.metrics_channel = cockpit.channel({ payload: "metrics1", source: "internal", interval: 3000, metrics: CURRENT_METRICS });
            this.metrics_channel.addEventListener("closed", (ev, error) => console.error("metrics closed:", error));
            this.metrics_channel.addEventListener("message", this.onMetricsUpdate);
        }
    }

    getMounts() {
        /* df often exits with non-zero if it encounters any file system it can't read; but that's fine, get info about all the
         * others */
        cockpit.script("df --local --exclude-type=tmpfs --exclude-type=devtmpfs --block-size=1 --output=target,size,avail,pcent || true",
                       { err: "message" })
                .then(output => {
                    // skip first line with the headings
                    const mounts = [];
                    output.trim()
                            .split("\n")
                            .slice(1)
                            .forEach(s => {
                                const fields = s.split(/ +/);
                                if (fields.length != 4) {
                                    console.warn("Invalid line in df:", s);
                                    return;
                                }
                                mounts.push({
                                    target: fields[0],
                                    size: Number(fields[1]),
                                    avail: Number(fields[2]),
                                    use: Number(fields[3].slice(0, -1)), /* strip off '%' */
                                });
                            });

                    console.log("XXX df parsing done:", JSON.stringify(mounts));
                    this.setState({ mounts });
                })
                .catch(ex => console.warn("Failed to run df:", ex.toString()));
    }

    onMetricsUpdate(event, message) {
        console.log("XXX current metrics message", message);
        const data = JSON.parse(message);

        // reset state on meta messages
        if (!Array.isArray(data)) {
            this.samples = CURRENT_METRICS_INIT.slice();
            console.assert(data.metrics[6].name === 'network.interface.rx');
            this.netInterfacesNames = data.metrics[6].instances.slice();
            console.log("XXX metrics message was meta, new net instance names", JSON.stringify(this.netInterfacesNames));
            return;
        }

        // decompress
        data.forEach(samples => {
            samples.forEach((sample, i) => {
                if (sample instanceof Array) {
                    sample.forEach((inst, k) => {
                        if (inst !== null)
                            this.samples[i][k] = inst;
                    });
                } else if (sample !== null) {
                    this.samples[i] = sample;
                }
            });
        });

        const newState = {};
        // CPU metrics are in ms/s; divide by 10 to get percentage
        if (this.samples[0] !== false) {
            const cpu = Math.round((this.samples[0] + this.samples[1] + this.samples[2]) / 10 / this.state.numCpu);
            newState.cpuUsed = cpu;
        }

        if (this.samples[4] !== false)
            newState.disksRead = this.samples[4];
        if (this.samples[5] !== false)
            newState.disksWritten = this.samples[5];

        newState.memUsed = Number((this.samples[3] / (1024 * 1024 * 1024)).toFixed(1));
        newState.netInterfacesRx = this.samples[6];
        newState.netInterfacesTx = this.samples[7];

        this.setState(newState);
    }

    render() {
        const fraction = this.state.memUsed / this.state.memTotal;
        const memAvail = this.state.memTotal - this.state.memUsed;
        const num_cpu_str = cockpit.format(cockpit.ngettext("$0 CPU", "$0 CPUs", this.state.numCpu), this.state.numCpu);

        const netIO = this.netInterfacesNames.map((iface, i) => [
            iface,
            cockpit.format_bytes_per_sec(this.state.netInterfacesRx[i]),
            cockpit.format_bytes_per_sec(this.state.netInterfacesTx[i]),
        ]);

        return (
            <Gallery className="current-metrics" hasGutter>
                <Card>
                    <CardTitle>{ _("CPU") }</CardTitle>
                    <CardBody>
                        <Progress
                            id="current-cpu-usage"
                            value={this.state.cpuUsed}
                            className="pf-m-sm"
                            min={0} max={100}
                            variant={ this.state.cpuUsed > 90 ? ProgressVariant.danger : ProgressVariant.info }
                            title={ num_cpu_str }
                            label={ this.state.cpuUsed + '% ' } />
                    </CardBody>

                    <CardTitle>{ _("Memory") }</CardTitle>
                    <CardBody>
                        <Progress
                            id="current-memory-usage"
                            value={this.state.memUsed}
                            className="pf-m-sm"
                            min={0} max={Number(this.state.memTotal)}
                            variant={fraction > 0.9 ? ProgressVariant.danger : ProgressVariant.info}
                            title=" "
                            label={ cockpit.format(_("$0 GiB available / $1 GiB total"), memAvail, this.state.memTotal) } />
                    </CardBody>
                </Card>

                <Card>
                    <CardTitle>{ _("Disks") }</CardTitle>
                    <CardBody>
                        <table className="disks-io">
                            <tr>
                                <th>{ _("Reading:") }</th>
                                <td id="current-disks-read">{ cockpit.format_bytes_per_sec(this.state.disksRead) }</td>
                                <th>{ _("Writing:") }</th>
                                <td id="current-disks-write">{ cockpit.format_bytes_per_sec(this.state.disksWritten) }</td>
                            </tr>
                        </table>

                        <div className="progress-stack"> {
                            this.state.mounts.map(info => <Progress
                                data-disk-usage-target={info.target}
                                key={info.target}
                                value={ info.use } min={0} max={100}
                                className="pf-m-sm"
                                variant={info.use > 90 ? ProgressVariant.danger : ProgressVariant.info}
                                title={info.target}
                                label={ cockpit.format(_("$0 free / $1 total"), cockpit.format_bytes(info.avail, 1000), cockpit.format_bytes(info.size, 1000)) } />)
                        }
                        </div>
                    </CardBody>
                </Card>

                <Card>
                    <CardTitle>{ _("Network") }</CardTitle>
                    <CardBody>
                        <Table
                            variant={TableVariant.compact}
                            borders={false}
                            aria-label={ _("Network usage") }
                            cells={ [_("Interface"), _("In"), _("Out")] } rows={netIO}
                            rowWrapper={ props => <RowWrapper data-interface={ props.row[0] } {...props} /> }>
                            <TableHeader />
                            <TableBody />
                        </Table>
                    </CardBody>
                </Card>
            </Gallery>);
    }
}

const SvgGraph = ({ data, resource }) => {
    const dataPoints = key => (
        "0,0 " + // start polygon at (0, 0)
        data.map((samples, index) => (samples ? samples[key].toString() : "0") + "," + index.toString()).join(" ") +
        " 0," + (data.length - 1) // close polygon
    );

    return (
        <svg xmlns="http://www.w3.org/2000/svg" viewBox={ "0 0 2 " + SVG_YMAX } preserveAspectRatio="none">
            <polygon
                 transform={ "matrix(-1,0,0,-1,1," + SVG_YMAX + ")" }
                 points={ dataPoints("use_" + resource) }
            />
            { (resource === 'cpu' || resource === 'memory') && <polygon
                transform={ "matrix(1,0,0,-1,1," + SVG_YMAX + ")" }
                points={ dataPoints("sat_" + resource) }
                opacity="0.7"
            /> }
        </svg>
    );
};

// data: type → SAMPLES_PER_H objects from startTime
const MetricsHour = ({ startTime, data }) => {
    // compute graphs
    const graphs = [];

    // normalize data
    const normData = data.map(sample => {
        if (sample === null)
            return null;
        const n = {};
        for (const type in sample)
            n[type] = RESOURCES[type].normalize(sample[type]);
        return n;
    });

    for (let minute = 0; minute < 60; ++minute) {
        const dataOffset = minute * SAMPLES_PER_MIN;
        const dataSlice = normData.slice(dataOffset, dataOffset + SAMPLES_PER_MIN);
        const valid = dataSlice.some(i => i !== null);

        ['cpu', 'memory', 'disks', 'network'].forEach(resource => {
            graphs.push(
                <div
                    key={ resource + startTime + minute }
                    className={ ("metrics-data metrics-data-" + resource) + (valid ? " valid-data" : " empty-data")}
                    style={{ "--metrics-minute": minute }}
                    aria-hidden="true"
                >
                    { valid && <SvgGraph data={dataSlice} resource={resource} /> }
                </div>);
        });
    }

    // compute spike events
    const minute_events = {};
    for (const type in RESOURCES) {
        let prev_val = data[0] ? data[0][type] : null;
        normData.forEach((samples, i) => {
            if (samples === null)
                return;
            const value = samples[type];
            // either high enough slope, or crossing the 80% treshold
            if (prev_val !== null && (value - prev_val > 0.25 || (prev_val < 0.8 && value >= 0.8))) {
                const minute = Math.floor(i / SAMPLES_PER_MIN);
                if (minute_events[minute] === undefined)
                    minute_events[minute] = [];
                minute_events[minute].push(type);
            }
            prev_val = value;
        });
    }

    const events = [];
    for (const minute in minute_events) {
        events.push(
            <dl key={minute} className="metrics-events" style={{ "--metrics-minute": minute }}>
                <dt><time>{ moment(startTime + (minute * 60000)).format('LT') }</time></dt>
                { minute_events[minute].map(t => <dd key={ t }>{ RESOURCES[t].event_description }</dd>) }
            </dl>);
    }

    // FIXME: throttle-debounce this
    const updateTooltip = ev => {
        // event usually happens on an <svg> or its child, so also consider the parent elements
        let el = ev.target;
        let dataElement = null;
        for (let i = 0; i < 3; ++i) {
            if (el.classList.contains("metrics-data")) {
                dataElement = el;
                break;
            } else {
                if (el.parentElement)
                    el = el.parentElement;
                else
                    break;
            }
        }

        const hourElement = document.getElementById("metrics-hour-" + startTime.toString());

        if (dataElement) {
            const minute = parseInt(el.style.getPropertyValue("--metrics-minute"));
            const bounds = dataElement.getBoundingClientRect();
            const offsetY = (ev.clientY - bounds.y) / bounds.height;
            const indexOffset = Math.floor((1 - offsetY) * SAMPLES_PER_MIN);
            const sample = data[minute * SAMPLES_PER_MIN + indexOffset];
            if (sample === null) {
                hourElement.removeAttribute("title");
                return;
            }

            const time = moment(startTime + minute * 60000 + indexOffset * INTERVAL).format("LTS");
            console.log("XXX", ev.type, "hour", startTime, "minute", minute, JSON.stringify(sample), "indexOffset", indexOffset, "time", time);
            let tooltip = time + "\n\n";
            for (const t in sample)
                tooltip += `${RESOURCES[t].name}: ${RESOURCES[t].format(sample[t])}\n`;
            hourElement.setAttribute("title", tooltip);
        } else {
            console.log(ev.type, "leave");
            hourElement.removeAttribute("title");
        }
    };

    return (
        <div id={ "metrics-hour-" + startTime.toString() } className="metrics-hour" onMouseMove={updateTooltip}>
            { events }
            { graphs }
            <h3 className="metrics-time"><time>{ moment(startTime).format("LT ddd YYYY-MM-DD") }</time></h3>
        </div>
    );
};

class MetricsHistory extends React.Component {
    constructor(props) {
        super(props);
        // metrics data: hour timestamp → array of SAMPLES_PER_H objects of { type → value } or null
        this.data = {};
        // timestamp of the most recent sample that we got (for auto-refresh)
        this.most_recent = 0;
        // Oldest read data
        this.oldest_timestamp = 0;

        this.state = {
            hours: [], // available hours for rendering in descending order
            loading: true, // show loading indicator
            metricsAvailable: true,
            error: null,
        };

        this.handleMoreData = this.handleMoreData.bind(this);

        // load and render the last 24 hours (plus current one) initially
        // FIXME: load less up-front, load more when scrolling
        cockpit.spawn(["date", "+%s"])
                .then(out => {
                    const now = parseInt(out.trim()) * 1000;
                    const current_hour = Math.floor(now / MSEC_PER_H) * MSEC_PER_H;
                    this.load_data(current_hour - LOAD_HOURS * MSEC_PER_H);
                })
                .catch(ex => this.setState({ error: ex.toString() }));
    }

    handleMoreData() {
        this.load_data(this.oldest_timestamp - (LOAD_HOURS * MSEC_PER_H), LOAD_HOURS * SAMPLES_PER_H);
    }

    load_data(load_timestamp, limit) {
        this.setState({ loading: true });

        this.oldest_timestamp = this.oldest_timestamp > load_timestamp || this.oldest_timestamp === 0 ? load_timestamp : this.oldest_timestamp;
        let current_hour; // hour of timestamp, from most recent meta message
        let hour_index; // index within data[current_hour] array
        const current_sample = Array(HISTORY_METRICS.length).fill(null); // last valid value, for decompression
        const new_hours = new Set(); // newly seen hours during this load

        const metrics = cockpit.channel({
            payload: "metrics1",
            interval: INTERVAL,
            source: "pcp-archive",
            timestamp: load_timestamp,
            limit: limit,
            metrics: HISTORY_METRICS,
        });

        metrics.addEventListener("message", (event, message) => {
            console.log("XXX history metrics message", message);
            message = JSON.parse(message);

            const init_current_hour = () => {
                if (!this.data[current_hour])
                    this.data[current_hour] = Array(SAMPLES_PER_H).fill(null);
                new_hours.add(current_hour);
            };

            // meta message
            if (!Array.isArray(message)) {
                current_hour = Math.floor(message.timestamp / MSEC_PER_H) * MSEC_PER_H;
                init_current_hour();
                hour_index = Math.floor((message.timestamp - current_hour) / INTERVAL);
                console.assert(hour_index < SAMPLES_PER_H);

                console.log("XXX message is metadata; time stamp", message.timestamp, "=", moment(message.timestamp).format(), "for current_hour", current_hour, "=", moment(current_hour).format(), "hour_index", hour_index);
                return;
            }

            console.log("XXX message is", message.length, "samples data for current hour", current_hour, "=", moment(current_hour).format());

            message.forEach(samples => {
                // decompress
                samples.forEach((sample, i) => {
                    if (i === LOAD_INDEX) {
                        // CPU load: 3 instances (15min, 1min, 5min)
                        if (sample && sample[1] !== undefined && sample[1] !== null && sample[1] !== false)
                            current_sample[i] = sample[1];
                    } else if (i === NET_TOTAL_INDEX) {
                        // network rates: one instance per interface
                        if (current_sample[NET_TOTAL_INDEX] === null) {
                            current_sample[NET_TOTAL_INDEX] = sample;
                        } else {
                            sample.forEach((iface, k) => {
                                if (iface !== null && iface !== false)
                                    current_sample[NET_TOTAL_INDEX][k] = iface;
                            });
                        }
                    } else {
                        // scalar values
                        if (sample !== null && sample !== false)
                            current_sample[i] = sample;
                    }
                });

                // TODO: eventually track/display this by-interface?
                const use_network = current_sample[NET_TOTAL_INDEX].reduce((acc, cur) => acc + cur, 0);

                this.data[current_hour][hour_index] = {
                    use_cpu: [current_sample[0], current_sample[1], current_sample[2]],
                    sat_cpu: current_sample[LOAD_INDEX],
                    use_memory: [current_sample[4], current_sample[5]],
                    sat_memory: current_sample[6],
                    use_disks: current_sample[7],
                    use_network,
                };

                // keep track of maximums of unbounded values, for dynamic scaling
                if (current_sample[LOAD_INDEX] > scaleSatCPU)
                    scaleSatCPU = scaleForValue(current_sample[LOAD_INDEX]);
                if (current_sample[7] > scaleUseDisks)
                    scaleUseDisks = scaleForValue(current_sample[7]);
                if (use_network > scaleUseNetwork)
                    scaleUseNetwork = scaleForValue(use_network);

                if (++hour_index === SAMPLES_PER_H) {
                    current_hour += MSEC_PER_H;
                    hour_index = 0;
                    init_current_hour();
                    console.log("XXX hour overflow, advancing to", current_hour, "=", moment(current_hour).format());
                }
            });

            // update most recent sample timestamp
            this.most_recent = Math.max(this.most_recent, current_hour + hour_index * INTERVAL);
            console.log("XXX most recent timestamp is now", this.most_recent, "=", moment(this.most_recent).format());
        });

        metrics.addEventListener("close", (event, message) => {
            if (message.problem) {
                this.setState({
                    loading: false,
                    metricsAvailable: false,
                });
            } else {
                console.log("XXX loaded metrics for timestamp", moment(load_timestamp).format(), "new hours", JSON.stringify(Array.from(new_hours)));
                new_hours.forEach(hour => console.log("hour", hour, "data", JSON.stringify(this.data[hour])));

                const hours = Array.from(new Set([...this.state.hours, ...new_hours]));
                // sort in descending order
                hours.sort((a, b) => b - a);
                // re-render
                this.setState({ hours, loading: false });

                // trigger automatic update every minute
                if (!limit)
                    window.setTimeout(() => this.load_data(this.most_recent), 60000);
            }

            metrics.close();
        });
    }

    render() {
        if (cockpit.manifests && !cockpit.manifests.pcp)
            return <EmptyStatePanel
                        icon={ExclamationCircleIcon}
                        title={_("Package cockpit-pcp is missing for metrics history")}
                        action={<Button onClick={() => console.log("Installing cockpit-pcp...")}>{_("Install cockpit-pcp")}</Button>} />;

        if (!this.state.metricsAvailable)
            return <EmptyStatePanel
                        icon={ExclamationCircleIcon}
                        title={_("Metrics history could not be loaded")}
                        paragraph={_("Is 'pmlogger' service running?")}
                        action={<Button variant="link" onClick={() => cockpit.jump("/system/services#/pmlogger.service") }>{_("Troubleshoot")}</Button>} />;

        if (this.state.error)
            return <EmptyStatePanel
                        icon={ExclamationCircleIcon}
                        title={_("Error has occured")}
                        paragraph={this.state.error} />;

        let nodata_alert = null;
        if (!this.state.loading && this.state.hours.length > 0 && this.oldest_timestamp < this.state.hours[0]) {
            let t1, t2;
            if (this.state.hours[0] - this.oldest_timestamp < 24 * MSEC_PER_H) {
                t1 = moment(this.oldest_timestamp).format("LT");
                t2 = moment(this.state.hours[0]).format("LT");
            } else {
                t1 = moment(this.oldest_timestamp).format("ddd YYYY-MM-DD LT");
                t2 = moment(this.state.hours[0]).format("ddd YYYY-MM-DD LT");
            }
            nodata_alert = <Alert className="nodata" variant="info" isInline title={ cockpit.format(_("No data available between $0 and $1"), t1, t2) } />;
        }

        return (
            <div className="metrics">
                { this.state.hours.length > 0 &&
                    <section className="metrics-history">
                        <div className="metrics-label">{ _("Events") }</div>
                        <div className="metrics-label metrics-label-graph">{ _("CPU") }</div>
                        <div className="metrics-label metrics-label-graph">{ _("Memory") }</div>
                        <div className="metrics-label metrics-label-graph">{ _("Disks") }</div>
                        <div className="metrics-label metrics-label-graph">{ _("Network") }</div>

                        { this.state.hours.map(time => <MetricsHour key={time} startTime={parseInt(time)} data={this.data[time]} />) }
                    </section> }
                {nodata_alert}
                <div className="bottom-panel">
                    { this.state.loading
                        ? <EmptyStatePanel loading title={_("Loading...")} />
                        : <Button onClick={this.handleMoreData}>{_("Load earlier data")}</Button> }
                </div>
            </div>
        );
    }
}

export const Application = () => (
    <Page>
        <PageSection>
            <CurrentMetrics />
        </PageSection>
        <PageSection>
            <MetricsHistory />
        </PageSection>
    </Page>
);
