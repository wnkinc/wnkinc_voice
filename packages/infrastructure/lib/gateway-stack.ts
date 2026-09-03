import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface GatewayStackProps extends cdk.StackProps {
  readonly prefix: string;
  readonly userPool: cognito.IUserPool;
  /** Scopes a JWT must carry. Validation is by scope, not client id, so a new tenant's client needs no deploy. */
  readonly allowedScopes: string[];
  /** The voice stack's interceptor: tenant context from the caller's identity, before every dispatch. */
  readonly interceptorFn: lambda.IFunction;
  readonly hubspotProvider: agentcore.IApiKeyCredentialProvider;
  /** The voice stack's tools Lambda (record_lead / notify_owner). */
  readonly voiceToolsFn: lambda.IFunction;
  /** Policy engine to enforce on every tool call (default deny once attached). */
  readonly policyEngineArn?: string;
}

/**
 * The one MCP tool catalog every agent talks to. Inbound: Cognito JWTs.
 * Outbound: per-target credential providers from the Identity stack — an
 * agent calling `hubspot___searchContacts` never sees the HubSpot token.
 */
export class GatewayStack extends cdk.Stack {
  readonly gateway: agentcore.Gateway;

  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);
    const { prefix, userPool, hubspotProvider } = props;

    this.gateway = new agentcore.Gateway(this, 'Gateway', {
      gatewayName: `${prefix}-gateway`,
      description: 'WNK agent platform tool catalog',
      authorizerConfiguration: agentcore.GatewayAuthorizer.usingCognito({
        userPool,
        allowedScopes: props.allowedScopes,
      }),
      // Tenant context comes from WHO is calling, not from what the model
      // sends: the interceptor maps the validated client_id to a tenant and
      // writes tenant_id/tenant_phone into every tools/call. Headers are passed
      // so it can read the token the Gateway already verified.
      interceptorConfigurations: [agentcore.LambdaInterceptor.forRequest(props.interceptorFn, { passRequestHeaders: true })],
    });

    // Attach the Policy engine (no L2 support yet — escape hatch to the L1).
    // The gateway's role evaluates policies against the engine at call time.
    if (props.policyEngineArn) {
      const cfnGateway = this.gateway.node.defaultChild as agentcore.CfnGateway;
      cfnGateway.policyEngineConfiguration = { arn: props.policyEngineArn, mode: 'ENFORCE' };
      const grant = this.gateway.role.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:GetPolicyEngine',
          'bedrock-agentcore:*Authorize*', // AuthorizeAction, PartiallyAuthorizeActions, ... (per-call evaluation)
        ],
        // gateway/* by pattern: the policy can't reference the gateway's own ARN
        // attribute (the gateway depends on this policy — it would be a cycle).
        resources: [
          props.policyEngineArn,
          `${props.policyEngineArn}/*`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
        ],
      }));
      // The service validates GetPolicyEngine during the gateway update itself,
      // so the role policy must land first.
      if (grant.policyDependable) cfnGateway.node.addDependency(grant.policyDependable);
    }

    // HubSpot CRM as MCP tools; auth is the API-key provider as a Bearer header.
    // NOTE: the CDK default prefix is 'Bearer ' (trailing space) but the service
    // already joins prefix and key with a space, yielding 'Bearer  <key>' and a
    // 401 — so the prefix must be given explicitly without the trailing space.
    const bearerHeader = agentcore.ApiKeyCredentialLocation.header({
      credentialParameterName: 'Authorization',
      credentialPrefix: 'Bearer',
    });
    this.gateway.addOpenApiTarget('Hubspot', {
      gatewayTargetName: 'hubspot',
      description: 'HubSpot CRM: contacts and notes',
      apiSchema: agentcore.ApiSchema.fromLocalAsset(path.resolve(here, '../assets/hubspot-openapi.json')),
      credentialProviderConfigurations: [
        agentcore.GatewayCredentialProvider.fromApiKeyIdentity(hubspotProvider, { credentialLocation: bearerHeader }),
      ],
    });

    // Voice tools as a Lambda target: record_lead + notify_owner become shared
    // platform tools. The tenant_* / call_* fields are context injected by the
    // calling agent, never by the model.
    const ctxProps = {
      tenant_id: { type: agentcore.SchemaDefinitionType.STRING, description: 'Business/tenant id (injected by the caller)' },
      tenant_phone: { type: agentcore.SchemaDefinitionType.STRING, description: 'Tenant E.164 phone (injected by the caller)' },
      call_id: { type: agentcore.SchemaDefinitionType.STRING, description: 'Originating call id (injected by the caller)' },
      caller_phone: { type: agentcore.SchemaDefinitionType.STRING, description: 'Caller id E.164, if known' },
    };
    this.gateway.addLambdaTarget('VoiceTools', {
      gatewayTargetName: 'voice',
      description: 'Voice receptionist platform tools: record a lead, notify the owner',
      lambdaFunction: props.voiceToolsFn,
      toolSchema: agentcore.ToolSchema.fromInline([
        {
          name: 'record_lead',
          description: 'Save a caller as a lead for the business owner to follow up with.',
          inputSchema: {
            type: agentcore.SchemaDefinitionType.OBJECT,
            properties: {
              caller_name: { type: agentcore.SchemaDefinitionType.STRING, description: "The caller's name as they gave it" },
              phone: { type: agentcore.SchemaDefinitionType.STRING, description: 'Callback number in digits; omit if declined' },
              reason: { type: agentcore.SchemaDefinitionType.STRING, description: 'Why they called / what they need' },
              preferred_callback_time: { type: agentcore.SchemaDefinitionType.STRING, description: 'When they want to be contacted' },
              notes: { type: agentcore.SchemaDefinitionType.STRING, description: 'Anything else useful for the owner' },
              ...ctxProps,
            },
            required: ['caller_name', 'reason', 'tenant_id', 'tenant_phone', 'call_id'],
          },
        },
        {
          name: 'notify_owner',
          description: 'Send the business owner an immediate notification about a call.',
          inputSchema: {
            type: agentcore.SchemaDefinitionType.OBJECT,
            properties: {
              summary: { type: agentcore.SchemaDefinitionType.STRING, description: 'Two or three sentences the owner should read' },
              urgency: { type: agentcore.SchemaDefinitionType.STRING, description: "'normal' or 'urgent'" },
              ...ctxProps,
            },
            required: ['summary', 'tenant_id', 'tenant_phone', 'call_id'],
          },
        },
      ]),
    });
    // CRM tools on the same Lambda: HubSpot through Composio, the tenant id
    // (from the interceptor) selecting the credential. Tenant fields are
    // declared so validation accepts them but never required of the caller.
    const tenantProps = {
      tenant_id: { type: agentcore.SchemaDefinitionType.STRING, description: 'Set by the Gateway from the caller identity' },
      tenant_phone: { type: agentcore.SchemaDefinitionType.STRING, description: 'Set by the Gateway from the caller identity' },
    };
    const str = (description: string) => ({ type: agentcore.SchemaDefinitionType.STRING, description });
    this.gateway.addLambdaTarget('CrmTools', {
      gatewayTargetName: 'crm',
      description: "The business's CRM: contacts and notes",
      lambdaFunction: props.voiceToolsFn,
      toolSchema: agentcore.ToolSchema.fromInline([
        {
          name: 'search_contacts',
          description: 'Find CRM contacts by name, email, or phone number. Returns id, name, phone, email for each match.',
          inputSchema: {
            type: agentcore.SchemaDefinitionType.OBJECT,
            properties: { query: str('Name, email, or phone number to search for'), limit: { type: agentcore.SchemaDefinitionType.INTEGER, description: 'Max results (default 5, max 20)' }, ...tenantProps },
            required: ['query'],
          },
        },
        {
          name: 'get_contact',
          description: 'Read one CRM contact by id, with the most recent note about them.',
          inputSchema: { type: agentcore.SchemaDefinitionType.OBJECT, properties: { contact_id: str('The contact id from search_contacts'), ...tenantProps }, required: ['contact_id'] },
        },
        {
          name: 'create_contact',
          description: 'Create a CRM contact (or fill in missing names on the existing contact with that phone number).',
          inputSchema: {
            type: agentcore.SchemaDefinitionType.OBJECT,
            properties: { phone: str('Phone number'), first_name: str('First name'), last_name: str('Last name'), ...tenantProps },
            required: ['phone'],
          },
        },
        {
          name: 'add_note',
          description: 'Add a timestamped note to a CRM contact.',
          inputSchema: { type: agentcore.SchemaDefinitionType.OBJECT, properties: { contact_id: str('The contact id'), body: str('Plain-text note'), ...tenantProps }, required: ['contact_id', 'body'] },
        },
      ]),
    });
    props.voiceToolsFn.grantInvoke(this.gateway.role);

    // Vended application logs -> CloudWatch, so tool-call failures are debuggable.
    const logGroup = new logs.LogGroup(this, 'GatewayLogs', {
      logGroupName: `/wnk/agentcore/gateway`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const deliverySource = new logs.CfnDeliverySource(this, 'GatewayLogSource', {
      name: `${prefix}-gateway-logs`,
      logType: 'APPLICATION_LOGS',
      resourceArn: this.gateway.gatewayArn,
    });
    const deliveryDestination = new logs.CfnDeliveryDestination(this, 'GatewayLogDest', {
      name: `${prefix}-gateway-logdest`,
      destinationResourceArn: logGroup.logGroupArn,
    });
    const delivery = new logs.CfnDelivery(this, 'GatewayLogDelivery', {
      deliverySourceName: deliverySource.name,
      deliveryDestinationArn: deliveryDestination.attrArn,
    });
    delivery.addDependency(deliverySource);

    new cdk.CfnOutput(this, 'gatewayUrl', { value: this.gateway.gatewayUrl ?? '' });
    new cdk.CfnOutput(this, 'gatewayId', { value: this.gateway.gatewayId });
  }
}
