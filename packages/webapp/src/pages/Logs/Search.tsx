import { LeftNavBarItems } from '../../components/LeftNavBar';
import DashboardLayout from '../../layout/DashboardLayout';
import { useStore } from '../../store';
import Info from '../../components/ui/Info';
import { Loading } from '@geist-ui/core';
import { useSearchOperations } from '../../hooks/useLogs';
import * as Table from '../../components/ui/Table';
import { getCoreRowModel, useReactTable, flexRender } from '@tanstack/react-table';

import { MultiSelect } from './components/MultiSelect';
import { columns, integrationsDefaultOptions, statusDefaultOptions, statusOptions, syncsDefaultOptions, typesDefaultOptions } from './constants';
import { useEffect, useMemo, useState } from 'react';
import type { SearchOperationsIntegration, SearchOperationsPeriod, SearchOperationsState, SearchOperationsSync, SearchOperationsType } from '@nangohq/types';
import Spinner from '../../components/ui/Spinner';
import { OperationRow } from './components/OperationRow';
// import { Input } from '../../components/ui/input/Input';
// import { MagnifyingGlassIcon } from '@radix-ui/react-icons';
import { formatQuantity } from '../../utils/utils';
import { Link, useSearchParams } from 'react-router-dom';
import { useInterval } from 'react-use';
import Button from '../../components/ui/button/Button';
import { LightningBoltIcon } from '@radix-ui/react-icons';
import { SearchableMultiSelect } from './components/SearchableMultiSelect';
import { TypesSelect } from './components/TypesSelect';

export const LogsSearch: React.FC = () => {
    const env = useStore((state) => state.env);
    const [searchParams, setSearchParams] = useSearchParams();

    // State
    const [hasLogs, setHasLogs] = useState<boolean>(false);
    const [synced, setSynced] = useState(false);

    // Data fetch
    const [states, setStates] = useState<SearchOperationsState[]>(statusDefaultOptions);
    const [types, setTypes] = useState<SearchOperationsType[]>(typesDefaultOptions);
    const [integrations, setIntegrations] = useState<SearchOperationsIntegration[]>(integrationsDefaultOptions);
    const [connections, setConnections] = useState<SearchOperationsIntegration[]>(integrationsDefaultOptions);
    const [syncs, setSyncs] = useState<SearchOperationsSync[]>(syncsDefaultOptions);
    const [period, setPeriod] = useState<SearchOperationsPeriod | undefined>();
    const { data, error, loading, trigger } = useSearchOperations(synced, env, { limit: 20, states, types, integrations, connections, syncs });

    const table = useReactTable({
        data: data ? data.data : [],
        columns,
        getCoreRowModel: getCoreRowModel()
    });

    useEffect(
        function syncQueryParamsToState() {
            // Sync the query params to the react state, it allows to share the URL
            // we do it only on load, after that we don't care about the update
            if (synced) {
                return;
            }

            const tmpStates = searchParams.get('states');
            setStates(tmpStates ? (tmpStates.split(',') as any) : statusDefaultOptions);

            const tmpIntegrations = searchParams.get('integrations');
            setIntegrations(tmpIntegrations ? (tmpIntegrations.split(',') as any) : integrationsDefaultOptions);

            const tmpConnections = searchParams.get('integrations');
            setIntegrations(tmpConnections ? (tmpConnections.split(',') as any) : integrationsDefaultOptions);

            const tmpSyncs = searchParams.get('syncs');
            setSyncs(tmpSyncs ? (tmpSyncs.split(',') as any) : syncsDefaultOptions);

            const tmpTypes = searchParams.get('types');
            setTypes(tmpTypes ? (tmpTypes.split(',') as any) : typesDefaultOptions);

            const tmpFrom = searchParams.get('from');
            const tmpTo = searchParams.get('to');
            setPeriod(tmpFrom && tmpTo ? { from: tmpFrom, to: tmpTo } : undefined);

            setSynced(true);
        },
        [searchParams, synced]
    );

    useEffect(
        function syncStateToQueryParams() {
            // Sync the state back to the URL for sharing
            const tmp = new URLSearchParams({
                states: states as any,
                integrations: integrations as any,
                connections: connections as any,
                syncs: syncs as any,
                types: types as any
            });
            if (period) {
                tmp.set('from', period.from);
                tmp.set('to', period.to);
            }
            setSearchParams(tmp);
        },
        [states, integrations, period, connections, syncs, types]
    );

    useEffect(() => {
        if (!loading) {
            // We set this so it does not flicker when we go from a state of "filtered no records" to "default with records"...
            // ...to not redisplay the empty state
            setHasLogs(true);
        }
    }, [loading]);

    useInterval(
        () => {
            // Auto refresh
            trigger();
        },
        synced ? 10000 : null
    );

    const total = useMemo(() => {
        if (!data?.pagination) {
            return 0;
        }
        return formatQuantity(data.pagination.total);
    }, [data?.pagination]);

    if (error) {
        return (
            <DashboardLayout selectedItem={LeftNavBarItems.Logs} marginBottom={60}>
                <h2 className="text-3xl font-semibold text-white mb-4">Logs</h2>
                {error.error.code === 'feature_disabled' ? (
                    <div className="flex gap-2 flex-col border border-border-gray rounded-md items-center text-white text-center p-10 py-20">
                        <h2 className="text-xl text-center">Logs not configured</h2>
                        <div className="text-sm text-gray-400">
                            Follow{' '}
                            <Link to="https://docs.nango.dev/host/self-host/self-hosting-instructions#logs" className="text-blue-400">
                                these instructions
                            </Link>{' '}
                            to configure logs.
                        </div>
                    </div>
                ) : (
                    <Info color={'red'} classNames="text-xs" size={20}>
                        An error occurred, refresh your page or reach out to the support.
                    </Info>
                )}
            </DashboardLayout>
        );
    }

    if ((loading && !data) || !data) {
        return (
            <DashboardLayout selectedItem={LeftNavBarItems.Logs} marginBottom={60}>
                <Loading spaceRatio={2.5} className="-top-36" />
            </DashboardLayout>
        );
    }

    if (data.pagination.total <= 0 && !hasLogs) {
        return (
            <DashboardLayout selectedItem={LeftNavBarItems.Logs} marginBottom={60}>
                <h2 className="text-3xl font-semibold text-white mb-4">Logs</h2>

                <div className="flex flex-col border border-zinc-500 rounded items-center text-white text-center py-24 gap-2">
                    <h2 className="text-xl">You don&apos;t have logs yet.</h2>
                    <div className="text-sm text-zinc-400">Note that logs older than 15 days are automatically cleared.</div>
                </div>
            </DashboardLayout>
        );
    }

    return (
        <DashboardLayout selectedItem={LeftNavBarItems.Logs} marginBottom={60}>
            <div className="flex justify-between items-center">
                <h2 className="text-3xl font-semibold text-white mb-4 flex gap-4 items-center">Logs {loading && <Spinner size={1} />}</h2>
                <div className="text-white text-xs">{total} logs found</div>
            </div>

            <div className="flex gap-2 justify-between">
                <div className="w-full">{/* <Input before={<MagnifyingGlassIcon className="w-5 h-5" />} placeholder="Search operations..." /> */}</div>
                <MultiSelect label="Status" options={statusOptions} selected={states} defaultSelect={statusDefaultOptions} onChange={setStates} all />
                <TypesSelect selected={types} onChange={setTypes} />
                <SearchableMultiSelect label="Integration" selected={integrations} category={'integration'} onChange={setIntegrations} />
                <SearchableMultiSelect label="Connection" selected={connections} category={'connection'} onChange={setConnections} />
                <SearchableMultiSelect label="Script" selected={syncs} category={'syncConfig'} onChange={setSyncs} />
                <Button variant="zombieGray" size={'xs'}>
                    <LightningBoltIcon />
                    Live
                </Button>
            </div>

            <Table.Table className="my-4 table-fixed">
                <Table.Header>
                    {table.getHeaderGroups().map((headerGroup) => (
                        <Table.Row key={headerGroup.id}>
                            {headerGroup.headers.map((header) => {
                                return (
                                    <Table.Head
                                        key={header.id}
                                        style={{
                                            width: header.getSize()
                                        }}
                                    >
                                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                                    </Table.Head>
                                );
                            })}
                        </Table.Row>
                    ))}
                </Table.Header>
                <Table.Body>
                    {table.getRowModel().rows?.length ? (
                        table.getRowModel().rows.map((row) => <OperationRow key={row.id} row={row} />)
                    ) : (
                        <Table.Row>
                            <Table.Cell colSpan={columns.length} className="h-24 text-center">
                                No results.
                            </Table.Cell>
                        </Table.Row>
                    )}
                </Table.Body>
            </Table.Table>
        </DashboardLayout>
    );
};