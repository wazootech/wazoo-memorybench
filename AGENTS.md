# Agent guidelines

## What this repo is

This repository contains Worlds client memory benchmarking and smoke workflows.

**Origin:** Forked from [supermemory/memorybench](https://github.com/supermemoryai/memorybench).
This is a **complete, permanent fork** — not intended for upstream contribution.
We diverged from the original to own the benchmarking methodology, provider
integrations, and evaluation pipeline for Wazoo Worlds. There is no obligation
to maintain compatibility with the upstream repository.

### What this means for agents

- **No upstream sync.** Do not pull from or merge with `supermemory/memorybench`.
  There is no `upstream` remote.
- **Free to diverge.** Rename files, restructure modules, change APIs, swap
  dependencies — no need to keep diffs upstream-compatible.
- **Own the methodology.** Benchmark changes are methodology decisions. Document
  inputs, assumptions, and comparability. Do not present numbers as comparable
  with upstream unless the methodology and environment match.
- **Credit the origin.** The upstream project deserves attribution. Keep the
  original LICENSE and note the fork origin in release notes when shipping
  major divergences.

## How to work here

- Treat benchmark changes as methodology changes; document inputs, assumptions,
  and comparability.
- Use `package.json` scripts for tests, smoke checks, and formatting.
- Do not present benchmark numbers as comparable unless the methodology and
  environment match.
- Before finishing, summarize which checks ran and whether results are
  local-only.
