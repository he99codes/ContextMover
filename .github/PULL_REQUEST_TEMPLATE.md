## What does this PR do?

<!-- Short description of the change -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Pipeline improvement (summarizer / translator / fetch interceptor)
- [ ] Test addition / fix
- [ ] CI / tooling

## Checklist

- [ ] `pnpm --filter browser-extension test` passes locally (114+ tests green)
- [ ] `pnpm --filter browser-extension typecheck` passes
- [ ] Extension builds (`pnpm --filter browser-extension build`)
- [ ] If parsers changed → mirrors in `pipelines.test.ts` updated
- [ ] If new platform added → platform block added to translator tests

## Testing notes

<!-- How was this tested? Any edge cases to watch? -->
