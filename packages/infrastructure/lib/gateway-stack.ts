import * as cdk from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface GatewayStackProps extends cdk.StackProps {
  readonly prefix: string;
  readonly userPool: cognito.IUserPool;
  readonly machineClient: cognito.IUserPoolClient;
  readonly hubspotProvider: agentcore.IApiKeyCredentialProvider;
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
    const { prefix, userPool, machineClient, hubspotProvider } = props;

    this.gateway = new agentcore.Gateway(this, 'Gateway', {
      gatewayName: `${prefix}-gateway`,
      description: 'WNK agent platform tool catalog',
      authorizerConfiguration: agentcore.GatewayAuthorizer.usingCognito({
        userPool,
        allowedClients: [machineClient],
      }),
    });

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
