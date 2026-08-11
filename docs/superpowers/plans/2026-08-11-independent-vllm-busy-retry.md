# Independent vLLM Busy Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove Proxy-wide Base/Managed admission queues and retry only explicit upstream vLLM busy rejections per connection every 15 seconds.

**Architecture:** Main-model requests are submitted immediately and independently. vLLM owns scheduler waiting after acceptance. A request-local retry wrapper handles only pre-generation HTTP 429 or clearly transient 503 responses; streaming requests emit progress while waiting. Vision and WebFetch Processor retain their independent semaphores.

**Tech Stack:** Node.js 22, Anthropic Messages/SSE, vLLM HTTP API.

## Global Constraints

- No Proxy-wide managed/native-search/large-context/ingress queue.
- No limit on Base/Managed Claude Code connections in Proxy.
- Retry interval is fixed at 15000 ms in production.
- Retry only before any generation has been accepted; HTTP busy rejection only.
- 429 is busy; 503 requires Retry-After or explicit overload/capacity/busy signal.
- Client abort cancels wait immediately.
- Context Compact auxiliary backend behavior remains unchanged.

### Task 1: Request-local busy retry transport
- [ ] Add RED tests for 429 retry, transient 503 retry, permanent 503 no retry, and abort.
- [ ] Implement busy classification and abortable 15-second retry wrapper.
- [ ] Add progress callbacks for waiting/retry/accepted.

### Task 2: Remove shared Base/Managed admission
- [ ] Replace queue tests with independent-connections regression.
- [ ] Remove managed/native-search/large-context/ingress admission calls and queue errors.
- [ ] Keep only Vision and WebFetch Processor semaphores.
- [ ] Remove obsolete managed queue ENV/config and health fields.

### Task 3: Integrate progress and release
- [ ] Route direct and managed generation calls through busy retry callbacks.
- [ ] Add localized upstream-busy progress text.
- [ ] Update version/docs/changelog.
- [ ] Run full test, syntax, verify and package checks.
