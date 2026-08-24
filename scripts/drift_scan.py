#!/usr/bin/env python3
"""Terraform drift scanner for timesheet-infra.

Walks every Terraform root under --terraform-dir and collects, per root:
  - required_providers: declared constraint, lock-file pin, newest registry release
  - registry modules: declared version constraint vs. newest registry release
  - required_version: declared Terraform CLI constraint vs. newest Terraform release

Emits one normalized JSON document on stdout (or to --out) that matches
timesheet-app/docs/automations/remediation-queue.schema.json, so the weekly drift
report and its remediation queue are reproducible instead of hand-assembled.
See docs/automations/weekly-drift-report.md.

Read-only: never runs `terraform init/plan/apply`, never touches state, never
rewrites a .tf or .terraform.lock.hcl. Lookup failures land in "errors" so a
degraded run is never mistaken for a clean one.

The Terraform Registry publishes no advisory feed, so provider/module items
carry no advisories; the document records that gap under "advisory_coverage".
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

REPO = "Cognition-Partner-Workshops/timesheet-infra"
REGISTRY = "https://registry.terraform.io/v1"
TERRAFORM_RELEASES = "https://api.releases.hashicorp.com/v1/releases/terraform/latest"
ADVISORY_COVERAGE = (
    "none: the Terraform Registry publishes no machine-readable advisory feed, so "
    "provider and module items are version-drift only"
)

EXPOSURE_POINTS = {"provider": 12, "module": 8, "runtime_platform": 12}
# Providers/modules that touch live account state, so an upgrade needs a plan review.
HIGH_BLAST_RADIUS = {"hashicorp/aws", "terraform"}


def http_json(url, timeout=30):
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode())


def parse_version(value):
    parts = [int(p) for p in re.findall(r"\d+", value or "")[:3]]
    return parts + [0] * (3 - len(parts))


def version_gap(current, latest):
    cur, new = parse_version(current), parse_version(latest)
    return {
        "major": max(0, new[0] - cur[0]),
        "minor": max(0, new[1] - cur[1]) if new[0] == cur[0] else 0,
        "patch": max(0, new[2] - cur[2]) if new[:2] == cur[:2] else 0,
    }


def is_prerelease(version):
    return bool(re.search(r"(?i)(alpha|beta|rc|pre|dev)", version or ""))


def constraint_allows(constraint, version):
    """Whether `version` satisfies every comparator in a Terraform version constraint."""
    target = parse_version(version)
    for raw in (constraint or "").split(","):
        piece = raw.strip()
        match = re.fullmatch(r"(>=|<=|~>|!=|>|<|=)?\s*v?([\d.]+)", piece)
        if not match:
            continue
        operator, bound_text = match.group(1) or "=", match.group(2)
        bound = parse_version(bound_text)
        digits = len(bound_text.strip(".").split("."))
        if operator == "~>":
            # ~> 5.0 pins the major; ~> 5.1.2 pins major.minor.
            keep = 1 if digits >= 3 else 0
            if target[:keep + 1] != bound[:keep + 1] or target < bound:
                return False
        elif operator == ">=" and target < bound:
            return False
        elif operator == "<=" and target > bound:
            return False
        elif operator == ">" and target <= bound:
            return False
        elif operator == "<" and target >= bound:
            return False
        elif operator == "!=" and target == bound:
            return False
        elif operator == "=" and target != bound:
            return False
    return True


def rank_score(item):
    gap = item["gap"]
    staleness = min(24, 8 * gap["major"]) + min(8, gap["minor"]) + (2 if gap["patch"] else 0)
    blocked = 6 if not item["constraint_allows_latest"] else 0
    return staleness + blocked + EXPOSURE_POINTS.get(item["exposure"], 5)


def size_estimate(item):
    gap = item["gap"]
    if gap["major"] >= 1:
        return "L" if item["component"] in HIGH_BLAST_RADIUS else "M"
    if gap["minor"] >= 1:
        return "M" if item["component"] in HIGH_BLAST_RADIUS else "S"
    return "XS"


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(?m)(#|//).*$", "", text)


def matching_brace(text, start):
    """Index just past the `}` closing the block whose `{` is at `start`."""
    depth = 0
    for index in range(start, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return index
    return len(text)


def terraform_roots(base):
    """Directories holding .tf files, deepest-independent: each is its own scan unit."""
    roots = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in {".git", ".terraform"}]
        if any(name.endswith(".tf") for name in filenames):
            roots.append(dirpath)
    return sorted(roots)


def locked_providers(root, errors):
    """provider source -> version, from .terraform.lock.hcl."""
    path = os.path.join(root, ".terraform.lock.hcl")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path) as handle:
            body = handle.read()
    except OSError as exc:
        errors.append(f"{path}: {exc}")
        return {}
    locked = {}
    for match in re.finditer(
        r'provider\s+"registry\.terraform\.io/([^"]+)"\s*\{(.*?)\n\}', body, flags=re.S
    ):
        version = re.search(r'version\s*=\s*"([^"]+)"', match.group(2))
        if version:
            locked[match.group(1)] = version.group(1)
    return locked


def declared_providers(text):
    """provider source -> constraint, from every required_providers block in one root."""
    found = {}
    for block in re.finditer(r"required_providers\s*\{", text):
        start = block.end() - 1
        body = text[start:matching_brace(text, start)]
        for entry in re.finditer(r"(\w+)\s*=\s*\{(.*?)\}", body, flags=re.S):
            source = re.search(r'source\s*=\s*"([^"]+)"', entry.group(2))
            version = re.search(r'version\s*=\s*"([^"]+)"', entry.group(2))
            name = source.group(1) if source else f"hashicorp/{entry.group(1)}"
            found[name] = version.group(1) if version else ""
    return found


def declared_modules(text):
    """registry module source -> constraint, skipping local/git sources the registry can't rank."""
    found = {}
    for block in re.finditer(r'module\s+"[^"]+"\s*\{', text):
        start = block.end() - 1
        body = text[start:matching_brace(text, start)]
        source = re.search(r'source\s*=\s*"([^"]+)"', body)
        if not source or not re.fullmatch(r"[\w.-]+/[\w.-]+/[\w.-]+", source.group(1)):
            continue
        version = re.search(r'version\s*=\s*"([^"]+)"', body)
        found[source.group(1)] = version.group(1) if version else ""
    return found


def required_terraform(text):
    match = re.search(r'required_version\s*=\s*"([^"]+)"', text)
    return match.group(1) if match else ""


def newest(versions):
    usable = [v for v in versions if v and not is_prerelease(v)]
    return max(usable, key=parse_version) if usable else None


def latest_provider_version(source, errors, cache):
    if source in cache:
        return cache[source]
    try:
        body = http_json(f"{REGISTRY}/providers/{source}")
        latest = newest(body.get("versions") or [body.get("version") or ""])
    except (urllib.error.URLError, ValueError, KeyError, OSError) as exc:
        errors.append(f"terraform registry lookup failed for provider {source}: {exc}")
        latest = None
    cache[source] = latest
    return latest


def latest_module_version(source, errors, cache):
    if source in cache:
        return cache[source]
    try:
        body = http_json(f"{REGISTRY}/modules/{source}")
        latest = newest([body.get("version") or ""] + (body.get("versions") or []))
    except (urllib.error.URLError, ValueError, KeyError, OSError) as exc:
        errors.append(f"terraform registry lookup failed for module {source}: {exc}")
        latest = None
    cache[source] = latest
    return latest


def latest_terraform_version(errors):
    try:
        return http_json(TERRAFORM_RELEASES).get("version")
    except (urllib.error.URLError, ValueError, OSError) as exc:
        errors.append(f"terraform release lookup failed: {exc}")
        return None


def build_item(component, kind, location, current, constraint, latest, exposure):
    return {
        "component": component,
        "ecosystem": "terraform",
        "kind": kind,
        "location": location,
        "current": current,
        "constraint": constraint,
        "latest": latest,
        "exposure": exposure,
        "gap": version_gap(current, latest),
        "constraint_allows_latest": constraint_allows(constraint, latest),
        "advisories": [],
    }


def scan_root(root, base, errors, caches, terraform_latest):
    relative = os.path.relpath(root, base)
    text = ""
    for name in sorted(os.listdir(root)):
        if not name.endswith(".tf"):
            continue
        try:
            with open(os.path.join(root, name)) as handle:
                text += strip_comments(handle.read()) + "\n"
        except OSError as exc:
            errors.append(f"{os.path.join(relative, name)}: {exc}")
    if not text.strip():
        return []

    locked = locked_providers(root, errors)
    items = []
    for source, constraint in sorted(declared_providers(text).items()):
        latest = latest_provider_version(source, errors, caches["provider"])
        if not latest:
            continue
        current = locked.get(source) or re.sub(r"[^\d.]", "", constraint.split(",")[0]) or latest
        item = build_item(source, "provider", relative, current, constraint, latest, "provider")
        item["pinned_by_lockfile"] = source in locked
        items.append(item)

    for source, constraint in sorted(declared_modules(text).items()):
        latest = latest_module_version(source, errors, caches["module"])
        if not latest:
            continue
        current = re.sub(r"[^\d.]", "", constraint.split(",")[0]) or latest
        items.append(build_item(source, "module", relative, current, constraint, latest, "module"))

    constraint = required_terraform(text)
    if constraint and terraform_latest and not constraint_allows(constraint, terraform_latest):
        current = re.sub(r"[^\d.]", "", constraint.split(",")[0]) or terraform_latest
        items.append(build_item(
            "terraform", "runtime", relative, current, constraint, terraform_latest,
            "runtime_platform",
        ))
    return items


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", help="write JSON here instead of stdout")
    parser.add_argument("--root", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
    parser.add_argument("--terraform-dir", default="terraform",
                        help="directory (relative to --root) holding the Terraform roots")
    args = parser.parse_args()

    root = os.path.abspath(args.root)
    base = os.path.join(root, args.terraform_dir)
    errors = []
    if not os.path.isdir(base):
        errors.append(f"{args.terraform_dir} not found under {root}")
        roots = []
    else:
        roots = terraform_roots(base)
        if not roots:
            errors.append(f"no .tf files found under {args.terraform_dir}")

    caches = {"provider": {}, "module": {}}
    terraform_latest = latest_terraform_version(errors) if roots else None
    items = []
    for candidate in roots:
        items.extend(scan_root(candidate, root, errors, caches, terraform_latest))

    items = [i for i in items if i["gap"] != {"major": 0, "minor": 0, "patch": 0}]
    for item in items:
        item["rank_score"] = rank_score(item)
        item["size"] = size_estimate(item)
        item["advisory_count"] = 0
    items.sort(key=lambda i: (-i["rank_score"], i["location"], i["component"]))

    document = {
        "repo": REPO,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "scanner": "scripts/drift_scan.py",
        "advisory_coverage": ADVISORY_COVERAGE,
        "terraform_roots": [os.path.relpath(r, root) for r in roots],
        "items": items,
        "errors": errors,
    }
    payload = json.dumps(document, indent=2)
    if args.out:
        with open(args.out, "w") as handle:
            handle.write(payload + "\n")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
