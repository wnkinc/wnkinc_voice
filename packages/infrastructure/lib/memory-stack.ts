import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { ManagedMemoryStrategy, MemoryStrategyType } from 'aws-cdk-lib/aws-bedrockagentcore';

import { Construct } from 'constructs';

export interface MemoryStackProps extends cdk.StackProps {
  readonly prefix: string;
}

/**
 * AgentCore Memory: the platform's own caller memory, replacing the
 * HubSpot-note hack. Agents write call transcripts as events (actorId =
 * `<tenantId>_<phone digits>`, sessionId = callId); managed strategies extract
 * long-term records asynchronously into per-caller namespaces, which the
 * webhook and the email agent retrieve. tenantId prefixes the actor id, so
 * tenant isolation is structural.
 */
export class MemoryStack extends cdk.Stack {
  readonly memory: agentcore.Memory;

  constructor(scope: Construct, id: string, props: MemoryStackProps) {
    super(scope, id, props);
    const { prefix } = props;

    this.memory = new agentcore.Memory(this, 'CallerMemory', {
      memoryName: `${prefix.replace(/-/g, '_')}_caller_memory`,
      description: 'Per-caller memory across calls: facts and preferences extracted from transcripts',
      expirationDuration: cdk.Duration.days(90), // raw event retention; extracted records persist
      memoryStrategies: [
        new ManagedMemoryStrategy(MemoryStrategyType.SEMANTIC, {
          strategyName: 'caller_facts',
          description: 'Facts about the caller and their jobs',
          namespaces: ['/callers/{actorId}/facts'],
        }),
        new ManagedMemoryStrategy(MemoryStrategyType.USER_PREFERENCE, {
          strategyName: 'caller_preferences',
          description: 'Caller preferences (callback times, contact method, tone)',
          namespaces: ['/callers/{actorId}/preferences'],
        }),
      ],
    });

    new cdk.CfnOutput(this, 'memoryId', { value: this.memory.memoryId });
    new cdk.CfnOutput(this, 'memoryArn', { value: this.memory.memoryArn });
  }
}

/** Data-plane actions an agent needs to write events and recall records. */
export const MEMORY_USE_ACTIONS = [
  'bedrock-agentcore:CreateEvent',
  'bedrock-agentcore:GetEvent',
  'bedrock-agentcore:ListEvents',
  'bedrock-agentcore:RetrieveMemoryRecords',
  'bedrock-agentcore:ListMemoryRecords',
  'bedrock-agentcore:GetMemoryRecord',
];
