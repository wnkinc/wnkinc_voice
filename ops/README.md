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
