// Null agent: a player that never asks a model and sends no orders. It is the floor anchor of the solo list
// ("what does a seat score when nobody plays"). It plugs into LiveMatch in place of an LlmPlayer (same duck type:
// takeCommands / recordResult / maybeRequest / hud / summary / stop), so the match code is not duplicated.
// The sim gives a player no standing orders of its own (sim/game.mjs, standing: []). So by default nothing is ever sent.
// `commands` is an optional list sent once at tick 0 (for example standing orders such as auto_train); it is empty unless the caller asks.

export class NullAgent {
  constructor({ name = 'Null agent', model = 'null-agent', hardware = 'none, sends no orders', commands = [] } = {}) {
    this.cfg = { name, model, hardware };
    this.commands = commands;
    this.sent = false;
    this.m = { applied: 0, rejected: 0 };
    this.by = {};
  }

  takeCommands() {
    if (this.sent) return [];
    this.sent = true;
    return this.commands.map((cmd) => ({ cmd, req: 1 }));
  }

  recordResult(cmd, res) {
    this.by[cmd.cmd] = (this.by[cmd.cmd] || 0) + 1;
    if (res.ok) this.m.applied++; else this.m.rejected++;
  }

  maybeRequest() {}

  hud() {
    return {
      latency: null, tokS: null, tokSource: null, thinks: 0, cmds: this.m.applied + this.m.rejected, invalid: this.m.rejected,
      invalidBy: { resources: 0, target: 0, args: 0, other: this.m.rejected, parse: 0 }, empty: 0, thought: '', lastCmd: '', lastCmdTick: 0,
    };
  }

  summary() {
    return {
      name: this.cfg.name, model: this.cfg.model, hardware: this.cfg.hardware, thinking: false, max_tokens: null, sampling: null, null_agent: true,
      requests: 0, replies: 0, rounds: 0, errors: 0, timeouts: 0, parse_errors: 0,
      latency_ms: { median: null, p90: null, max: null }, ttft_ms_median: null, prompt_tokens: 0, completion_tokens: 0,
      tok_s_avg: null, tok_s_method: null, tok_s_server_avg: null,
      empty_replies: 0, retries: 0, retry_ok: 0, retry_failed: 0,
      commands_applied: this.m.applied, commands_rejected: this.m.rejected, commands_invalid: this.m.rejected, by_cmd: { ...this.by },
    };
  }

  stop() {}
}
