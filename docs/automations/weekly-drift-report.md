# Weekly drift report — this repository's part

A weekly Devin Automation scans this repository together with `timesheet-app` and
`petclinic-microservices` and publishes one report plus a ranked, sized remediation queue
as a GitHub issue in `Cognition-Partner-Workshops/timesheet-app` (label `drift-report`).

The full design — trigger, ranking formula, sizing rubric, queue contract for the Track 2
fan-out, guardrails and human checkpoint — lives in
`timesheet-app/docs/automations/weekly-drift-report.md`. This file documents only what the
automation does *here*.

## Scanner

[`scripts/drift_scan.py`](../../scripts/drift_scan.py) emits one normalized JSON document
(schema: `timesheet-app/docs/automations/remediation-queue.schema.json`):

```bash
python3 scripts/drift_scan.py --out drift-infra.json
python3 scripts/drift_scan.py --terraform-dir terraform   # default
```

Per Terraform root under `terraform/` (`bootstrap`, `infrastructure`, `serverless`) it
collects:

- every `required_providers` entry: declared constraint, the pin in
  `.terraform.lock.hcl` when present, and the newest non-prerelease release from the
  Terraform Registry
- registry modules (`namespace/name/provider` sources): declared constraint vs. newest
  release; local and git sources are skipped because the registry cannot rank them
- `required_version` against the newest Terraform release, reported only when the
  constraint excludes it

Two fields matter for planning and have no equivalent in the npm/Maven scanners:

- `constraint_allows_latest: false` — the declared constraint itself blocks the upgrade.
  Today `aws = "~> 5.0"` in all three roots pins the provider to 5.x while 6.x is current,
  so remediation means widening the constraint *and* reviewing a plan, not bumping a pin.
- `pinned_by_lockfile: false` — that root has no `.terraform.lock.hcl`, so the version in
  use is whatever the constraint resolved to at last init; `current` is inferred from the
  constraint and is a lower bound.

`hashicorp/aws` and Terraform itself are high blast radius (they touch live account state)
and are sized `L`.

The Terraform Registry publishes no machine-readable advisory feed, so provider and module
items carry no advisories. The document records that gap in `advisory_coverage` rather than
implying a clean bill of health.

## Guardrails here

- Read-only: never runs `terraform init`, `plan`, `apply` or `providers lock`; never reads
  or writes remote state; never edits a `.tf` file or a lock file.
- No AWS credentials are needed or used — every lookup is against the public registry.
- No `.tfvars` values, state contents, bucket names or ARNs are copied into the report;
  version metadata only.
- Every failed registry lookup is reported as a scan error, so an unreachable registry is
  never presented as "no drift".

## Human checkpoint

The automation stops at the published issue. A provider major bump here changes live
infrastructure, so a maintainer picks the row, and the upgrade goes through the normal plan
review — nothing in `terraform/` is changed by the automation.
