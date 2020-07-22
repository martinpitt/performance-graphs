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
import {
    DataList, DataListItem, DataListItemRow, DataListItemCells, DataListCell,
    Page, PageSection, PageSectionVariants,
} from '@patternfly/react-core';

import moment from "moment";

import './app.scss';

const _ = cockpit.gettext;

moment.locale(cockpit.language);

const PerformanceDataItem = ({ start, end }) => (
    <DataListItem aria-labelledby={ "time-" + start }>
        <DataListItemRow>
            <DataListItemCells
                variant={PageSectionVariants.light}
                dataListCells={ [
                    <DataListCell key="time" width="4">
                        <span id={ "time-" + start }>{ moment(start).format("LT ddd YYYY-MM-DD") }</span>
                    </DataListCell>,
                    <DataListCell key="cpu">cdata</DataListCell>,
                    <DataListCell key="memory">mdata</DataListCell>,
                ] }
            />
        </DataListItemRow>
    </DataListItem>
);

export class Application extends React.Component {
    constructor() {
        super();
        this.state = { };
    }

    render() {
        const header = (
            <DataListItem>
                <DataListItemRow>
                    <DataListItemCells
                        variant={PageSectionVariants.light}
                        dataListCells={ [
                            <DataListCell key="time" width="4" />,
                            <DataListCell key="cpu">{ _("CPU") }</DataListCell>,
                            <DataListCell key="memory">{ _("Memory") }</DataListCell>,
                        ] }
                    />
                </DataListItemRow>
            </DataListItem>);

        // demo: only show current hour
        const now = Date.now();
        const curr = <PerformanceDataItem start={ now - 3600000 } end={ now } />;

        return (
            <Page>
                <PageSection variant={PageSectionVariants.light}>
                    <DataList aria-label={ _("Performance graphs") }>
                        {header}
                        {curr}
                    </DataList>
                </PageSection>
            </Page>
        );
    }
}
