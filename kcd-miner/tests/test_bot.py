import random
import threading

import numpy as np

from kcd_miner.bot import MinerBot
from kcd_miner.config import Config, TemplateSpec
from kcd_miner.humanize import Humanizer
from kcd_miner.vision import Match


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


class FakeWorld:
    """Simulates one ore node at a heading; prompt shows when close and facing it."""

    def __init__(self, node_heading=1000.0, distance=3, hits_to_deplete=3):
        self.heading = 0.0
        self.node_heading = node_heading
        self.distance = distance
        self.hits_left = hits_to_deplete
        self.held = set()
        self.events = []

    # screen
    size = (1920, 1080)

    def grab(self):
        return np.zeros((10, 10, 3), np.uint8)

    # input
    def turn(self, dx):
        self.heading += dx

    def key_down(self, k):
        self.held.add(k)
        self.events.append(("down", k))
        if k == "w" and self.facing():
            self.distance = max(0, self.distance - 1)

    def key_up(self, k):
        if k == "e" and "e" in self.held and self.prompt():
            self.hits_left -= 1
        self.held.discard(k)
        self.events.append(("up", k))

    mouse_down = key_down
    mouse_up = key_up

    def release_all(self):
        self.held.clear()

    # world state
    def offset(self):
        return self.node_heading - self.heading

    def facing(self):
        return abs(self.offset()) < 600

    def prompt(self):
        return self.hits_left > 0 and self.distance == 0 and abs(self.offset()) < 100

    def node_visible(self):
        return self.hits_left > 0 and self.facing()


class FakeMatcher:
    def __init__(self, world, names=("prompt", "node")):
        self.w = world
        self.names = set(names)

    def has(self, n):
        return n in self.names

    def find(self, name, frame):
        if name == "prompt":
            ok = self.w.prompt()
            return Match(name, 0.9 if ok else 0.1, 960, 700, 10, 10, ok)
        if name == "node":
            ok = self.w.node_visible()
            return Match(name, 0.8 if ok else 0.1, int(960 + self.w.offset()), 500, 10, 10, ok)
        if name == "inventory_full":
            return Match(name, 0.0, 0, 0, 0, 0, getattr(self.w, "full", False))
        raise KeyError(name)


class Controls:
    def __init__(self):
        self.paused = threading.Event()
        self.quit = threading.Event()


def make_bot(world, names=("prompt", "node"), **cfg_over):
    cfg = Config(templates={n: TemplateSpec(f"{n}.png") for n in names}, breaks={}, **cfg_over)
    logs = []
    bot = MinerBot(cfg, FakeMatcher(world, names), world, world, Controls(),
                   Humanizer(0.0, random.Random(1)), clock=FakeClock(), log=logs.append)
    return bot, logs


def test_scans_approaches_and_mines_node():
    w = FakeWorld(node_heading=1000, distance=3, hits_to_deplete=3)
    bot, logs = make_bot(w)
    bot.run(max_steps=8)
    assert w.hits_left == 0
    assert bot.stats["nodes_mined"] == 1
    assert bot.stats["mine_cycles"] == 3
    assert not w.held


def test_stationary_mode_waits_without_node_template():
    w = FakeWorld(node_heading=0, distance=0, hits_to_deplete=2)
    bot, _ = make_bot(w, names=("prompt",))
    bot.run(max_steps=3)
    assert bot.stats["nodes_mined"] == 1
    assert bot.state in ("WAIT", "SEARCH")
    assert bot.stats["scans"] == 0


def test_abort_template_stops_bot():
    w = FakeWorld(node_heading=0, distance=0, hits_to_deplete=50)
    w.full = False
    bot, _ = make_bot(w, names=("prompt", "node", "inventory_full"), abort_on=["inventory_full"])
    orig = w.key_up

    def key_up(k):
        orig(k)
        if bot.stats["mine_cycles"] >= 1:
            w.full = True
    w.key_up = key_up
    bot.run(max_steps=20)
    assert bot.stop_reason.startswith("abort template")
    assert not w.held


def test_quit_releases_keys():
    w = FakeWorld(node_heading=0, distance=0, hits_to_deplete=50)
    bot, _ = make_bot(w)
    orig = w.key_down

    def key_down(k):
        orig(k)
        bot.ctl.quit.set()
    w.key_down = key_down
    bot.run(max_steps=10)
    assert bot.stop_reason == "quit hotkey"
    assert not w.held


def test_max_runtime():
    w = FakeWorld(node_heading=99999, hits_to_deplete=0)
    bot, _ = make_bot(w, max_runtime_min=5, respawn_wait_s=60)
    bot.run(max_steps=1000)
    assert bot.stop_reason == "max runtime reached"
