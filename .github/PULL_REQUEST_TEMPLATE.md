## Summary

- What does this PR change and why?

## Verification

- [ ] `make lint` passes (`ruff` + TypeScript `tsc --noEmit`)
- [ ] `make test-local` passes against real PostgreSQL & S3 containers
- [ ] Synthetic browser fixtures (`npm --prefix worker run test:audio` / `test:meet`), if touching `worker/`
- [ ] Live provider verification (`make test-live PROVIDER=...`) — *state explicitly if untested due to missing provider credentials*
