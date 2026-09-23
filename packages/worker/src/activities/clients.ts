/** The clients the activities share, made once per container: DynamoDB, the store over it, Composio, the callers' memory. */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { composioApi } from '@wnk/shared/composio-api';
import { callerMemory } from '@wnk/shared/memory';
import { secretValue } from '@wnk/shared/secrets';
import { dynamoStore } from '@wnk/shared/store';
import { env } from './config.js';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
export const store = dynamoStore(ddb);
export const composio = composioApi(() => secretValue(env('COMPOSIO_SECRET_ARN'), 'COMPOSIO_API_KEY'));
export const memory = callerMemory(process.env.MEMORY_ID);
