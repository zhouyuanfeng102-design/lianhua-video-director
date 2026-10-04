# System Proxy Transport Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the user's system HTTP proxy carry model requests and deliver version 0.5.65 without replaying image jobs.

**Architecture:** Resolve the system proxy with Electron's session API. Keep the existing Node HTTP implementation, verified-IP destination, original Host/SNI and manual redirect policy; establish an HTTP CONNECT tunnel to the verified destination when a system HTTP/HTTPS proxy is selected. This avoids introducing a second unverified origin DNS lookup in Chromium or the proxy.

**Tech Stack:** Electron 41, Node HTTP/HTTPS/TLS, node:test, existing portable build and smoke tests.

**Spec:** User request in this task: directly fix the proven system-proxy bypass and generate a new package. User requested targeted code/browser verification only, not extended review loops.

## Global Constraints

- Do not read/decrypt user credentials or resubmit generation tasks.
- Preserve prior packages and project data, including the heavily dirty workspace.
- Target HTTP/HTTPS system proxies; unsupported proxy types must fail explicitly, not silently use direct egress.
- Preserve per-hop private-address validation, pinned destination, redirect credential stripping, byte limits and TLS certificate verification.
- No automatic POST retries. Keep the 600-second image-processing deadline; bound connection establishment separately.
- The verified read-only probe through the user's HTTP proxy and pinned destination returned HTTP 404 in about one second; direct access failed.

## Task 1: Reproduce and fix proxy transport

**Files:** Create `electron/systemProxyTransport.cjs`; test with `scripts/systemProxyTransport.test.mjs`; integrate `electron/main.cjs` and existing `scripts/electronReview.test.mjs`.

**Interfaces:** `resolveSystemProxy(url, { resolveProxy, signal, timeoutMs })` returns a proxy URL or null for DIRECT. `createProxyTunnelAgent(target, { proxyUrl, signal, connectTimeoutMs })` returns an isolated Node agent; its CONNECT authority is the already validated target IP and port, not a new DNS lookup.

- [x] Add failing tests that forward a dummy POST through a real loopback CONNECT proxy, verify target authority/Host/body and that Bearer headers are not sent in CONNECT.
- [x] Test DIRECT, unsupported modes, proxy refusal, abort and connection timeout; then implement the smallest helper that passes.
- [x] Integrate proxy lookup for each validated public hop, bypass proxy for explicitly allowed local model endpoints, dispose per-hop agents, and retain existing redirection/size handling.
- [x] Add a proxy private-redirect regression and run existing cross-origin credential-stripping regressions.

## Task 2: Targeted verification

**Files:** Existing Electron tests; temporary isolated native connectivity probe outside the repository.

- [x] Run proxy/Electron regressions (116 passed) and renderer adapter regressions (98 passed).
- [x] Actual packaged renderer -> IPC -> system proxy -> origin read-only probe returned HTTP 401 in 1639ms with no credentials.
- [x] One focused code check, type check and native package startup/save/recovery/viewport checks passed.

## Task 3: Deliver 0.5.65

**Files:** Package/lock metadata, update log, release notes and existing launchers/delivery documentation.

- [x] Update version metadata while preserving 0.5.64 and earlier records.
- [x] Run `npm run pack:win`; smoke-test the executable with isolated data/profile directories.
- [x] Deliver 0.5.65 and verify checksums, recovery source, tested-EXE identity, and all 21 pre-existing package/user-state hashes.

No commits, branch changes or extra review rounds are requested.
