import type { NangoModel, NangoYaml, NangoYamlParsed } from '@nangohq/types';
import { ModelsParser } from './modelsParser.js';
import {
    ParserErrorDuplicateEndpoint,
    ParserErrorDuplicateModel,
    ParserErrorMissingId,
    ParserErrorModelIsLiteral,
    ParserErrorModelNotFound
} from './errors.js';
import type { ParserError } from './errors.js';

export abstract class NangoYamlParser {
    raw: NangoYaml;
    parsed: NangoYamlParsed | undefined;
    modelsParser: ModelsParser;

    errors: ParserError[] = [];
    warnings: ParserError[] = [];

    constructor({ raw }: { raw: NangoYaml }) {
        this.raw = raw;
        this.modelsParser = new ModelsParser({ raw: raw.models });
    }

    abstract parse(): boolean;

    getModelForOutput({
        rawOutput,
        name,
        type,
        integrationName
    }: {
        rawOutput: string | string[] | undefined;
        name: string;
        type: 'sync' | 'action';
        integrationName: string;
    }): NangoModel[] | null {
        if (!rawOutput) {
            return null;
        }

        const models: NangoModel[] = [];

        const output = Array.isArray(rawOutput) ? rawOutput : [rawOutput];
        for (const modelOrType of output) {
            const model = this.modelsParser.get(modelOrType);
            if (model) {
                models.push(model);
                continue;
            }

            // Create anonymous model for validation
            const parsed = this.modelsParser.parseFields({ fields: { output: modelOrType }, parent: name });

            const anon = `Anonymous_${integrationName.replace(/[^A-Za-z0-9_]/g, '')}_${type}_${name.replace(/[^A-Za-z0-9_]/g, '')}_output`;
            const anonModel: NangoModel = { name: anon, fields: parsed, isAnon: true };
            this.modelsParser.parsed.set(anon, anonModel);
            models.push(anonModel);
        }

        return models;
    }

    postParsingValidation() {
        if (!this.parsed) {
            return;
        }

        // check that every endpoint is unique across syncs and actions
        const endpoints = new Set<string>();
        for (const integration of this.parsed.integrations) {
            // check that models are used only once per integration
            const usedModels = new Set<string>();
            const integrationName = integration.providerConfigKey;

            // --- Validate syncs
            for (const sync of integration.syncs) {
                if (sync.output) {
                    for (const output of sync.output) {
                        if (usedModels.has(output)) {
                            this.errors.push(new ParserErrorDuplicateModel({ model: output, path: [integrationName, 'syncs', sync.name, '[output]'] }));
                            continue;
                        }
                        usedModels.add(output);

                        const model = this.modelsParser.get(output)!;
                        if (!model.fields.find((field) => field.name === 'id')) {
                            this.errors.push(new ParserErrorMissingId({ model: output, path: [integrationName, 'syncs', sync.name, '[output]'] }));
                            continue;
                        }
                        if (output.startsWith('Anonymous')) {
                            this.warnings.push(
                                new ParserErrorModelIsLiteral({ model: model.fields[0]!.value as any, path: [integrationName, 'syncs', sync.name, '[output]'] })
                            );
                            continue;
                        }
                    }
                }
                if (sync.input) {
                    if (usedModels.has(sync.input)) {
                        this.warnings.push(new ParserErrorDuplicateModel({ model: sync.input, path: [integrationName, 'syncs', sync.name, '[input]'] }));
                    }
                    if (sync.input.startsWith('Anonymous')) {
                        const model = this.modelsParser.get(sync.input)!;
                        this.warnings.push(
                            new ParserErrorModelIsLiteral({ model: model.fields[0]!.value as any, path: [integrationName, 'syncs', sync.name, '[input]'] })
                        );
                    }
                    usedModels.add(sync.input);
                }
                for (const endpointByVerb of sync.endpoints) {
                    for (const [verb, endpoint] of Object.entries(endpointByVerb)) {
                        const str = `${verb} ${endpoint}`;
                        if (endpoints.has(str)) {
                            this.errors.push(new ParserErrorDuplicateEndpoint({ endpoint: str, path: [integrationName, 'syncs', sync.name, '[endpoints]'] }));
                            continue;
                        }

                        endpoints.add(str);
                        const modelInUrl = endpoint.match(/{([^}]+)}/);
                        if (modelInUrl) {
                            const modelName = modelInUrl[1]!;
                            if (!this.modelsParser.get(modelName)) {
                                this.errors.push(
                                    new ParserErrorModelNotFound({ model: modelName, path: [integrationName, 'syncs', sync.name, '[endpoints]'] })
                                );
                            }
                        }
                    }
                }

                sync.usedModels = Array.from(usedModels);
            }

            // --- Validate actions
            for (const action of integration.actions) {
                const usedModels = new Set<string>();
                if (action.output) {
                    for (const output of action.output) {
                        if (usedModels.has(output)) {
                            this.errors.push(new ParserErrorDuplicateModel({ model: output, path: [integrationName, 'actions', action.name, '[output]'] }));
                            continue;
                        }
                        usedModels.add(output);

                        const model = this.modelsParser.get(output)!;
                        if (output.startsWith('Anonymous')) {
                            this.warnings.push(
                                new ParserErrorModelIsLiteral({
                                    model: model.fields[0]!.value as any,
                                    path: [integrationName, 'actions', action.name, '[output]']
                                })
                            );
                        }
                    }
                }
                if (action.input) {
                    if (usedModels.has(action.input)) {
                        this.warnings.push(new ParserErrorDuplicateModel({ model: action.input, path: [integrationName, 'actions', action.name, '[input]'] }));
                    }
                    if (action.input.startsWith('Anonymous')) {
                        const model = this.modelsParser.get(action.input)!;
                        this.warnings.push(
                            new ParserErrorModelIsLiteral({ model: model.fields[0]!.value as any, path: [integrationName, 'actions', action.name, '[input]'] })
                        );
                    }
                    usedModels.add(action.input);
                }
                if (action.endpoint) {
                    for (const [verb, endpoint] of Object.entries(action.endpoint)) {
                        const str = `${verb} ${endpoint}`;
                        if (endpoints.has(str)) {
                            this.errors.push(
                                new ParserErrorDuplicateEndpoint({ endpoint: str, path: [integrationName, 'actions', action.name, '[endpoint]'] })
                            );
                            continue;
                        }
                        endpoints.add(str);
                        const modelInUrl = endpoint.match(/{([^}]+)}/);
                        if (modelInUrl) {
                            const modelName = modelInUrl[1]!.split(':')[0]!;
                            if (!this.modelsParser.get(modelName)) {
                                this.errors.push(
                                    new ParserErrorModelNotFound({ model: modelName, path: [integrationName, 'syncs', action.name, '[endpoint]'] })
                                );
                            }
                        }
                    }
                }
                action.usedModels = Array.from(usedModels);
            }
        }
    }
}