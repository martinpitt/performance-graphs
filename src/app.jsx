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

import './app.scss';

const _ = cockpit.gettext;

moment.locale(cockpit.language);

const MSEC_PER_H = 3600000;

const SvgGraph = ({ category, data }) => {
    // avoid rendering completely blank graphs for times without data
    if (data[0] === null && data[data.length - 1] === null)
        return null;

    const points = "0,0 " + // start polygon at (0, 0)
        data.map((value, index) => index.toString() + "," + value.toString()).join(" ") +
        " " + (data.length - 1) + ",0"; // close polygon

    const transform = (category === "utilization") ? "matrix(0,1,-1,0,1,0)" : "matrix(0,1,1,0,0,0)";

    return (
        <svg xmlns="http://www.w3.org/2000/svg" className={ category } viewBox={ "0 0 1 " + (data.length - 1).toString() } preserveAspectRatio="none">
            <polygon transform={transform} points={points} />
        </svg>
    );
};

// data properties are 720 values (every 5 s) from startTime
const MetricsHour = ({ startTime, use_cpu, sat_cpu, use_mem, sat_mem }) => {
    if (!use_cpu || !sat_cpu || !use_mem)
        return null;

    const graphs = [];
    for (let minute = 0; minute < 60; ++minute) {
        const dataOffset = minute * 12;

        graphs.push(
            <div key={ "cpu-timedatehere-" + minute } className="metrics-data metrics-data-cpu" style={{ "--metrics-minute": minute }} aria-hidden="true">
                <SvgGraph category="utilization" data={ use_cpu.slice(dataOffset, dataOffset + 12) } />
                <SvgGraph category="saturation" data={ sat_cpu.slice(dataOffset, dataOffset + 12) } />
            </div>);

        graphs.push(
            <div key={ "mem-timedatehere-" + minute } className="metrics-data metrics-data-memory" style={{ "--metrics-minute": minute }} aria-hidden="true">
                <SvgGraph category="utilization" data={ use_mem.slice(dataOffset, dataOffset + 12) } />
                <SvgGraph category="saturation" data={ sat_mem.slice(dataOffset, dataOffset + 12) } />
            </div>);
    }

    return (
        <div className="metrics-hour">

            <dl className="metrics-events" style={{ "--metrics-minute": 37 }}>
                <dt><time>XX:37</time>  - <time>XX:38</time></dt>
                <dd>CPU spike</dd>
                <dd>IO spike</dd>
                <dd>Network spike</dd>
            </dl>

            <dl className="metrics-events" style={{ "--metrics-minute": 3 }}>
                <dt><time>XX:03</time> - <time>XX:07</time></dt>
                <dd>Swap</dd>
            </dl>

            { graphs }
            <h3 className="metrics-time"><time>{ moment(startTime).format("LT ddd YYYY-MM-DD") }</time></h3>
        </div>
    );
};

class MetricsHistory extends React.Component {
    constructor(props) {
        super(props);
        const current_hour = Math.floor(Date.now() / MSEC_PER_H) * MSEC_PER_H;
        // metrics data: hour timestamp → array of 720 samples
        this.use_cpu = {};
        this.sat_cpu = {};
        this.use_mem = {};
        this.sat_mem = {};

        // render the last 3 hours (plus current one) initially, load more when scrolling
        // this.state = { start: current_hour - 3 * MSEC_PER_H };
        this.state = { start: current_hour };

        this.load_hour(this.state.start);
        this.load_hour(this.state.start - MSEC_PER_H);
    }

    load_hour(timestamp) {
        let use_cpu = [];
        let sat_cpu = [];
        let use_mem = [];
        let sat_mem = [];
        // last valid value, for decompression
        const current = [null, null, null, null, null, null, null];

        const metrics = cockpit.channel({
            payload: "metrics1",
            interval: 5000,
            source: "pcp-archive",
            timestamp: timestamp,
            limit: 720,
            metrics: [
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
            ]
        });

        metrics.addEventListener("message", (event, message) => {
            console.log("XXX metrics message @", timestamp, JSON.stringify(message));
            const data = JSON.parse(message);
            // meta message always comes first
            if (!Array.isArray(data)) {
                // the first datum may not be at the requested timestamp; fill up data to offset
                const nodata_offset = Math.floor((data.timestamp - timestamp) / 5000);
                const nodata_minute_offset = Math.floor(nodata_offset / 12) * 12;
                // use null blocks for "entire minute is empty" to avoid rendering SVGs
                use_cpu = Array(nodata_minute_offset).fill(null);
                use_cpu.concat(Array(nodata_offset - nodata_minute_offset).fill(0));
                sat_cpu = [...use_cpu];
                use_mem = [...use_cpu];
                sat_mem = [...use_cpu];
                return;
            }

            data.forEach(samples => {
                // decompress
                samples.forEach((sample, i) => {
                    if (i === 3) {
                        // CPU load: 3 instances (15min, 1min, 5min)
                        if (sample && sample[1] !== undefined && sample[1] !== null)
                            current[i] = sample[1];
                    } else {
                        // scalar values
                        if (sample !== null)
                            current[i] = sample;
                    }
                });
                // msec/s, normalize to 1
                use_cpu.push((current[0] + current[1] + current[2]) / 1000);
                // unitless, unbounded; clip at 10; FIXME: some better normalization?
                sat_cpu.push(Math.min(current[3], 10) / 10);
                // we assume used == total - available
                use_mem.push(1 - (current[5] / current[4]));
                /* unbounded, and mostly 0; just categorize into "nothing" (most of the time),
                   "a litte" (< 1000 pages), and "a lot" (> 1000 pages) */
                sat_mem.push(current[6] > 1000 ? 1 : (current[6] > 1 ? 0.3 : 0));
            });
        });

        metrics.addEventListener("close", (event, message) => {
            if (message.problem) {
                console.error("failed to load metrics:", JSON.stringify(message));
            } else {
                if (use_mem.length === 0)
                    console.error("metrics channel for timestamp", timestamp, "closed without getting data");
                else {
                    console.log("XXX loaded metrics for hour", moment(timestamp).format());
                    this.use_cpu[timestamp] = use_cpu;
                    console.log("XXX this.use_cpu", JSON.stringify(this.use_cpu));
                    this.sat_cpu[timestamp] = sat_cpu;
                    console.log("XXX this.sat_cpu", JSON.stringify(this.sat_cpu));
                    this.use_mem[timestamp] = use_mem;
                    console.log("XXX this.use_mem", JSON.stringify(this.use_mem));
                    this.sat_mem[timestamp] = sat_mem;
                    console.log("XXX this.sat_mem", JSON.stringify(this.sat_mem));
                    this.setState({});
                }
            }

            metrics.close();
        });
    }

    render() {
        return (
            <section className="metrics-history">
                <div className="metrics-label">{ _("Events") }</div>
                <div className="metrics-label metrics-label-graph">{ _("CPU") }</div>
                <div className="metrics-label metrics-label-graph">{ _("Memory") }</div>
                <div className="metrics-label metrics-label-graph">{ _("Disks") }</div>
                <div className="metrics-label metrics-label-graph">{ _("Network") }</div>

                <MetricsHour
                     startTime={this.state.start}
                     use_cpu={this.use_cpu[this.state.start]}
                     sat_cpu={this.sat_cpu[this.state.start]}
                     use_mem={this.use_mem[this.state.start]}
                     sat_mem={this.sat_mem[this.state.start]}
                />

                <MetricsHour
                     startTime={this.state.start - MSEC_PER_H}
                     use_cpu={this.use_cpu[this.state.start - MSEC_PER_H]}
                     sat_cpu={this.sat_cpu[this.state.start - MSEC_PER_H]}
                     use_mem={this.use_mem[this.state.start - MSEC_PER_H]}
                     sat_mem={this.sat_mem[this.state.start - MSEC_PER_H]}
                />
            </section>
        );
    }
}

export const Application = () => (
    <div className="metrics">
        <MetricsHistory />
    </div>
);
