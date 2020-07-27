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

const SvgGraph = ({ category, data }) => {
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

// data is 720 values (every 5 s) from startTime
const MetricsHour = ({ startTime, data }) => {
    const graphs = [];
    for (let minute = 0; minute < 60; ++minute) {
        const dataOffset = minute * 12;

        graphs.push(
            <div key={ "cpu-timedatehere-" + minute } className="metrics-data metrics-data-cpu" style={{ "--metrics-minute": minute }} aria-hidden="true">
                <SvgGraph category="utilization" data={ [0.2, 0.5, 1.0, 0.7, 0.5, 0.6] } />
                <SvgGraph category="saturation" data={ [0.1, 0.1, 0.5, 0.9, 0.5, 0.1] } />
            </div>);

        graphs.push(
            <div key={ "mem-timedatehere-" + minute } className="metrics-data metrics-data-memory" style={{ "--metrics-minute": minute }} aria-hidden="true">
                <SvgGraph category="utilization" data={ data.slice(dataOffset, dataOffset + 12) } />
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
        const MSEC_PER_H = 3600000;
        const current_hour = Math.floor(Date.now() / MSEC_PER_H) * MSEC_PER_H;
        this.use_mem = {}; // hour timestamp → array of 720 metrics samples

        // render the last 3 hours (plus current one) initially, load more when scrolling
        // this.state = { start: current_hour - 3 * MSEC_PER_H };
        this.state = { start: current_hour };

        this.load_hour(this.state.start);
    }

    load_hour(timestamp) {
        const use_mem = [];
        // last valid value, for decompression
        const current = [null, null];

        const metrics = cockpit.channel({
            payload: "metrics1",
            interval: 5000,
            source: "pcp-archive",
            timestamp: timestamp,
            limit: 720,
            metrics: [
                { name: "mem.physmem" },
                // mem.util.used is useless, it includes cache
                { name: "mem.util.available" },
            ]
        });

        metrics.addEventListener("message", (event, message) => {
            console.log("XXX metrics message", JSON.stringify(message));
            const data = JSON.parse(message);
            // meta message always comes first, ignore
            if (!Array.isArray(data))
                return;
            data.forEach(samples => {
                // decompress
                samples.forEach((sample, i) => {
                    if (sample !== null)
                        current[i] = sample;
                });
                // we assume used == total - available
                use_mem.push(1 - (current[1] / current[0]));
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
                    this.use_mem[timestamp] = use_mem;
                    console.log("XXX this.use_mem", JSON.stringify(this.use_mem));
                    this.setState({});
                }
            }

            metrics.close();
        });
    }

    render() {
        const data = this.use_mem[this.state.start];

        return (
            <section className="metrics-history">
                <div className="metrics-label">{ _("Events") }</div>
                <div className="metrics-label metrics-label-graph">{ _("CPU") }</div>
                <div className="metrics-label metrics-label-graph">{ _("Memory") }</div>
                <div className="metrics-label metrics-label-graph">{ _("Disks") }</div>
                <div className="metrics-label metrics-label-graph">{ _("Network") }</div>

                { data && <MetricsHour startTime={this.state.start} data={data} /> }
            </section>
        );
    }
}

export const Application = () => (
    <div className="metrics">
        <MetricsHistory />
    </div>
);
