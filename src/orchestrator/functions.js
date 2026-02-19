'use strict';

const axios  = require('axios');
const logger = require('../utils/logger');

const laravelClient = axios.create({
    baseURL: process.env.LARAVEL_API_URL,
    headers: { 'X-Internal-Secret': process.env.LARAVEL_API_SECRET },
    timeout: 10000,
});

function buildTools(assistantConfig) {
    const tools = [];

    if (assistantConfig.is_end_call_enabled) {
        tools.push({
            type: 'function', name: 'end_call',
            description: 'End the phone call. Call this when the conversation is complete or the user wants to hang up.',
            parameters: {
                type: 'object',
                properties: {
                    reason: {
                        type: 'string',
                        enum: ['completed', 'user_requested', 'no_response'],
                        description: 'Reason the call is ending',
                    },
                },
                required: ['reason'],
            },
        });
    }

    if (assistantConfig.is_transfer_to_number && assistantConfig.transfer_to_number?.length) {
        tools.push({
            type: 'function', name: 'transfer_to_number',
            description: 'Transfer the call to a phone number based on a condition.',
            parameters: {
                type: 'object',
                properties: {
                    phone_number: {
                        type: 'string',
                        description: 'The phone number to transfer to',
                        enum: assistantConfig.transfer_to_number.map(t => t.phone_number),
                    },
                    condition: { type: 'string', description: 'The reason / condition for the transfer' },
                },
                required: ['phone_number', 'condition'],
            },
        });
    }

    if (assistantConfig.is_transfer_to_agent && assistantConfig.transfer_to_agent?.length) {
        tools.push({
            type: 'function', name: 'transfer_to_agent',
            description: 'Transfer the call to another AI agent based on a condition.',
            parameters: {
                type: 'object',
                properties: {
                    agent_id: {
                        type: 'string',
                        description: 'The agent ID to transfer to',
                        enum: assistantConfig.transfer_to_agent.map(t => t.agent_id),
                    },
                    condition: { type: 'string', description: 'The reason / condition for the transfer' },
                },
                required: ['agent_id', 'condition'],
            },
        });
    }

    if (assistantConfig.language_detection) {
        tools.push({
            type: 'function', name: 'switch_language',
            description: 'Switch the conversation language when the caller speaks in a different language.',
            parameters: {
                type: 'object',
                properties: {
                    language: { type: 'string', description: 'Language code to switch to (e.g. en, es, fr)' },
                },
                required: ['language'],
            },
        });
    }

    if (assistantConfig.is_custom_tools && assistantConfig.custom_tools?.length) {
        for (const tool of assistantConfig.custom_tools) {
            tools.push(buildCustomToolDefinition(tool));
        }
    }

    return tools;
}

function buildCustomToolDefinition(tool) {
    const properties = {};
    const required   = [];

    if (tool.is_path_params && tool.path_params?.length) {
        for (const param of tool.path_params) {
            properties[param.name] = { type: param.type, description: param.description || param.name };
            required.push(param.name);
        }
    }

    if (tool.is_query_params && tool.query_params?.length) {
        for (const param of tool.query_params) {
            properties[param.name] = { type: param.type, description: param.description || param.name };
            if (param.required) required.push(param.name);
        }
    }

    return {
        type: 'function', name: tool.name,
        description: tool.description || tool.name,
        parameters: { type: 'object', properties, required },
    };
}

async function execute(name, args, callSession) {
    const { callSid, assistantConfig } = callSession;
    logger.info(`Executing function: ${name}`, { callSid, args });

    switch (name) {
        case 'end_call':
            callSession.emit('end_call_requested', args.reason || 'completed');
            return { acknowledged: true };

        case 'transfer_to_number':
            return await executeTransferToNumber(args, callSession);

        case 'transfer_to_agent':
            return await executeTransferToAgent(args, callSession);

        case 'switch_language': {
            const newLanguage = args.language;
            const languageVoices = callSession.assistantConfig.language_voices || {};
            const newVoice = languageVoices[newLanguage] || null;
            callSession.language = newLanguage;
            callSession.voice    = newVoice;
            callSession.emit('language_switched', { language: newLanguage, voice: newVoice });
            logger.info(`Language switched to ${newLanguage}, voice: ${newVoice || 'gpu-default'}`, { callSid: callSession.callSid });
            return { success: true, language: newLanguage, voice: newVoice };
        }
    }

    const customTool = assistantConfig.custom_tools?.find(t => t.name === name);
    if (customTool) return await executeCustomTool(customTool, args, callSession);

    logger.warn(`Unknown function called: ${name}`, { callSid });
    return { error: `Unknown function: ${name}` };
}

async function executeTransferToNumber(args, callSession) {
    const { callSid, assistantConfig } = callSession;
    const transferConfig = assistantConfig.transfer_to_number?.find(t => t.phone_number === args.phone_number);

    if (!transferConfig) {
        logger.warn('Transfer number not found in config', { callSid, phone: args.phone_number });
        return { success: false, error: 'Phone number not configured for transfer' };
    }

    logger.info(`Transferring call to number: ${args.phone_number}`, { callSid });

    callSession.emit('transfer_to_number', {
        phone_number:          args.phone_number,
        transfer_type:         transferConfig.transfer_type || 'conference',
        enable_client_message: transferConfig.enable_client_message,
        // FIX: transfer_message was missing from the emitted event.
        // pipeline.js does `if (transferData.enable_client_message && transferData.transfer_message)`
        // but this object never had transfer_message, so the pre-transfer speech
        // was silently skipped even when configured. Now included.
        transfer_message:      transferConfig.transfer_message,
        condition:             args.condition,
    });

    return { success: true, phone_number: args.phone_number };
}

async function executeTransferToAgent(args, callSession) {
    const { callSid, assistantConfig } = callSession;
    const transferConfig = assistantConfig.transfer_to_agent?.find(t => t.agent_id === args.agent_id);

    if (!transferConfig) {
        logger.warn('Transfer agent not found in config', { callSid, agentId: args.agent_id });
        return { success: false, error: 'Agent not configured for transfer' };
    }

    logger.info(`Transferring call to agent: ${args.agent_id}`, { callSid });

    callSession.emit('transfer_to_agent', {
        agent_id:                               args.agent_id,
        delay_ms:                               transferConfig.delay_ms || 0,
        transfer_message:                       transferConfig.transfer_message,
        enable_client_message:                  transferConfig.enable_client_message,
        enable_transferred_agent_first_message: transferConfig.enable_transferred_agent_first_message,
        condition:                              args.condition,
    });

    return { success: true, agent_id: args.agent_id };
}

async function executeCustomTool(tool, args, callSession) {
    const { callSid } = callSession;

    try {
        let url = tool.url;
        if (tool.is_path_params && tool.path_params?.length) {
            for (const param of tool.path_params) {
                if (args[param.name] !== undefined) {
                    url = url.replace(`{${param.name}}`, encodeURIComponent(args[param.name]));
                }
            }
        }

        const queryParams = {};
        if (tool.is_query_params && tool.query_params?.length) {
            for (const param of tool.query_params) {
                const value = param.constant_value !== undefined ? param.constant_value : args[param.name];
                if (value !== undefined) queryParams[param.name] = value;
            }
        }

        const headers = {};
        if (tool.is_request_headers && tool.request_headers?.length) {
            for (const header of tool.request_headers) {
                headers[header.key] = header.value;
            }
        }

        const response = await axios({
            method:  tool.method.toLowerCase(),
            url,
            params:  queryParams,
            headers,
            timeout: (tool.response_timeout_secs || 20) * 1000,
        });

        logger.info(`Custom tool ${tool.name} responded: ${response.status}`, { callSid });

        const extractedValues = {};
        if (tool.is_assignments && tool.assignments?.length) {
            for (const assignment of tool.assignments) {
                const value = getNestedValue(response.data, assignment.value_path);
                if (value !== undefined) {
                    extractedValues[assignment.dynamic_variable] = value;
                    if (!callSession.dynamicVariables) callSession.dynamicVariables = {};
                    callSession.dynamicVariables[assignment.dynamic_variable] = value;
                }
            }
        }

        return {
            success: true,
            status:  response.status,
            data:    response.data,
            ...(Object.keys(extractedValues).length && { extracted: extractedValues }),
        };

    } catch (err) {
        const status = err.response?.status;
        logger.error(`Custom tool ${tool.name} failed`, { callSid, error: err.message, status });
        return { success: false, error: err.message, status: status || null };
    }
}

function getNestedValue(obj, path) {
    if (!path || !obj) return undefined;
    return path.split('.').reduce((cur, key) => {
        if (cur === undefined || cur === null) return undefined;
        return cur[key];
    }, obj);
}

module.exports = { buildTools, execute };