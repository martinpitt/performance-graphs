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

const MSEC_PER_H = 3600000;
const _ = cockpit.gettext;

const EVENT_DESCRIPTION = {
    use_cpu: _("CPU spike"),
    sat_cpu: _("Load spike"),
    use_memory: _("Memory spike"),
    sat_memory: ("Swap"),
};

moment.locale(cockpit.language);

const SvgGraph = ({ category, data }) => {
    // avoid rendering completely blank graphs for times without data
    if (data[0] === null && data[data.length - 1] === null)
        return null;

    const points = "0,0 " + // start polygon at (0, 0)
        data.map((value, index) => index.toString() + "," + value.toString()).join(" ") +
        " " + (data.length - 1) + ",0"; // close polygon

    const transform = (category === "utilization") ? "matrix(0,1,-1,0,1,0)" : "matrix(0,1,1,0,0,0)";
    const ymax = (data.length - 1).toString(); // TODO: hardcode to 12 and ignore missing data?

    return (
        <svg xmlns="http://www.w3.org/2000/svg" className={ category } viewBox={ "0 0 1 " + ymax } preserveAspectRatio="none">
            <polygon transform={transform} points={points} />
            { category === "utilization" && <line x1="1" y1="0" x2="1" y2={ ymax } stroke="black" strokeWidth="0.015" /> }
            <line x1="1" y1="0" x2="0" y2="0" stroke="black" strokeWidth="0.015" />
        </svg>
    );
};

// data: type → 720 values (every 5 s) from startTime
const MetricsHour = ({ startTime, data }) => {
    if (!data)
        return null;

    // compute graphs
    const graphs = [];
    for (let minute = 0; minute < 60; ++minute) {
        const dataOffset = minute * 12;

        ['cpu', 'memory'].forEach(resource => {
            graphs.push(
                <div
                    key={ resource + startTime + minute }
                    className={ "metrics-data metrics-data-" + resource }
                    style={{ "--metrics-minute": minute }}
                    aria-hidden="true"
                >
                    <SvgGraph category="utilization" data={ data["use_" + resource].slice(dataOffset, dataOffset + 12) } />
                    <SvgGraph category="saturation" data={ data["sat_" + resource].slice(dataOffset, dataOffset + 12) } />
                </div>);
        });
    }

    // compute spike events
    const minute_events = {};
    for (const type in data) {
        let prev_val = data[type][0];
        data[type].some((value, i) => {
            if (value === null)
                return;
            if (value - prev_val > 0.25) { // TODO: adjust slope
                const minute = Math.floor(i / 12);
                if (minute_events[minute] === undefined)
                    minute_events[minute] = [];
                minute_events[minute].push(type);
                return true;
            }
            prev_val = value;
            return false;
        });
    }

    const events = [];
    for (const minute in minute_events) {
        events.push(
            <dl className="metrics-events" style={{ "--metrics-minute": minute }}>
                <dt><time>{ moment(startTime + (minute * 60000)).format('hh:mm') }</time></dt>
                { minute_events[minute].map(t => <dd key={ t }>{ EVENT_DESCRIPTION[t] }</dd>) }
            </dl>);
    }

    return (
        <div className="metrics-hour">
            { events }
            { graphs }
            <h3 className="metrics-time"><time>{ moment(startTime).format("LT ddd YYYY-MM-DD") }</time></h3>
        </div>
    );
};

class MetricsHistory extends React.Component {
    constructor(props) {
        super(props);
        const current_hour = Math.floor(Date.now() / MSEC_PER_H) * MSEC_PER_H;
        // metrics data: hour timestamp → type → array of 720 samples
        this.data = {};

        // render the last 24 hours (plus current one) initially
        // FIXME: load less up-front, load more when scrolling
        this.state = { start: current_hour - 24 * MSEC_PER_H };

        for (let hour = current_hour; hour >= this.state.start; hour -= MSEC_PER_H)
            this.load_hour(hour);
    }

    load_hour(timestamp) {
        const data = {};
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
            const batch = JSON.parse(message);
            // meta message always comes first
            if (!Array.isArray(batch)) {
                // the first datum may not be at the requested timestamp; fill up data to offset
                const nodata_offset = Math.floor((batch.timestamp - timestamp) / 5000);
                const nodata_minute_offset = Math.floor(nodata_offset / 12) * 12;
                // use null blocks for "entire minute is empty" to avoid rendering SVGs
                for (const type in EVENT_DESCRIPTION) {
                    data[type] = Array(nodata_minute_offset).fill(null);
                    data[type].concat(Array(nodata_offset - nodata_minute_offset).fill(0));
                }
                return;
            }

            batch.forEach(samples => {
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
                data.use_cpu.push((current[0] + current[1] + current[2]) / 1000);
                // unitless, unbounded; clip at 10; FIXME: some better normalization?
                data.sat_cpu.push(Math.min(current[3], 10) / 10);
                // we assume used == total - available
                data.use_memory.push(1 - (current[5] / current[4]));
                /* unbounded, and mostly 0; just categorize into "nothing" (most of the time),
                   "a litte" (< 1000 pages), and "a lot" (> 1000 pages) */
                data.sat_memory.push(current[6] > 1000 ? 1 : (current[6] > 1 ? 0.3 : 0));
            });
        });

        metrics.addEventListener("close", (event, message) => {
            if (message.problem) {
                console.error("failed to load metrics:", JSON.stringify(message));
            } else {
                if (data.use_memory.length === 0)
                    console.error("metrics channel for timestamp", timestamp, "closed without getting data");
                else {
                    console.log("XXX loaded metrics for hour", moment(timestamp).format());
                    this.data[timestamp] = data;
                    console.log("XXX this.data", JSON.stringify(this.data));
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

                { Object.keys(this.data).map(time => <MetricsHour key={time} startTime={parseInt(time)} data={this.data[time]} />) }
            </section>
        );
    }
}

export const Application = () => (
    <div className="metrics">
        <MetricsHistory />
    </div>
);
