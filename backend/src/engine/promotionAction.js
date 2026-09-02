// Turns a promotionGate.js decision into the exact action that would flip a
// strategy from practice-account shadow trading to the real Combine — the
// "automated script reading the shadow ledger, not a hand-edited config
// value" the plan calls for. Deliberately only DESCRIBES the action (the
// Heroku config var + value + the exact CLI command) rather than executing
// it: flipping a live bot's EXECUTION_ENABLED is a real-money action, and
// this repo has no CI gate yet to make merging/deploying it a checked,
// reviewable step (Phase 4's GitHub Actions piece was explicitly deferred —
// no GitHub remote exists for this repo yet). Once that exists, this is the
// function a deploy step would call to decide whether to actually run the
// command it produces; until then, a human runs it by hand.

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
    note: 'Generated, not executed — a human runs this command (or an explicitly authorized deploy step, once CI exists) to actually flip the strategy live.',
  };
}
