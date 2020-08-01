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
import { Button } from '@patternfly/react-core';
import { ExclamationCircleIcon } from '@patternfly/react-icons';
import './app.scss';

const MSEC_PER_H = 3600000;
const INTERVAL = 5000;
const SAMPLES_PER_H = MSEC_PER_H / INTERVAL;
const SAMPLES_PER_MIN = SAMPLES_PER_H / 60;
const _ = cockpit.gettext;

const RESOURCES = {
    use_cpu: { name: _("CPU usage"), event_description: _("CPU spike") },
    sat_cpu: { name: _("Load"), event_description: _("Load spike") },
    use_memory: { name: _("Memory usage"), event_description: _("Memory spike") },
    sat_memory: { name: _("Swap out pages"), event_description: _("Swap") },
};

const METRICS = [
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
];

moment.locale(cockpit.language);

const SvgGraph = ({ category, data, valid, datakey }) => {
    let points = "";
    if (valid) {
        points = "0,0 " + // start polygon at (0, 0)
            data.map((samples, index) => (samples ? samples[datakey].toString() : "0") + "," + index.toString()).join(" ") +
            " 0," + (data.length - 1); // close polygon
    }

    const ymax = (SAMPLES_PER_MIN - 1).toString();
    const transform = (category === "utilization") ? ("matrix(-1,0,0,-1,1," + ymax + ")") : ("matrix(1,0,0,-1,0," + ymax + ")");

    if (valid)
        return (
            <svg xmlns="http://www.w3.org/2000/svg" className={ category + (category === "utilization" ? " full-line" : "") } viewBox={ "0 0 1 " + ymax } preserveAspectRatio="none">
                <polygon transform={transform} points={points} />
            </svg>);
    else if (category === "utilization")
        return <div className="dotted-line" />;
    else
        return null;
};

// data: type → SAMPLES_PER_H objects from startTime
const MetricsHour = ({ startTime, data }) => {
    // compute graphs
    const graphs = [];
    for (let minute = 0; minute < 60; ++minute) {
        const dataOffset = minute * SAMPLES_PER_MIN;
        const dataSlice = data.slice(dataOffset, dataOffset + SAMPLES_PER_MIN);
        const valid = dataSlice.some(i => i !== null);

        ['cpu', 'memory'].forEach(resource => {
            graphs.push(
                <div
                    key={ resource + startTime + minute }
                    className={ ("metrics-data metrics-data-" + resource) + (valid ? " valid-data" : " empty-data")}
                    style={{ "--metrics-minute": minute }}
                    aria-hidden="true"
                >
                    <SvgGraph category="utilization" data={ dataSlice } valid={ valid } datakey={ "use_" + resource } />
                    <SvgGraph category="saturation" data={ dataSlice } valid={ valid } datakey={ "sat_" + resource } />
                </div>);
        });
    }

    // compute spike events
    const minute_events = {};
    for (const type in RESOURCES) {
        let prev_val = data[0] ? data[0][type] : null;
        data.some((samples, i) => {
            if (samples === null)
                return;
            const value = samples[type];
            if (prev_val !== null && value - prev_val > 0.25) { // TODO: adjust slope
                const minute = Math.floor(i / SAMPLES_PER_MIN);
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
            <dl key={minute} className="metrics-events" style={{ "--metrics-minute": minute }}>
                <dt><time>{ moment(startTime + (minute * 60000)).format('hh:mm') }</time></dt>
                { minute_events[minute].map(t => <dd key={ t }>{ RESOURCES[t].event_description }</dd>) }
            </dl>);
    }

    // FIXME: throttle-debounce this
    const onMouseOver = ev => {
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
            console.log("XXX mouseover hour", startTime, "minute", minute, JSON.stringify(sample), "indexOffset", indexOffset, "time", time);
            // FIXME: render this more tastefully
            let tooltip = time + ":\n";
            for (const t in sample)
                tooltip += `${RESOURCES[t].name}: ${sample[t]}\n`;
            hourElement.setAttribute("title", tooltip);
        } else {
            console.log("mouseover leave");
            hourElement.removeAttribute("title");
        }
    };

    return (
        <div id={ "metrics-hour-" + startTime.toString() } className="metrics-hour" onMouseOver={onMouseOver}>
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

        this.state = {
            hours: [], // available hours for rendering in descending order
            loading: true, // show loading indicator
            metricsAvailable: true,
            error: null,
        };

        // load and render the last 24 hours (plus current one) initially
        // FIXME: load less up-front, load more when scrolling
        cockpit.spawn(["date", "+%s"])
                .then(out => {
                    const now = parseInt(out.trim()) * 1000;
                    const current_hour = Math.floor(now / MSEC_PER_H) * MSEC_PER_H;
                    this.load_data(current_hour - 24 * MSEC_PER_H);
                })
                .catch(ex => this.setState({ error: ex.toString() }));
    }

    load_data(load_timestamp, limit) {
        let current_hour; // hour of timestamp, from most recent meta message
        let hour_index; // index within data[current_hour] array
        const current_sample = Array(METRICS.length).fill(null); // last valid value, for decompression
        const new_hours = {}; // set of newly seen hours during this load

        const metrics = cockpit.channel({
            payload: "metrics1",
            interval: INTERVAL,
            source: "pcp-archive",
            timestamp: load_timestamp,
            limit: limit,
            metrics:  METRICS,
        });

        metrics.addEventListener("message", (event, message) => {
            console.log("XXX metrics message", message);
            message = JSON.parse(message);

            const init_current_hour = () => {
                if (!this.data[current_hour]) {
                    this.data[current_hour] = Array(SAMPLES_PER_H).fill(null);
                    new_hours[current_hour] = true;
                }
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
                    if (i === 3) {
                        // CPU load: 3 instances (15min, 1min, 5min)
                        if (sample && sample[1] !== undefined && sample[1] !== null && sample[1] !== false)
                            current_sample[i] = sample[1];
                    } else {
                        // scalar values
                        if (sample !== null && sample !== false)
                            current_sample[i] = sample;
                    }
                });

                this.data[current_hour][hour_index] = {
                    // msec/s, normalize to 1
                    use_cpu: (current_sample[0] + current_sample[1] + current_sample[2]) / 1000,
                    // unitless, unbounded; clip at 10; FIXME: some better normalization?
                    sat_cpu: Math.min(current_sample[3], 10) / 10,
                    // we assume used == total - available
                    use_memory: 1 - (current_sample[5] / current_sample[4]),
                    /* unbounded, and mostly 0; just categorize into "nothing" (most of the time),
                       "a litte" (< 1000 pages), and "a lot" (> 1000 pages) */
                    sat_memory: current_sample[6] > 1000 ? 1 : (current_sample[6] > 1 ? 0.3 : 0),
                };

                if (++hour_index === SAMPLES_PER_H) {
                    current_hour += MSEC_PER_H;
                    hour_index = 0;
                    init_current_hour();
                    console.log("XXX hour overflow, advancing to", current_hour, "=", moment(current_hour).format());
                }
            });
        });

        metrics.addEventListener("close", (event, message) => {
            if (message.problem) {
                this.setState({
                    loading: false,
                    metricsAvailable: false,
                });
            } else {
                console.log("XXX loaded metrics for timestamp", moment(load_timestamp).format(), "new hours", JSON.stringify(Object.keys(new_hours)));
                Object.keys(new_hours).forEach(hour => console.log("hour", hour, "data", JSON.stringify(this.data[hour])));

                const hours = this.state.hours.concat(Object.keys(new_hours));
                // sort in descending order
                hours.sort((a, b) => b - a);
                // re-render
                this.setState({ hours, loading: false });
            }

            metrics.close();
        });
    }

    render() {
        if (this.state.loading)
            return <EmptyStatePanel loading title={_("Loading...")} />;

        if (cockpit.manifests && !cockpit.manifests.pcp)
            return <EmptyStatePanel
                        icon={ExclamationCircleIcon}
                        title={_("Package cockpit-pcp is missing")}
                        action={<Button onClick={() => console.log("Installing cockpit-pcp...")}>{_("Install cockpit-pcp")}</Button>} />;

        if (!this.state.metricsAvailable)
            return <EmptyStatePanel
                        icon={ExclamationCircleIcon}
                        title={_("Metrics could not be loaded")}
                        paragraph={_("Is 'pmlogger' service running?")}
                        action={<Button variant="link" onClick={() => cockpit.jump("/system/services#/pmlogger.service") }>{_("Troubleshoot")}</Button>} />;

        if (this.state.error)
            return <EmptyStatePanel
                        icon={ExclamationCircleIcon}
                        title={_("Error has occured")}
                        paragraph={this.state.error} />;

        return (
            <section className="metrics-history">
                <div className="metrics-label">{ _("Events") }</div>
                <div className="metrics-label metrics-label-graph">{ _("CPU") }</div>
                <div className="metrics-label metrics-label-graph">{ _("Memory") }</div>
                <div className="metrics-label metrics-label-graph">{ _("Disks") }</div>
                <div className="metrics-label metrics-label-graph">{ _("Network") }</div>

                { this.state.hours.map(time => <MetricsHour key={time} startTime={parseInt(time)} data={this.data[time]} />) }
            </section>
        );
    }
}

export const Application = () => (
    <div className="metrics">
        <MetricsHistory />
    </div>
);
