"""Windows-only screen capture, input and focus. Imported lazily so tests run anywhere."""
import time

import numpy as np


class Screen:
    def __init__(self, monitor=1):
        import mss
        self._sct = mss.mss()
        self.monitor = self._sct.monitors[monitor]

    @property
    def size(self):
        return self.monitor["width"], self.monitor["height"]

    def grab(self):
        # BGRA -> BGR
        return np.asarray(self._sct.grab(self.monitor))[:, :, :3]


class Input:
    """DirectInput-style SendInput events; plain pyautogui events are ignored by most DX games."""

    def __init__(self):
        import pydirectinput
        pydirectinput.FAILSAFE = False
        pydirectinput.PAUSE = 0
        self._di = pydirectinput
        self._held = set()

    def key_down(self, key):
        self._di.keyDown(key)
        self._held.add(("k", key))

    def key_up(self, key):
        self._di.keyUp(key)
        self._held.discard(("k", key))

    def mouse_down(self, button="left"):
        self._di.mouseDown(button=button)
        self._held.add(("m", button))

    def mouse_up(self, button="left"):
        self._di.mouseUp(button=button)
        self._held.discard(("m", button))

    def turn(self, dx):
        """Relative mouse move = camera turn."""
        # Split into chunks; some engines clamp big single deltas.
        step = 60 if dx > 0 else -60
        remaining = int(dx)
        while abs(remaining) > 0:
            d = step if abs(remaining) > abs(step) else remaining
            self._di.moveRel(d, 0, relative=True)
            remaining -= d
            time.sleep(0.005)

    def release_all(self):
        for kind, name in list(self._held):
            (self.key_up if kind == "k" else self.mouse_up)(name)


def window_focused(title_substr):
    try:
        import pygetwindow
        w = pygetwindow.getActiveWindow()
        return bool(w and title_substr.lower() in (w.title or "").lower())
    except Exception:
        return True  # can't tell; don't block
