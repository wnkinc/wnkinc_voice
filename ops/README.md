# ops

Operator data that lives outside the stacks: what a person applies by hand, from the admin profile.

## `wnk-operate-policy.json`

The IAM policy attached to the `wnk-ops` user, the identity this repo's coding agent runs as
(`.claude/settings.json` pins `AWS_PROFILE=wnk-ops`). It allows the operate jobs: tenant rows,
platform secrets, workflows on Temporal Cloud (with the worker's key from its secret), the worker release, logs, metrics, `cdk diff`. It
allows no CloudFormation change and no IAM.

When a script hits an AccessDenied, the error names the action. Add it here, commit with the
reason, and apply from the admin profile:

```bash
AWS_PROFILE=wnk-admin aws iam create-policy-version \
  --policy-arn arn:aws:iam::539247450358:policy/WnkOperate \
  --policy-document file://ops/wnk-operate-policy.json --set-as-default
```

IAM keeps five versions per policy; delete an old one when it refuses:
`aws iam list-policy-versions` then `aws iam delete-policy-version --version-id vN`.

The agent may propose a change to this file. A person applies it.

## Temporal Cloud

Two APIs, two doors. Workflows, schedules, and worker builds go to the namespace's own
frontend (`temporal workflow ...`, `temporal worker ...`, `temporal schedule ...`). The
namespace's configuration goes to the Cloud control plane (`temporal cloud namespace ...`).
The worker's API key is a namespace service account: it may do everything on the first door
and read on the second, and it may not change the namespace. A frontend command for a
control-plane job answers "Request unauthorized": the wrong door, not the wrong key.

**Custom search attributes.** The worker sets the ones listed in
`packages/worker/src/search-attributes.ts`; a start that names one the namespace lacks is
refused. A person creates each once per namespace, with their own login or in the Cloud UI
(the namespace, then Search Attributes):

```bash
temporal cloud login
temporal cloud namespace search-attribute create --name TenantId --type Keyword --namespace <namespace>
```

`scripts/temporal-namespace.mts` checks the list (CI, before every deploy; the release too)
and stops with that command when one is missing, so no build that sets an attribute goes
live ahead of it. Cloud does not delete a custom search attribute, so a name in that file is
for good.

List a tenant's workflows: `npm run temporal -- workflow list --query 'TenantId="<id>"'`.
