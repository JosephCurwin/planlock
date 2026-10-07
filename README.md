# Planlock

**Approve an AI agent's plan once. Then it can only make the calls that plan allows.**

AI agents that use tools (via MCP) usually work in one of two modes: they ask permission for every single call, and after the tenth prompt you click "yes" without reading; or they run unattended with full access. Planlock is a third option:

1. The agent writes a plan.
2. You approve it once.
3. Planlock sits between the agent and its tools and rejects every call that isn't in the plan.

```
agent  ──►  Planlock  ──►  your tools (any MCP server)
              ▲
         you approve the plan here (the agent can't)
```

The check is code, not a prompt: a confused or prompt-injected agent still can't go past the limits you approved. (Scope and limits: [threat model](#threat-model-and-limits).)

## Example

You approve this plan: **refund at most 30 € on order 4711 → email the customer → close the ticket.**

| The agent tries to… | Planlock |
|---|---|
| refund 30 € on order 4711 | ✅ forwarded, runs |
| refund 300 € | ❌ blocked: above the approved maximum |
| refund a different order | ❌ blocked: not the approved order |
| send the email before the refund is done | ❌ blocked: not this step |
| run any other script or edit one | ❌ blocked: not in the plan |
| refund after someone changed the refund script | ❌ blocked, plan paused: not the version you approved |

Blocked calls never reach your systems. The agent gets a plain error back and can only continue within the plan or stop.

## Try it

The refund example as a runnable demo. The tools live in [Windmill](https://www.windmill.dev) (open-source workflow engine), reached through Windmill's own, unmodified MCP server. Requires Docker and Node 20+.

```bash
npm ci
cp .env.example .env                                   # set APPROVER_TOKEN
docker compose --env-file .env -p wm -f examples/windmill/docker-compose.yml up -d
node examples/windmill/setup.mjs                       # workspace, 4 scripts, MCP token
docker compose --env-file .env -p wm -f examples/windmill/docker-compose.yml --profile guard up -d --build planlock
node examples/windmill/demo.mjs                        # 17 assertions
docker compose --env-file .env -p wm -f examples/windmill/docker-compose.yml --profile guard down -v   # clean up
```

What the demo prints (excerpt of a real run):

```text
[AGENT] step 1 — tries to overstep first:
   ✔ refund 300 EUR blocked → 403 Blocked by approved plan: s-f_support_refund__customer.amount exceeds the approved maximum
   ✔ approved refund executes in Windmill → {"amount":30,"status":"refunded","order_id":"4711","refund_id":"rf_1791310350551"}
   ✔ second refund blocked → 403 Blocked by approved plan: s-f_support_refund__customer already called 1 time(s); the approved plan allows 1 for this step
[COLLEAGUE] edits f/support/refund_customer in Windmill after the approval (refunds 10x the amount)
   ✔ refund blocked: script no longer matches the approved version → 409 Blocked by approved plan: getScriptByPath hash is "ca5f52798191da90", approved "89a679a5673b1fd0". The upstream changed since approval.
   ✔ plan goes on Hold instead of moving on to the email → state=hold
   ✔ agent cannot override the Hold itself → 403 Override requires a grant from the human approver (out-of-band approver channel). Explain the hold via agreement_phase_message and wait, or abort.
```

Results are checked against Windmill's job history. Windmill: default login `admin@windmill.dev` / `changeme`; guard on `127.0.0.1:3101` (MCP) and `127.0.0.1:4101` (approver).

## Under the hood

### What you approve

Not the plan's wording, but per-step limits. Step 1 of the example:

```json
"s-f_support_refund__customer": {
  "max_calls": 1,
  "args": { "order_id": { "eq": "4711" }, "amount": { "min": 1, "max": 30 } },
  "pin":  { "tool": "getScriptByPath", "args": { "path": "f/support/refund_customer" }, "field": "hash", "eq": "89a679a5673b1fd0" }
}
```

`pin`: right before the call, Planlock checks the refund script is still the version that was approved. If someone changed it, the call is blocked and the plan stops (Hold) — the confirmation email is never sent.

### What the agent gets back (real responses)

Step 1, the agent tries to refund 300 €:

```text
→ s-f_support_refund__customer  { "order_id": "4711", "amount": 300 }
← { "status_code": 403,
    "body": { "message": "Blocked by approved plan: s-f_support_refund__customer.amount exceeds the approved maximum" } }
```

Still in step 1, it tries to send the confirmation email early:

```text
→ s-f_support_send__email  { "to": "customer@example.com", "template": "refund_confirmed" }
← { "status_code": 409,
    "body": { "message": "Blocked: s-f_support_send__email is not allowed in the current step. Allowed now: s-f_support_get__order, s-f_support_refund__customer, listScripts, getScriptByPath." } }
```

It refunds 30 € as approved — this call reaches Windmill and runs:

```text
→ s-f_support_refund__customer  { "order_id": "4711", "amount": 30 }
← { "amount": 30, "status": "refunded", "order_id": "4711", "refund_id": "rf_1791310625048" }
```

(Responses shortened: `headers`, `resolution_hint` and `state_snapshot` left out. Tool names are how Windmill's MCP server names its scripts.)

### How it works

| | |
|---|---|
| **Approval** | Out of band, via a token-protected approver channel. The agent has no approve tool. |
| **Seal** | The approved plan is hashed; one approval = one execution of exactly that plan. |
| **Per step** | Allowed tools, argument limits (`eq` `enum` `min` `max` `max_length` `any`; undeclared args rejected), `max_calls`, optional version `pin`. Steps without `tools` are read-only. |
| **Pin** | Right before the call, the guard re-reads the upstream (e.g. the Windmill script hash) and blocks on mismatch. |
| **Hold** | A failed, pin-blocked or skipped step halts the plan. Only the human can override; the agent can only abort. |

## Security testing

`npm test` runs the security regression suite ([test/guard.test.mjs](test/guard.test.mjs), 6 test groups). Three rounds of automated LLM red-team agents attacked the guard and found four weaknesses, all fixed and covered by regression cases there: step limits skipped on routes with their own tool list; undeclared arguments passed through to the upstream; a pin could call a write tool; an override grant was not bound to one Hold. The final round found no bypass.

## Run with the bundled mock upstream

```bash
cp .env.example .env          # set APPROVER_TOKEN
docker compose up --build     # or: npm ci && npm run build && npm start
npm run smoke                 # end-to-end check against the running server
```

MCP endpoint: `http://127.0.0.1:3001/mcp` · approver channel: `http://127.0.0.1:4001` (loopback only).

## Approver CLI

```bash
node scripts/approve.mjs list                           # pending plans with the limits that will be enforced
node scripts/approve.mjs show <agreement_id>
node scripts/approve.mjs approve <agreement_id> <plan_hash>
node scripts/approve.mjs override "<justification>"     # only while a plan is on Hold
```
`APPROVER_TOKEN` is read from the environment or `.env`; `ADMIN_URL` selects the instance.
The plan's objective and descriptions are the agent's words; only the tool/argument lines are enforced.

## Connect another upstream

- stdio: `UPSTREAM_COMMAND` + `UPSTREAM_ARGS_JSON`
- Streamable HTTP: `UPSTREAM_URL`

Point `DOMAIN_PROFILE_PATH` at a profile that lists the upstream's read-only tools
(`investigation_read_only_tools`). See `profiles/`.

## Threat model and limits

- The agent only has the MCP connection. If it can run commands on the host (read the approver token, edit files), these guarantees do not hold.
- A `pin` is checked immediately before the call; a change landing in between those two requests is not caught.
- State is per server instance: one agent per instance. State is kept in memory (`DEV_MODE=true`).
- A call that failed upstream or was blocked by its pin uses up that step's call budget; retrying needs a new approval.
- The approval/agreement dialogue rules in the system prompt are guidance for the model; the server enforces the lifecycle, signals, plan integrity and limits.
- A human override resolves a Hold by moving on to the next step; the failed step is not retried. Check what happened (e.g. a timed-out call may still have run upstream) before granting one.
- A step with several bound tools passes once any one of them has succeeded.
- Read-only tools in the profile are callable without approval. Only list tools whose output may be seen by the agent (the Windmill profile exposes script source via `getScriptByPath`, but not job history).
- A `pin` may only use a tool listed as read-only in the profile; anything else fails the pin.

## Contact

Questions and ideas: GitHub issues. Bypasses: see [SECURITY.md](SECURITY.md) or email erwinfeld.oss@proton.me.
