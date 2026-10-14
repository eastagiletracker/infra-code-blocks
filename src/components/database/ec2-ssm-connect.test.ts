import { before, beforeEach, describe, it } from 'node:test';
import * as assert from 'node:assert';
import type * as awsx from '@pulumi/awsx';
import * as pulumi from '@pulumi/pulumi';

const SECURITY_GROUP_TYPE = 'aws:ec2/securityGroup:SecurityGroup';
const VPC_ENDPOINT_TYPE = 'aws:ec2/vpcEndpoint:VpcEndpoint';
const INSTANCE_TYPE = 'aws:ec2/instance:Instance';
const VPC_CIDR = '10.0.0.0/16';

type Ec2SSMConnectClass = typeof import('./ec2-ssm-connect').Ec2SSMConnect;
let Ec2SSMConnect: Ec2SSMConnectClass;

type ResourceInputs = Record<string, any>;
type CapturedResource = { name: string; inputs: ResourceInputs };

const capturedResources = new Map<string, CapturedResource[]>();

describe('Ec2SSMConnect', () => {
  before(async () => {
    await pulumi.runtime.setMocks(
      {
        call: args => args.inputs,
        newResource: args => {
          const resources = capturedResources.get(args.type) ?? [];
          resources.push({ name: args.name, inputs: args.inputs });
          capturedResources.set(args.type, resources);

          const id = `${args.name}-id`;

          return {
            id: args.custom ? id : undefined,
            state: { ...args.inputs, id, name: args.inputs.name ?? args.name },
          };
        },
      },
      'icb-test-ec2-ssm-connect',
      'dev',
      false,
    );

    ({ Ec2SSMConnect } = await import('./ec2-ssm-connect'));
  });

  describe('security groups', () => {
    let ec2SecurityGroup: CapturedResource;

    beforeEach(async () => {
      capturedResources.clear();

      await pulumi.runtime.runInPulumiStack(async () => {
        const ssmConnect = createEc2SSMConnect('ssm');

        await resolveInput(
          pulumi.all([
            ssmConnect.ec2.id,
            ssmConnect.ssmVpcEndpoint.id,
            ssmConnect.ec2MessagesVpcEndpoint.id,
            ssmConnect.ssmMessagesVpcEndpoint.id,
          ]),
        );
      });

      ec2SecurityGroup = getCapturedResource(
        SECURITY_GROUP_TYPE,
        'ssm-ec2-security-group',
      );
    });

    it('should create separate security groups for the instance and the VPC endpoints', () => {
      const vpcEndpointSecurityGroup = getVpcEndpointSecurityGroup();

      assert.strictEqual(getCapturedResources(SECURITY_GROUP_TYPE).length, 2);
      assert.strictEqual(ec2SecurityGroup.inputs.vpcId, 'vpc-123456');
      assert.strictEqual(vpcEndpointSecurityGroup.inputs.vpcId, 'vpc-123456');
    });

    it('should not allow any inbound traffic to the instance', () => {
      assert.deepStrictEqual(ec2SecurityGroup.inputs.ingress ?? [], []);
    });

    it('should limit instance outbound traffic to HTTPS and the VPC', () => {
      assert.deepStrictEqual(stripDefaults(ec2SecurityGroup.inputs.egress), [
        {
          protocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          cidrBlocks: ['0.0.0.0/0'],
        },
        {
          protocol: 'tcp',
          fromPort: 0,
          toPort: 65535,
          cidrBlocks: [VPC_CIDR],
        },
      ]);
    });

    it('should only allow HTTPS from the VPC to the endpoints', () => {
      const vpcEndpointSecurityGroup = getVpcEndpointSecurityGroup();

      assert.deepStrictEqual(
        stripDefaults(vpcEndpointSecurityGroup.inputs.ingress),
        [
          {
            protocol: 'tcp',
            fromPort: 443,
            toPort: 443,
            cidrBlocks: [VPC_CIDR],
          },
        ],
      );
    });

    it('should attach the instance security group to the instance', () => {
      const instance = getCapturedResource(INSTANCE_TYPE, 'ssm-ec2');

      assert.deepStrictEqual(instance.inputs.vpcSecurityGroupIds, [
        'ssm-ec2-security-group-id',
      ]);
    });

    it('should attach the endpoint security group to every VPC endpoint', () => {
      const endpoints = getCapturedResources(VPC_ENDPOINT_TYPE);

      assert.strictEqual(endpoints.length, 3);
      for (const endpoint of endpoints) {
        assert.deepStrictEqual(
          endpoint.inputs.securityGroupIds,
          ['ssm-vpc-endpoint-security-group-id'],
          `${endpoint.name} should use the endpoint security group`,
        );
      }
    });
  });
});

function createEc2SSMConnect(name: string) {
  const vpc = {
    vpcId: pulumi.output('vpc-123456'),
    privateSubnetIds: pulumi.output(['subnet-private-1']),
    vpc: pulumi.output({ cidrBlock: VPC_CIDR }),
  } as unknown as awsx.ec2.Vpc;

  return new Ec2SSMConnect(name, {
    vpc,
    ami: 'ami-123456',
    region: 'us-west-2',
  });
}

function resolveInput<T>(input: pulumi.Input<T>): Promise<T> {
  return new Promise(resolve => pulumi.output(input).apply(resolve));
}

function getVpcEndpointSecurityGroup(): CapturedResource {
  return getCapturedResource(
    SECURITY_GROUP_TYPE,
    'ssm-vpc-endpoint-security-group',
  );
}

function getCapturedResources(type: string): CapturedResource[] {
  return capturedResources.get(type) ?? [];
}

function getCapturedResource(type: string, name: string): CapturedResource {
  const resource = getCapturedResources(type).find(r => r.name === name);
  assert.ok(resource, `Expected ${type} named ${name} to be registered`);

  return resource;
}

function stripDefaults(rules: ResourceInputs[] = []) {
  return rules.map(({ protocol, fromPort, toPort, cidrBlocks }) => ({
    protocol,
    fromPort,
    toPort,
    cidrBlocks,
  }));
}
