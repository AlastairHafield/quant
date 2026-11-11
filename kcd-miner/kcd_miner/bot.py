import time


class Stop(Exception):
    pass


class RealClock:
    def now(self):
        return time.monotonic()

    def sleep(self, s):
        time.sleep(s)


class MinerBot:
    """
    States:
      SEARCH   - prompt visible? -> MINE. Node visible? -> APPROACH. Else turn camera a step;
                 after a full rotation with nothing found -> WAIT (respawn).
      APPROACH - turn to centre the node, walk forward in short bursts until the prompt shows.
      MINE     - run the mine action until the prompt disappears (node depleted) or max_cycles.
      WAIT     - sleep respawn_wait_s, then SEARCH.
    Without a 'node' template (or scan disabled) the bot is stationary: it only mines when the
    prompt is on screen and otherwise waits for respawn.
    """

    def __init__(self, cfg, matcher, screen, inp, controls, humanizer,
                 clock=None, focused=lambda: True, log=print):
        self.cfg = cfg
        self.m = matcher
        self.screen = screen
        self.inp = inp
        self.ctl = controls
        self.h = humanizer
        self.clock = clock or RealClock()
        self.focused = focused
        self.log = log
        self.state = "SEARCH"
        self.stats = {"nodes_mined": 0, "mine_cycles": 0, "scans": 0}
        self.stop_reason = None
        self._start = None
        self._next_break = None

    # ---- helpers -------------------------------------------------------------------------
    def wait(self, seconds):
        end = self.clock.now() + seconds
        while True:
            self._check_controls()
            left = end - self.clock.now()
            if left <= 0:
                return
            self.clock.sleep(min(0.1, left))

    def _check_controls(self):
        if self.ctl.quit.is_set():
            raise Stop("quit hotkey")
        if self.ctl.paused.is_set() or (self.cfg.require_focus and not self.focused()):
            self.inp.release_all()
            reason = "paused" if self.ctl.paused.is_set() else "game window not focused"
            self.log(f"[bot] holding: {reason}")
            while self.ctl.paused.is_set() or (self.cfg.require_focus and not self.focused()):
                if self.ctl.quit.is_set():
                    raise Stop("quit hotkey")
                self.clock.sleep(0.25)
            self.log("[bot] continuing")

    def look(self, name):
        if not self.m.has(name):
            return None
        return self.m.find(name, self.screen.grab())

    def visible(self, name):
        r = self.look(name)
        return bool(r and r.found)

    def _check_abort(self):
        frame = None
        for name in self.cfg.abort_on:
            if not self.m.has(name):
                continue
            frame = frame if frame is not None else self.screen.grab()
            if self.m.find(name, frame).found:
                raise Stop(f"abort template '{name}' visible")

    def _check_time(self):
        now = self.clock.now()
        if (now - self._start) / 60 >= self.cfg.max_runtime_min:
            raise Stop("max runtime reached")
        if self._next_break is not None and now >= self._next_break:
            lo, hi = self.cfg.breaks["duration_min"]
            dur = self.h.uniform(lo, hi) * 60
            self.log(f"[bot] break for {dur / 60:.1f} min")
            self.inp.release_all()
            self.wait(dur)
            self._schedule_break()

    def _schedule_break(self):
        b = self.cfg.breaks
        if not b or not b.get("every_min"):
            self._next_break = None
            return
        lo, hi = b["every_min"]
        self._next_break = self.clock.now() + self.h.uniform(lo, hi) * 60

    def _scan_enabled(self):
        return self.cfg.scan.get("enabled", True) and self.m.has("node")

    # ---- states --------------------------------------------------------------------------
    def do_search(self):
        if self.visible("prompt"):
            return "MINE"
        if not self._scan_enabled():
            return "WAIT"
        sc = self.cfg.scan
        for _ in range(int(sc["steps_per_rotation"])):
            r = self.look("node")
            if r and r.found:
                self.log(f"[bot] node seen score={r.score:.2f} at x={r.x}")
                return "APPROACH"
            if self.visible("prompt"):
                return "MINE"
            self.inp.turn(sc["step_px"] * self.h.t(1.0))
            self.stats["scans"] += 1
            self.wait(self.h.t(sc["settle_s"]))
        return "WAIT"

    def do_approach(self):
        ap = self.cfg.approach
        cx = self.screen.size[0] / 2
        fwd = self.cfg.keys.get("forward", "w")
        deadline = self.clock.now() + ap["timeout_s"]
        while self.clock.now() < deadline:
            self._check_controls()
            if self.visible("prompt"):
                return "MINE"
            r = self.look("node")
            if not r or not r.found:
                return "SEARCH"
            dx = r.x - cx
            if abs(dx) > ap["center_tolerance_px"]:
                self.inp.turn(dx * ap["turn_gain"])
                self.wait(self.h.t(0.15))
                continue
            self.inp.key_down(fwd)
            try:
                self.wait(self.h.t(ap["step_s"]))
            finally:
                self.inp.key_up(fwd)
            self.wait(self.h.t(0.1))
        self.log("[bot] approach timed out")
        return "SEARCH"

    def _mine_once(self):
        a = self.cfg.mine_action
        kind = a.get("type", "hold_key")
        if kind == "hold_key":
            self.inp.key_down(a["key"])
            try:
                self.wait(self.h.t(a["hold_s"]))
            finally:
                self.inp.key_up(a["key"])
        elif kind == "tap_key":
            self.inp.key_down(a["key"])
            try:
                self.wait(self.h.t(0.08))
            finally:
                self.inp.key_up(a["key"])
        elif kind in ("click", "hold_mouse"):
            btn = a.get("button", "left")
            self.inp.mouse_down(btn)
            try:
                self.wait(self.h.t(a.get("hold_s", 0.08) if kind == "hold_mouse" else 0.08))
            finally:
                self.inp.mouse_up(btn)
        else:
            raise ValueError(f"unknown mine_action type {kind!r}")
        self.wait(self.h.t(a.get("after_s", 0.6)))

    def do_mine(self):
        max_cycles = int(self.cfg.mine_action.get("max_cycles", 10))
        cycles = 0
        while cycles < max_cycles and self.visible("prompt"):
            self._mine_once()
            cycles += 1
            self.stats["mine_cycles"] += 1
            self._check_abort()
        if cycles:
            self.stats["nodes_mined"] += 1
            self.log(f"[bot] node done after {cycles} cycle(s); total {self.stats['nodes_mined']}")
        return "SEARCH"

    def do_wait(self):
        s = self.h.t(self.cfg.respawn_wait_s)
        self.log(f"[bot] nothing in view, waiting {s:.0f}s for respawn")
        self.wait(s)
        return "SEARCH"

    # ---- main loop -----------------------------------------------------------------------
    def step(self):
        self._check_controls()
        self._check_time()
        self._check_abort()
        handler = {
            "SEARCH": self.do_search, "APPROACH": self.do_approach,
            "MINE": self.do_mine, "WAIT": self.do_wait,
        }[self.state]
        new = handler()
        if new != self.state:
            self.log(f"[bot] {self.state} -> {new}")
        self.state = new

    def run(self, max_steps=None):
        self._start = self.clock.now()
        self._schedule_break()
        steps = 0
        try:
            while max_steps is None or steps < max_steps:
                self.step()
                steps += 1
        except Stop as e:
            self.stop_reason = str(e)
            self.log(f"[bot] stopped: {e}")
        finally:
            self.inp.release_all()
            self.log(f"[bot] stats: {self.stats}")
        return self.stats
