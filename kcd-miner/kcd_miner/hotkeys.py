import threading


class Controls:
    """Shared pause/quit flags. Hotkey listener is optional (tests set flags directly)."""

    def __init__(self):
        self.paused = threading.Event()
        self.quit = threading.Event()
        self._listener = None

    def listen(self, pause_key="f8", quit_key="f9"):
        from pynput import keyboard

        def name(k):
            return getattr(k, "name", None) or getattr(k, "char", None)

        def on_press(k):
            n = name(k)
            if n == pause_key:
                if self.paused.is_set():
                    self.paused.clear()
                    print("[controls] resumed")
                else:
                    self.paused.set()
                    print("[controls] paused")
            elif n == quit_key:
                print("[controls] quit")
                self.quit.set()
                return False

        self._listener = keyboard.Listener(on_press=on_press)
        self._listener.daemon = True
        self._listener.start()
