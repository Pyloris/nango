import tracer from 'dd-trace';
import type { OrchestratorTask, TaskWebhook, TaskAction, TaskPostConnection, TaskSync } from '@nangohq/nango-orchestrator';
import { jsonSchema } from '@nangohq/nango-orchestrator';
import type { JsonValue } from 'type-fest';
import { Err, Ok, metrics, stringifyError } from '@nangohq/utils';
import type { Result } from '@nangohq/utils';
import type { Job } from '@nangohq/shared';
import {
    configService,
    createSyncJob,
    environmentService,
    errorManager,
    ErrorSourceEnum,
    getLastSyncDate,
    getRunnerFlags,
    getSyncByIdAndName,
    getSyncConfigRaw,
    SyncRunService,
    SyncStatus,
    SyncType,
    updateSyncJobStatus
} from '@nangohq/shared';
import { sendSync } from '@nangohq/webhooks';
import type { LogContext } from '@nangohq/logs';
import { logContextGetter } from '@nangohq/logs';
import { records as recordsService } from '@nangohq/records';
import integrationService from '../integration.service.js';
import { bigQueryClient, slackService } from '../clients.js';

export async function handler(task: OrchestratorTask): Promise<Result<JsonValue>> {
    task.abortController.signal.onabort = () => {
        abort(task);
    };
    if (task.isSync()) {
        const span = tracer.startSpan('jobs.handler.sync');
        return await tracer.scope().activate(span, async () => {
            const start = Date.now();
            const res = await sync(task);
            if (res.isErr()) {
                metrics.increment(metrics.Types.SYNC_FAILURE);
            } else {
                metrics.increment(metrics.Types.SYNC_SUCCESS);
                metrics.duration(metrics.Types.SYNC_TRACK_RUNTIME, Date.now() - start);
            }
            span.finish();
            return res;
        });
    }
    if (task.isAction()) {
        const span = tracer.startSpan('jobs.handler.action');
        return await tracer.scope().activate(span, async () => {
            const res = await action(task);
            span.finish();
            return res;
        });
    }
    if (task.isWebhook()) {
        const span = tracer.startSpan('jobs.handler.webhook');
        return await tracer.scope().activate(span, async () => {
            const res = webhook(task);
            span.finish();
            return res;
        });
    }
    if (task.isPostConnection()) {
        const span = tracer.startSpan('jobs.handler.postConnection');
        return await tracer.scope().activate(span, async () => {
            const res = postConnection(task);
            span.finish();
            return res;
        });
    }
    return Err(`Unreachable`);
}

async function abort(task: OrchestratorTask): Promise<Result<void>> {
    try {
        if (task.isSync()) {
            await integrationService.cancelScript(task.syncId);
            return Ok(undefined);
        }
        return Err(`Failed to cancel. Task type not supported`);
    } catch (err) {
        return Err(`Failed to cancel: ${stringifyError(err)}`);
    }
}

async function sync(task: TaskSync): Promise<Result<JsonValue>> {
    let logCtx: LogContext | undefined;
    let syncJob: Pick<Job, 'id'> | null = null;
    let lastSyncDate: Date | null = null;
    let syncType: SyncType | null = null;
    try {
        lastSyncDate = await getLastSyncDate(task.syncId);
        const providerConfig = await configService.getProviderConfig(task.connection.provider_config_key, task.connection.environment_id);
        if (providerConfig === null) {
            return Err(`Provider config not found for connection: ${task.connection}. TaskId: ${task.id}`);
        }

        syncType = lastSyncDate ? SyncType.INCREMENTAL : SyncType.FULL;
        syncJob = await createSyncJob(task.syncId, syncType, SyncStatus.RUNNING, task.name, task.connection, task.id);
        if (!syncJob) {
            return Err(`Failed to create sync job for sync: ${task.syncId}. TaskId: ${task.id}`);
        }

        const syncConfig = await getSyncConfigRaw({
            environmentId: providerConfig.environment_id,
            config_id: providerConfig.id!,
            name: task.syncName,
            isAction: false
        });

        if (!syncConfig) {
            return Err(`Sync config not found. TaskId: ${task.id}`);
        }

        const accountAndEnv = await environmentService.getAccountAndEnvironment({ environmentId: task.connection.environment_id });
        if (!accountAndEnv) {
            return Err(`Account and environment not found. TaskId: ${task.id}`);
        }
        const { account, environment } = accountAndEnv;

        logCtx = await logContextGetter.create(
            { operation: { type: 'sync', action: 'run' }, message: 'Sync' },
            {
                account,
                environment,
                integration: { id: providerConfig.id!, name: providerConfig.unique_key, provider: providerConfig.provider },
                connection: { id: task.connection.id, name: task.connection.connection_id },
                syncConfig: { id: syncConfig.id!, name: syncConfig.sync_name }
            }
        );

        if (task.debug) {
            await logCtx.info('Starting sync', {
                syncType: syncType,
                syncName: task.syncName,
                syncId: task.syncId,
                syncJobId: syncJob.id,
                attempt: task.attempt,
                executionId: task.id
            });
        }

        const syncRun = new SyncRunService({
            bigQueryClient,
            integrationService,
            recordsService,
            slackService,
            sendSyncWebhook: sendSync,
            writeToDb: true,
            syncId: task.syncId,
            syncJobId: syncJob.id,
            nangoConnection: task.connection,
            syncConfig,
            syncType: syncType,
            activityLogId: logCtx.id,
            provider: providerConfig.provider,
            debug: task.debug,
            logCtx,
            runnerFlags: await getRunnerFlags()
        });

        const { success, error, response } = await syncRun.run();
        if (!success) {
            return Err(`Sync failed with error ${error}. TaskId: ${task.id}`);
        }
        const res = jsonSchema.safeParse(response);
        if (!res.success) {
            return Err(`Invalid sync response format: ${response}. TaskId: ${task.id}`);
        }
        await updateSyncJobStatus(syncJob.id, SyncStatus.SUCCESS);
        return Ok(res.data);
    } catch (err) {
        const prettyError = stringifyError(err, { pretty: true });
        const content = `The ${syncType || ''} sync failed to run: ${prettyError}`;
        if (logCtx) {
            await logCtx.error(content, { error: err });
            await logCtx.failed();
        }

        errorManager.report(content, {
            environmentId: task.connection.environment_id,
            source: ErrorSourceEnum.PLATFORM,
            operation: syncType || '',
            metadata: {
                connectionId: task.connection.connection_id,
                providerConfigKey: task.connection.provider_config_key,
                syncType,
                syncName: task.syncName
            }
        });

        if (syncJob) {
            await updateSyncJobStatus(syncJob.id, SyncStatus.ERROR);
        }

        return Err(`Failed sync run: ${prettyError}. TaskId: ${task.id}`);
    }
}

async function action(task: TaskAction): Promise<Result<JsonValue>> {
    const providerConfig = await configService.getProviderConfig(task.connection.provider_config_key, task.connection.environment_id);
    if (providerConfig === null) {
        return Err(`Provider config not found for connection: ${task.connection.connection_id}`);
    }

    const syncConfig = await getSyncConfigRaw({
        environmentId: providerConfig.environment_id,
        config_id: providerConfig.id!,
        name: task.actionName,
        isAction: true
    });
    if (!syncConfig) {
        return Err(`Action config not found: ${task.id}`);
    }

    const syncRun = new SyncRunService({
        bigQueryClient,
        integrationService,
        recordsService,
        slackService,
        writeToDb: true,
        sendSyncWebhook: sendSync,
        logCtx: await logContextGetter.get({ id: String(task.activityLogId) }),
        nangoConnection: task.connection,
        syncConfig,
        isAction: true,
        syncType: SyncType.ACTION,
        activityLogId: task.activityLogId,
        input: task.input as object, // TODO: fix type after temporal is removed
        provider: providerConfig.provider,
        debug: false,
        runnerFlags: await getRunnerFlags()
    });

    const { error, response } = await syncRun.run();
    if (error) {
        return Err(error);
    }

    const res = jsonSchema.safeParse(response);
    if (!res.success) {
        return Err(`Invalid action response format: ${response}. TaskId: ${task.id}`);
    }

    return Ok(res.data);
}

async function webhook(task: TaskWebhook): Promise<Result<JsonValue>> {
    const providerConfig = await configService.getProviderConfig(task.connection.provider_config_key, task.connection.environment_id);
    if (providerConfig === null) {
        return Err(`Provider config not found for connection: ${task.connection.connection_id}`);
    }

    const sync = await getSyncByIdAndName(task.connection.id, task.parentSyncName);
    if (!sync) {
        return Err(`Sync not found for connection: ${task.connection.connection_id}`);
    }

    const syncConfig = await getSyncConfigRaw({
        environmentId: providerConfig.environment_id,
        config_id: providerConfig.id!,
        name: task.parentSyncName,
        isAction: false
    });
    if (!syncConfig) {
        return Err(`Action config not found. TaskId: ${task.id}`);
    }

    const syncJobId = await createSyncJob(sync.id, SyncType.WEBHOOK, SyncStatus.RUNNING, task.name, task.connection, task.id);

    const syncRun = new SyncRunService({
        bigQueryClient,
        integrationService,
        recordsService,
        slackService,
        writeToDb: true,
        sendSyncWebhook: sendSync,
        nangoConnection: task.connection,
        syncConfig,
        syncJobId: syncJobId?.id as number,
        isAction: false,
        syncType: SyncType.WEBHOOK,
        syncId: sync?.id,
        isWebhook: true,
        activityLogId: task.activityLogId,
        logCtx: await logContextGetter.get({ id: String(task.activityLogId) }),
        input: task.input as object, // TODO: fix type after temporal is removed
        provider: providerConfig.provider,
        debug: false,
        runnerFlags: await getRunnerFlags()
    });
    const { error, response } = await syncRun.run();
    if (error) {
        return Err(error);
    }
    const res = jsonSchema.safeParse(response);
    if (!res.success) {
        return Err(`Invalid webhook response format: ${JSON.stringify(response)}. TaskId: ${task.id}`);
    }
    return Ok(res.data);
}

async function postConnection(task: TaskPostConnection): Promise<Result<JsonValue>> {
    const providerConfig = await configService.getProviderConfig(task.connection.provider_config_key, task.connection.environment_id);
    if (providerConfig === null) {
        return Err(`Provider config not found for connection: ${task.connection.connection_id}`);
    }

    const syncRun = new SyncRunService({
        bigQueryClient,
        integrationService,
        recordsService,
        slackService,
        writeToDb: true,
        nangoConnection: task.connection,
        syncConfig: {
            sync_name: task.postConnectionName,
            file_location: task.fileLocation,
            models: [],
            track_deletes: false,
            type: 'sync',
            version: task.version,
            active: true,
            auto_start: false,
            enabled: true,
            environment_id: task.connection.environment_id,
            model_schema: [],
            nango_config_id: -1,
            runs: '',
            webhook_subscriptions: [],
            created_at: new Date(),
            updated_at: new Date()
        },
        sendSyncWebhook: sendSync,
        isAction: false,
        isPostConnectionScript: true,
        syncType: SyncType.POST_CONNECTION_SCRIPT,
        isWebhook: false,
        activityLogId: task.activityLogId,
        logCtx: await logContextGetter.get({ id: String(task.activityLogId) }),
        provider: providerConfig.provider,
        debug: false,
        runnerFlags: await getRunnerFlags()
    });

    const { error, response } = await syncRun.run();
    if (error) {
        return Err(error);
    }
    const res = jsonSchema.safeParse(response);
    if (!res.success) {
        return Err(`Invalid post connection script response format: ${response}. TaskId: ${task.id}`);
    }
    return Ok(res.data);
}
