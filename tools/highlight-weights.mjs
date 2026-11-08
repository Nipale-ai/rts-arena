// All tunable numbers for highlight scoring live here (and nowhere else).
// Tension is a unitless per-second score; scenes are the stretches where it stays high.

export const WEIGHTS = {
  // continuous inputs, per game second
  destroyed: 1.0,        // x sqrt(value destroyed in this second / 100): 100 value -> 1.0, 1000 -> 3.2
  fighting: 0.12,        // x sqrt(number of units fighting, both sides)
  lead_pressure: 0.0,    // reserved: bonus while the army-value gap is small (a close fight)
  // one-off events: weight, and decay time constant in seconds (spike starts at the event, decays exponentially)
  events: {
    first_contact:      { w: 3.2, tau: 3 },
    tier_up:            { w: 2.6, tau: 3 },
    key_building:       { w: 1.2, tau: 2 },
    expansion:          { w: 3.0, tau: 3 },
    building_destroyed: { w: 1.4, tau: 2.5 },
    base_destroyed:     { w: 6.0, tau: 6 },
    momentum_swing:     { w: 3.5, tau: 5 },
    battle:             { w: 0.0, tau: 1 },   // battles are scored through the destroyed / fighting series
    resign:             { w: 6.0, tau: 5 },
    victory:            { w: 8.0, tau: 6 },
  },
  // an LLM decision that lands: base weight when it carries a thought, plus a weight per order kind
  decision: { base: 0.9, tau: 2.5, orders: { advance_tier: 1.6, attack_move: 1.4, research: 0.5, build: 0.3, train: 0.1 }, per_error: 0.4, slow_latency_s: 6, slow_bonus: 0.8 },
  smooth: [0.25, 0.5, 0.25], // kernel applied once to the per-second tension
};

export const SCENE = {
  start_threshold: 2.4,   // tension needed to open a scene
  end_threshold: 1.1,     // the scene stays open while tension is above this
  hold_s: 3,              // ... and for this many seconds after it drops below
  pre_roll_s: 4,          // the scene starts this long before the first hot second
  post_roll_s: 3,         // and ends this long after the last one
  merge_gap_s: 8,         // scenes closer than this are one scene
  min_len_s: 6,           // shorter scenes are stretched (decisions need time to be read)
  max_len_s: 45,          // longer scenes are split at their calmest second
  score_peak: 1.0,        // scene score = peak * score_peak + integral * score_integral
  score_integral: 0.12,
  // which event kind names a scene, strongest first
  kind_priority: ['victory', 'resign', 'base_destroyed', 'battle', 'momentum_swing', 'building_destroyed', 'expansion', 'tier_up', 'first_contact', 'key_building', 'llm_decision'],
};
