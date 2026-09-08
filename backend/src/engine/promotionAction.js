// Turns a promotionGate.js decision into the exact action that would flip a
// strategy from practice-account shadow trading to the real Combine.
// describePromotionAction() only DESCRIBES the action (dry-run / display
// use — e.g. the agent-harness's audit-log entries still show the human-
// readable command). executePromotionAction() actually performs it via the
// Heroku Platform API, authenticated with HEROKU_PLATFORM_API_KEY — a
// credential that lives only in this backend's own Heroku config vars and
// is never exposed to the agent-harness's cloud sandbox. See
// agent-harness/PROTOCOL.md daily-loop step 8: the agent calls this
// (through the mcp__Quant__promotion_gate_execute tool) directly once
// promotion_gate_evaluate returns approved:true — there is no human step
// left in this path by design.

const EXECUTION_ENV_VAR = {
  'gap-continuation': 'GAP_CONTINUATION_EXECUTION_ENABLED',
  'mechanical-orb': 'MECHANICAL_ORB_EXECUTION_ENABLED',
  // gex-breakout has two independent gates — the bot-wide switch plus the
  // Order Flow Bot's own separate one (see gex-breakout/src/config.js) —
  // promoting "gex-breakout" specifically means the Order Flow Bot's own
  // flag, since that's the strategy this pipeline (practice-account shadow
  // trading, walk-forward re-validation) actually applies to.
  'gex-breakout': 'STRATEGY_OF_EXECUTION_ENABLED',
};

const HEROKU_APP = 'quantapp';

export function describePromotionAction(strategy, gateResult) {
  const envVar = EXECUTION_ENV_VAR[strategy];
  if (!envVar) {
    return { action: 'none', reason: `Unknown strategy "${strategy}" — no execution-flag mapping.` };
  }
  if (!gateResult?.approved) {
    return {
      action: 'none',
      reason: 'Promotion gate did not approve this candidate.',
      gateReasons: gateResult?.reasons ?? ['no gate result provided'],
    };
  }
  return {
    action: 'set_execution_enabled',
    strategy,
    envVar,
    value: 'true',
    command: `heroku config:set ${envVar}=true --app ${HEROKU_APP}`,
    note: 'Generated, not executed by this function — see executePromotionAction to actually flip the strategy live.',
  };
}

// Actually flips the strategy live by PATCHing the Heroku config var via the
// Platform API. Returns the same shape describePromotionAction does, plus
// `executed: true/false` and (on success) the Heroku API's response data.
// Throws only on a missing HEROKU_PLATFORM_API_KEY or a strategy/gate
// mismatch — an HTTP failure from Heroku itself is returned as
// `{ ...describeResult, executed: false, error }`, not thrown, so a caller
// logging an audit entry always has a real result to log even when Heroku
// rejects the request.
export async function executePromotionAction(strategy, gateResult) {
  const described = describePromotionAction(strategy, gateResult);
  if (described.action !== 'set_execution_enabled') {
    return { ...described, executed: false };
  }
  const apiKey = process.env.HEROKU_PLATFORM_API_KEY;
  if (!apiKey) {
    throw new Error('HEROKU_PLATFORM_API_KEY is not set — cannot execute a promotion action.');
  }
  const res = await fetch(`https://api.heroku.com/apps/${HEROKU_APP}/config-vars`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/vnd.heroku+json; version=3',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ [described.envVar]: described.value }),
  });
  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    return { ...described, executed: false, error: `Heroku API ${res.status}: ${errorBody}` };
  }
  const data = await res.json();
  return { ...described, executed: true, data };
}
