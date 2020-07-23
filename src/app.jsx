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

class MetricsHistory extends React.Component {
    render() {
        // demo: only show current hour
        const now = Date.now();
        const start = now - 3600000;

        const data = [];
        for (let i = 0; i < 60; ++i) {
            data.push(
                <div key={ "cpu-timedatehere-" + i } className="metrics-data metrics-data-cpu" style={{ "--metrics-minute": i }} aria-hidden="true">
                    <SvgGraph category="utilization" data={ [0.2, 0.5, 1.0, 0.7, 0.5, 0.6] } />
                    <SvgGraph category="saturation" data={ [0.1, 0.1, 0.5, 0.9, 0.5, 0.1] } />
                </div>);

            data.push(
                <div key={ "mem-timedatehere-" + i } className="metrics-data metrics-data-memory" style={{ "--metrics-minute": i }} aria-hidden="true">
                    <SvgGraph category="utilization" data={ [0.6, 0.6, 1.0, 1.0, 0.5, 0.5] } />
                </div>);
        }

        return (
            <section className="metrics-history">
                <div className="metrics-label">{ _("Events") }</div>
                <div className="metrics-label metrics-label-graph">{ _("CPU") }</div>
                <div className="metrics-label metrics-label-graph">{ _("Memory") }</div>
                <div className="metrics-label metrics-label-graph">{ _("Disks") }</div>
                <div className="metrics-label metrics-label-graph">{ _("Network") }</div>

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

                    { data }
                    <h3 className="metrics-time"><time>{ moment(start).format("LT ddd YYYY-MM-DD") }</time></h3>
                </div>
            </section>
        );
    }
}

export const Application = () => (
    <div className="metrics">
        <MetricsHistory />
    </div>
);
