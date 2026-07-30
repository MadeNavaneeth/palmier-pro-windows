## Summary

Describe the change and why it is needed.

## Validation

- [ ] `npm run upstream:audit:check`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `cd native && cargo check`
- [ ] `cd native && cargo test`

## Release Readiness

- [ ] This change is experimental only
- [ ] This change is UI connected
- [ ] This change is integration tested
- [ ] This change is release-ready

## Upstream Review

- Baseline commit:
- Issues/PRs reviewed, or `No upstream analogue`:
- Disposition: Implemented / Partial / Planned / Different by design / N/A platform
- Windows mapping:
- Remaining parity gaps:

- [ ] `docs/UPSTREAM_PARITY.md` was updated when the disposition changed
- [ ] Relevant upstream regression tests or invariants were translated

## Security Checklist

- [ ] IPC payloads are validated where relevant
- [ ] File paths are validated where relevant
- [ ] External process arguments are not string-concatenated unsafely
- [ ] API keys or credentials are not logged
- [ ] Native bindings keep a narrow typed boundary

## Notes

Add screenshots, logs, or follow-up issues as needed.
