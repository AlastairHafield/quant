import random


class Humanizer:
    def __init__(self, jitter=0.15, rng=None):
        self.jitter = jitter
        self.rng = rng or random.Random()

    def t(self, seconds):
        """Seconds with gaussian jitter, never below 40% of nominal."""
        if seconds <= 0:
            return 0.0
        return max(seconds * 0.4, self.rng.gauss(seconds, seconds * self.jitter))

    def uniform(self, lo, hi):
        return self.rng.uniform(lo, hi)
